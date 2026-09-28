import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Membership } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { isUuid } from '@common/context/acting-user';
import { assertBuildingContext, isPlatformContext } from '@common/context/assert-building-context';
import { personFieldsReadOnly, tenantRequired } from '@common/context/membership-context.errors';
import { CreateResidentDto, UpdateResidentDto } from './dto/resident.dto';
import { ResidentRemovalService } from './resident-removal.service';
import {
  BuildingStructureService,
  floorLookupKey,
  ResidentFloorView,
} from '../building-structure/building-structure.service';
import { MembershipLifecycleService } from '../people/membership-lifecycle.service';
import { MembershipRow, toMembershipRow } from '../people/people.views';
import { MembershipsService, UpdateMembershipInput } from '../memberships/memberships.service';

/**
 * One resident row: a person's RESIDENT membership in one building, with the
 * floor its unit sits on and the vehicles and personal cards the person holds
 * IN THAT BUILDING. id is the person; membershipId the row.
 */
export interface ResidentRow extends MembershipRow {
  /** Floor the unit sits on in the building's floor plan, or null when it matches no flat. */
  floor: ResidentFloorView | null;
  vehicles: Vehicle[];
  rfidCards: RfidCard[];
}

/** POST /residents: the new row plus whether the email already had an account (A4). */
export interface CreatedResidentRow extends MembershipRow {
  existingAccount: boolean;
}

export interface ResidentPage {
  data: ResidentRow[];
  total: number;
  page: number;
  limit: number;
}

export interface ResidentListQuery {
  search?: string;
  tenantId?: string;
  status?: string;
  page?: number;
  limit?: number;
}

const USER_STATUSES = Object.values(UserStatus) as string[];

/** A blank unit is no unit; the column and the floor lookup both treat it as absent. */
function normalizeUnit(unit: string | null | undefined): string | null {
  const trimmed = typeof unit === 'string' ? unit.trim() : '';
  return trimmed ? trimmed : null;
}

type PersonFieldChanges = Partial<Pick<User, 'firstName' | 'lastName' | 'phone'>>;

/**
 * The Residents page on top of RESIDENT memberships.
 *
 * A person may be a resident of several buildings (and hold other roles in
 * others), so every read and write is about ONE building: the one the request
 * acts in (assertBuildingContext), or for a platform admin the one named with
 * ?tenantId= (optional when the person is a resident of exactly one building,
 * 400 TENANT_REQUIRED when of several). Unit and active/inactive belong to the
 * membership; name and phone to the person, which a building admin cannot
 * change. Adding goes through MembershipLifecycleService.addPersonToTenant (the
 * seat rule, existing accounts, emails); removal through
 * ResidentRemovalService.removeFromBuilding, which keeps the person and their
 * other buildings.
 */
@Injectable()
export class ResidentsService {
  constructor(
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(RfidCard)
    private readonly rfidCardRepository: Repository<RfidCard>,
    private readonly dataSource: DataSource,
    private readonly membershipsService: MembershipsService,
    private readonly membershipLifecycle: MembershipLifecycleService,
    private readonly residentRemovalService: ResidentRemovalService,
    private readonly buildingStructureService: BuildingStructureService,
  ) {}

  /**
   * RESIDENT memberships, newest person first. Building admins and security
   * see the building they act in; a platform admin sees every building's, or
   * one building's with ?tenantId=. Memberships of removed people and deleted
   * buildings are never listed.
   */
  async findAll(currentUser: User, query: ResidentListQuery = {}): Promise<ResidentPage> {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    const tenantId = isPlatformContext(currentUser)
      ? (query.tenantId ?? null)
      : assertBuildingContext(currentUser, [UserRole.BUILDING_ADMIN, UserRole.SECURITY]);

    // A status that is not one would be a Postgres enum error; it matches nobody.
    if (query.status && !USER_STATUSES.includes(query.status)) {
      return { data: [], total: 0, page, limit };
    }

    // Inner joins: TypeORM adds "deleted_at IS NULL" for both. Only
    // many-to-one joins, so paging counts memberships, not joined rows.
    const qb = this.membershipRepository
      .createQueryBuilder('membership')
      .innerJoinAndSelect('membership.user', 'person')
      .innerJoinAndSelect('membership.tenant', 'tenant')
      .where('membership.role = :role', { role: UserRole.RESIDENT });

    if (tenantId) {
      qb.andWhere('membership.tenantId = :tenantId', { tenantId });
    }

    if (query.search) {
      qb.andWhere(
        '(LOWER(person.firstName) LIKE LOWER(:search) OR LOWER(person.lastName) LIKE LOWER(:search) OR LOWER(person.email) LIKE LOWER(:search))',
        { search: `%${query.search}%` },
      );
    }

    if (query.status) {
      qb.andWhere('membership.status = :status', { status: query.status });
    }

    const [memberships, total] = await qb
      .orderBy('person.createdAt', 'DESC')
      .addOrderBy('membership.id', 'ASC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return { data: await this.toResidentRows(memberships), total, page, limit };
  }

  async findOne(
    id: string,
    currentUser: User,
    options: { tenantId?: string | null } = {},
  ): Promise<ResidentRow> {
    const membership = await this.resolveResident(id, currentUser, options);
    const [row] = await this.toResidentRows([membership]);
    return row;
  }

  /**
   * Makes the person with this email a resident of the building: the one the
   * request acts in, or dto.tenantId for a platform admin (400
   * TENANT_REQUIRED without it). An email that already has an account (an
   * admin of another building, a resident who left) gets the membership and
   * the 'added to building' email, with no new password (existingAccount=true).
   * The seat rule requires a plan (403 without one, as before).
   */
  async create(createDto: CreateResidentDto, currentUser: User): Promise<CreatedResidentRow> {
    let tenantId: string;
    if (isPlatformContext(currentUser)) {
      if (!createDto.tenantId) {
        throw tenantRequired();
      }
      tenantId = createDto.tenantId;
    } else {
      // A building admin always adds to the building they act in; a tenantId in
      // the body is ignored, as it always was.
      tenantId = assertBuildingContext(currentUser, [UserRole.BUILDING_ADMIN]);
    }

    const result = await this.membershipLifecycle.addPersonToTenant({
      email: createDto.email,
      firstName: createDto.firstName,
      lastName: createDto.lastName,
      phone: createDto.phone,
      password: createDto.password,
      tenantId,
      role: UserRole.RESIDENT,
      unit: normalizeUnit(createDto.unit),
      status: createDto.isActive === false ? UserStatus.INACTIVE : UserStatus.ACTIVE,
      actor: currentUser,
      requirePlan: true,
    });

    return { ...toMembershipRow(result.membership), existingAccount: result.existingAccount };
  }

  /**
   * unit and isActive change the resident membership in the targeted building
   * only (a status change is copied onto gate_users.status while this is the
   * person's only building). Name and phone are the person's: a platform admin
   * may change them; a building admin gets 403 PERSON_FIELDS_READ_ONLY for a
   * changed value (an unchanged one, as a form echoes back, is fine).
   */
  async update(
    id: string,
    updateDto: UpdateResidentDto,
    currentUser: User,
    options: { tenantId?: string | null } = {},
  ): Promise<ResidentRow> {
    const platform = isPlatformContext(currentUser);
    const membership = await this.resolveResident(id, currentUser, options);
    const person = membership.user;

    // Residents are not moved between buildings: that is a removal here and an
    // add there. The row's own building echoed back is fine.
    if (updateDto.tenantId && updateDto.tenantId !== membership.tenantId) {
      throw new ForbiddenException('Cannot move resident to different tenant');
    }

    const personChanges: PersonFieldChanges = {};
    if (updateDto.firstName !== undefined && updateDto.firstName !== person.firstName) {
      personChanges.firstName = updateDto.firstName;
    }
    if (updateDto.lastName !== undefined && updateDto.lastName !== person.lastName) {
      personChanges.lastName = updateDto.lastName;
    }
    if (updateDto.phone !== undefined && (updateDto.phone ?? '') !== (person.phone ?? '')) {
      personChanges.phone = updateDto.phone;
    }
    if (!platform && Object.keys(personChanges).length > 0) {
      throw personFieldsReadOnly();
    }

    const changes: UpdateMembershipInput = {};
    if (updateDto.isActive !== undefined) {
      const status = updateDto.isActive ? UserStatus.ACTIVE : UserStatus.INACTIVE;
      if (status !== membership.status) {
        changes.status = status;
      }
    }
    if (updateDto.unit !== undefined) {
      const unit = normalizeUnit(updateDto.unit);
      if (unit !== (membership.unit ?? null)) {
        changes.unit = unit;
      }
    }

    if (Object.keys(changes).length > 0 || Object.keys(personChanges).length > 0) {
      await this.dataSource.transaction(async (m) => {
        if (Object.keys(changes).length > 0) {
          await this.membershipsService.update(membership.id, changes, m);
        }
        if (Object.keys(personChanges).length > 0) {
          await m.update(User, { id: person.id }, personChanges);
        }
      });
    }

    const updated = await this.findResidentMembership(person.id, membership.tenantId);
    if (!updated) {
      // Removed by someone else between the write and this read.
      throw new NotFoundException(`Resident with ID ${id} not found`);
    }
    const [row] = await this.toResidentRows([updated]);
    return row;
  }

  /**
   * Takes the resident out of the targeted building only: that membership
   * ends, and their cards, vehicles, open passes and notifications there are
   * released. Their account and their other buildings are untouched. See
   * ResidentRemovalService.
   */
  async remove(
    id: string,
    currentUser: User,
    options: { tenantId?: string | null } = {},
  ): Promise<void> {
    const membership = await this.resolveResident(id, currentUser, options);
    await this.residentRemovalService.removeFromBuilding(membership.userId, membership.tenantId, {
      expectedRole: UserRole.RESIDENT,
    });
  }

  // ============ Internals ============

  /**
   * The RESIDENT membership a /residents/:id request is about, with `user` and
   * `tenant` loaded:
   *   - building admin: in the building the request acts in, else 404;
   *   - platform admin: in ?tenantId= (404 if none), or the person's only
   *     resident membership (400 TENANT_REQUIRED when several, 404 when none).
   */
  private async resolveResident(
    personId: string,
    currentUser: User,
    options: { tenantId?: string | null },
  ): Promise<Membership> {
    const notFound = () => new NotFoundException(`Resident with ID ${personId} not found`);

    let tenantId: string | null | undefined;
    if (isPlatformContext(currentUser)) {
      tenantId = options.tenantId;
      if (!tenantId) {
        const residencies = (await this.membershipsService.listForPerson(personId)).filter(
          (membership) => membership.role === UserRole.RESIDENT,
        );
        if (residencies.length > 1) {
          throw tenantRequired();
        }
        tenantId = residencies[0]?.tenantId;
      }
    } else {
      tenantId = assertBuildingContext(currentUser, [UserRole.BUILDING_ADMIN]);
    }

    const membership = tenantId ? await this.findResidentMembership(personId, tenantId) : null;
    if (!membership) {
      throw notFound();
    }
    return membership;
  }

  /** The person's live RESIDENT membership in a live building, with `user` and `tenant` loaded. */
  private async findResidentMembership(
    personId: string,
    tenantId: string,
  ): Promise<Membership | null> {
    if (!isUuid(personId) || !isUuid(tenantId)) {
      return null;
    }

    return this.membershipRepository
      .createQueryBuilder('membership')
      .innerJoinAndSelect('membership.user', 'person')
      .innerJoinAndSelect('membership.tenant', 'tenant')
      .where('membership.userId = :personId', { personId })
      .andWhere('membership.tenantId = :tenantId', { tenantId })
      .andWhere('membership.role = :role', { role: UserRole.RESIDENT })
      .getOne();
  }

  /**
   * Adds the floor and the assets to each membership. Vehicles and personal
   * cards are matched on (person, THAT membership's building), so a resident of
   * two buildings shows each building only what they hold there. Three queries
   * for the whole page, whatever its size.
   */
  private async toResidentRows(memberships: Membership[]): Promise<ResidentRow[]> {
    if (memberships.length === 0) {
      return [];
    }

    const personIds = [...new Set(memberships.map((membership) => membership.userId))];
    const tenantIds = [...new Set(memberships.map((membership) => membership.tenantId))];

    const [vehicles, rfidCards, floors] = await Promise.all([
      this.vehicleRepository.find({
        where: { ownerId: In(personIds), tenantId: In(tenantIds) },
        order: { createdAt: 'ASC' },
      }),
      this.rfidCardRepository.find({
        where: { userId: In(personIds), tenantId: In(tenantIds) },
        order: { createdAt: 'ASC' },
      }),
      this.buildingStructureService.findFloorsForUnits(
        memberships.map((membership) => ({ tenantId: membership.tenantId, unit: membership.unit })),
      ),
    ]);

    return memberships.map((membership) => ({
      ...toMembershipRow(membership),
      floor: floors.get(floorLookupKey(membership.tenantId, membership.unit)) ?? null,
      vehicles: vehicles.filter(
        (vehicle) =>
          vehicle.ownerId === membership.userId && vehicle.tenantId === membership.tenantId,
      ),
      rfidCards: rfidCards.filter(
        (card) => card.userId === membership.userId && card.tenantId === membership.tenantId,
      ),
    }));
  }
}
