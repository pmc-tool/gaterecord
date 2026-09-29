import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { randomUUID } from 'crypto';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Membership, MembershipRole } from '@database/entities/membership.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Tenant, TenantStatus } from '@database/entities/tenant.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { isActingUser, isUuid } from '@common/context/acting-user';
import { assertBuildingContext, isPlatformContext } from '@common/context/assert-building-context';
import {
  accountSuspended,
  lastBuildingAdmin,
  personFieldsReadOnly,
  tenantRequired,
} from '@common/context/membership-context.errors';
import {
  CreateUserDto,
  UpdateUserDto,
  UserEmailLookupResponseDto,
  UserQueryDto,
} from './dto/user.dto';
import { AccountIdentityClient } from '../account-identity/account-identity.client';
import { EmailService } from '../notification/email.service';
import { ResidentRemovalService } from '../residents/resident-removal.service';
import { MembershipLifecycleService } from '../people/membership-lifecycle.service';
import {
  MembershipRow,
  PersonView,
  toMembershipRow,
  toPersonView,
  toPlatformPersonRow,
} from '../people/people.views';
import {
  MembershipsService,
  UpdateMembershipInput,
  activeMembershipIdOf,
} from '../memberships/memberships.service';

/**
 * The building roles each kind of admin may hand out on the Users page, when
 * adding someone or changing a row's role. Staff is never handed out (A6): it
 * exists only on legacy rows, which keep it. Super admin is not a building role
 * at all; a platform admin grants it with POST /users role=super_admin, which
 * sets it on the person and creates no membership.
 */
export const ADMIN_ASSIGNABLE_ROLES: Readonly<
  Record<UserRole.BUILDING_ADMIN | UserRole.SUPER_ADMIN, readonly MembershipRole[]>
> = {
  [UserRole.BUILDING_ADMIN]: [UserRole.SECURITY, UserRole.RESIDENT],
  [UserRole.SUPER_ADMIN]: [UserRole.BUILDING_ADMIN, UserRole.SECURITY, UserRole.RESIDENT],
};

/** 403 for a building admin changing or removing a building admin's row, their own included. */
const BUILDING_ADMIN_ROW_LOCKED =
  "A building admin's role in this building can only be changed by a platform admin.";

/** POST /users: the new row plus whether the email already had an account (A4). */
export interface CreatedUserRow extends MembershipRow {
  existingAccount: boolean;
}

/** GET /users/:id: the row plus what the person holds IN THAT BUILDING only. */
export interface UserDetail extends MembershipRow {
  vehicles: Vehicle[];
  rfidCards: RfidCard[];
}

/** The building on the caller's own profile, as the profile page names it. */
export interface ProfileTenantView {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  status: TenantStatus;
  isPaused: boolean;
}

/**
 * GET /users/profile: the person, plus what THIS request acts as. The building
 * fields come from the req.user overlay, never from a re-read of the legacy
 * gate_users columns, so they follow the chosen membership with the context on
 * and equal today's values with it off.
 */
export interface ProfileView extends PersonView {
  /** The personal QR token: one per person, valid wherever they are active (A3). */
  qrCode: string | null;
  /** The role held in the acting building; super_admin in the Platform context; null with no context. */
  role: UserRole | null;
  tenantId: string | null;
  tenant: ProfileTenantView | null;
  unit: string | null;
  /** The acting membership's status, or the person's own status without one. */
  status: UserStatus;
  /** The membership id, 'platform', or null (no context, legacy mode). */
  activeMembershipId: string | null;
  isSuperAdmin: boolean;
}

/** Who a /users/:id request is about, in which building. */
interface UserTarget {
  /** The live person, loaded fresh (never the acting principal). */
  person: User;
  /**
   * The person's membership in the targeted building, with `tenant` loaded.
   * Null only for a platform admin looking at a person with no building.
   */
  membership: Membership | null;
}

type PersonFieldChanges = Partial<Pick<User, 'firstName' | 'lastName' | 'phone'>>;

/** A blank unit is no unit; the column and the floor lookup both treat it as absent. */
function normalizeUnit(unit: string | null | undefined): string | null {
  const trimmed = typeof unit === 'string' ? unit.trim() : '';
  return trimmed ? trimmed : null;
}

function fullName(person: Pick<User, 'firstName' | 'lastName'>): string {
  return `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim();
}

/**
 * The Users page on top of memberships.
 *
 * A row is one person's role in one building (people.views.ts): id is the
 * person, membershipId the row, and role / status / unit / tenantId are that
 * building's. Every request acts in one building:
 *   - a building admin acts in the building of the membership the request acts
 *     as (assertBuildingContext), and only ever sees or changes rows there;
 *   - a platform admin (isPlatformContext) lists every building, or one with
 *     ?tenantId=, and names the building of a /users/:id request with
 *     ?tenantId= when the person belongs to several (400 TENANT_REQUIRED if not).
 *
 * The person (name, phone, email, password, QR code) is shared by all of their
 * buildings, so a building admin cannot change it here. Adding goes through
 * MembershipLifecycleService.addPersonToTenant (seats, existing accounts,
 * emails); removal through ResidentRemovalService.removeFromBuilding, which
 * ends one membership and keeps the person and their other buildings.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
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
    private readonly accountIdentityClient: AccountIdentityClient,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  // ================== Admin user management ==================

  /**
   * Gives the person with this email a role in a building:
   *   - building admin: the building they act in (a different dto.tenantId is
   *     403), and only the roles in ADMIN_ASSIGNABLE_ROLES.building_admin;
   *   - platform admin: dto.tenantId is required (400 TENANT_REQUIRED);
   *   - role super_admin: person-level, see createPlatformAdmin.
   *
   * An email that already has an account gets a membership and the 'added to
   * building' email, with no new password (existingAccount=true, A4). 409
   * MEMBERSHIP_EXISTS when they already have a role in that building.
   */
  /**
   * GET /users/lookup, for the Add User form. Uses the same match as the add
   * itself (MembershipLifecycleService.findPersonByEmail, removed people
   * included, since an add restores them), so "exists" here means exactly
   * "POST /users keeps this person's own name". An email known only to the
   * account service is not a person yet: the form's name is used for it.
   */
  async lookupByEmail(email: string): Promise<UserEmailLookupResponseDto> {
    const person = await this.membershipLifecycle.findPersonByEmail(email);
    if (!person) {
      return { exists: false };
    }
    return { exists: true, firstName: person.firstName, lastName: person.lastName };
  }

  async create(createUserDto: CreateUserDto, currentUser: User): Promise<CreatedUserRow> {
    if (createUserDto.role === UserRole.SUPER_ADMIN) {
      return this.createPlatformAdmin(createUserDto, currentUser);
    }

    const platform = isPlatformContext(currentUser);
    let tenantId: string;
    if (platform) {
      if (!createUserDto.tenantId) {
        throw tenantRequired();
      }
      tenantId = createUserDto.tenantId;
    } else {
      tenantId = assertBuildingContext(currentUser, [UserRole.BUILDING_ADMIN]);
      // The web may still stamp its building on the body; the same building is
      // fine, any other is refused rather than silently redirected.
      if (createUserDto.tenantId && createUserDto.tenantId !== tenantId) {
        throw new ForbiddenException('Cannot create user for another tenant');
      }
    }

    const assignable =
      ADMIN_ASSIGNABLE_ROLES[platform ? UserRole.SUPER_ADMIN : UserRole.BUILDING_ADMIN];
    if (!(assignable as readonly UserRole[]).includes(createUserDto.role)) {
      throw new ForbiddenException('Cannot create users with this role');
    }

    const result = await this.membershipLifecycle.addPersonToTenant({
      email: createUserDto.email,
      firstName: createUserDto.firstName,
      lastName: createUserDto.lastName,
      phone: createUserDto.phone,
      tenantId,
      role: createUserDto.role,
      unit: normalizeUnit(createUserDto.unit),
      status: createUserDto.status,
      actor: currentUser,
      // A building without a plan has no seat limit on this page, as before.
      requirePlan: false,
    });

    return { ...toMembershipRow(result.membership), existingAccount: result.existingAccount };
  }

  /**
   * One row per membership. A building admin sees the building they act in; a
   * platform admin sees one building (?tenantId=) or every building's rows plus
   * the platform admins themselves (listed once, without a building).
   * Memberships of soft-deleted people or buildings are never listed.
   */
  async findAll(query: UserQueryDto, currentUser: User): Promise<MembershipRow[]> {
    const platform = isPlatformContext(currentUser);
    const tenantId = platform
      ? (query.tenantId ?? null)
      : assertBuildingContext(currentUser, [UserRole.BUILDING_ADMIN]);
    const search = query.search ? `%${query.search.toLowerCase()}%` : null;

    // Inner joins: TypeORM adds "deleted_at IS NULL" for both, so a removed
    // person or a deleted building drops out.
    const qb = this.membershipRepository
      .createQueryBuilder('membership')
      .innerJoinAndSelect('membership.user', 'person')
      .innerJoinAndSelect('membership.tenant', 'tenant');

    if (tenantId) {
      qb.andWhere('membership.tenantId = :tenantId', { tenantId });
    }
    if (search) {
      qb.andWhere(
        '(LOWER(person.firstName) LIKE :search OR LOWER(person.lastName) LIKE :search OR LOWER(person.email) LIKE :search)',
        { search },
      );
    }
    if (query.role) {
      qb.andWhere('membership.role = :role', { role: query.role });
    }
    if (query.status) {
      qb.andWhere('membership.status = :status', { status: query.status });
    }

    // No membership ever carries super_admin, so that filter matches none.
    const memberships =
      query.role === UserRole.SUPER_ADMIN
        ? []
        : await qb
            .orderBy('person.createdAt', 'DESC')
            .addOrderBy('membership.createdAt', 'ASC')
            .addOrderBy('membership.id', 'ASC')
            .getMany();
    const rows = memberships.map((membership) => toMembershipRow(membership));

    if (!platform || tenantId || (query.role && query.role !== UserRole.SUPER_ADMIN)) {
      return rows;
    }

    // The platform listing also shows the platform admins, who hold that role
    // on the person rather than in a building.
    const admins = this.userRepository
      .createQueryBuilder('person')
      .where('person.role = :role', { role: UserRole.SUPER_ADMIN });
    if (search) {
      admins.andWhere(
        '(LOWER(person.firstName) LIKE :search OR LOWER(person.lastName) LIKE :search OR LOWER(person.email) LIKE :search)',
        { search },
      );
    }
    if (query.status) {
      admins.andWhere('person.status = :status', { status: query.status });
    }
    const platformRows = (await admins.getMany()).map(toPlatformPersonRow);

    return [...platformRows, ...rows].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        (a.membershipId ?? '').localeCompare(b.membershipId ?? ''),
    );
  }

  /**
   * One person's row in the targeted building, with their vehicles and
   * personal cards IN THAT BUILDING only: what they hold elsewhere is not this
   * building's admin's business.
   *
   * scope=platform (platform admin only) is the person's own row, without a
   * building, whatever memberships they hold: the platform row of the list.
   */
  async findOne(
    id: string,
    currentUser: User,
    options: { tenantId?: string | null; scope?: string | null } = {},
  ): Promise<UserDetail> {
    if (options.scope === 'platform') {
      const person = await this.loadPlatformTarget(id, currentUser);
      return { ...toPlatformPersonRow(person), vehicles: [], rfidCards: [] };
    }

    const { person, membership } = await this.resolveTarget(id, currentUser, options);
    if (!membership) {
      return { ...toPlatformPersonRow(person), vehicles: [], rfidCards: [] };
    }

    const [vehicles, rfidCards] = await Promise.all([
      this.vehicleRepository.find({
        where: { ownerId: person.id, tenantId: membership.tenantId },
        order: { createdAt: 'ASC' },
      }),
      this.rfidCardRepository.find({
        where: { userId: person.id, tenantId: membership.tenantId },
        order: { createdAt: 'ASC' },
      }),
    ]);

    return { ...toMembershipRow(membership, person), vehicles, rfidCards };
  }

  /**
   * Changes one row. role, status and unit change the membership in the
   * targeted building only (MembershipsService.update, which also copies a
   * status change onto gate_users.status while the person has just this one
   * building). Name and phone change the person and are for a platform admin
   * only: a building admin gets 403 PERSON_FIELDS_READ_ONLY for a changed value
   * (an unchanged one, as the web echoes back, is fine). Email and password are
   * not accepted at all (see UpdateUserDto).
   *
   * A building admin may not change a building admin's row (their own
   * included) or hand out a role outside ADMIN_ASSIGNABLE_ROLES.building_admin.
   * Demoting or deactivating a building's last active admin is 409
   * LAST_BUILDING_ADMIN.
   *
   * scope=platform (platform admin only) edits the person, never one of their
   * memberships: names, phone and status as the platform-wide ban. That is
   * the platform row of the list, for a platform admin who also holds
   * buildings (without it the request would land on their only membership, or
   * get 400 TENANT_REQUIRED with several).
   */
  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    currentUser: User,
    options: { tenantId?: string | null; scope?: string | null } = {},
  ): Promise<MembershipRow> {
    if (options.scope === 'platform') {
      const person = await this.loadPlatformTarget(id, currentUser);
      return this.updatePersonWithoutBuilding(
        person,
        updateUserDto,
        this.changedPersonFields(person, updateUserDto),
        currentUser,
      );
    }

    const platform = isPlatformContext(currentUser);
    const { person, membership } = await this.resolveTarget(id, currentUser, options);

    const personChanges = this.changedPersonFields(person, updateUserDto);
    if (!platform && Object.keys(personChanges).length > 0) {
      throw personFieldsReadOnly();
    }

    if (!membership) {
      // Platform admin, person with no building: only person-level changes.
      return this.updatePersonWithoutBuilding(person, updateUserDto, personChanges, currentUser);
    }

    // People are not moved between buildings: that is a removal here and an
    // add there. The web echoes the row's own building back, which is fine.
    if (updateUserDto.tenantId !== undefined && updateUserDto.tenantId !== membership.tenantId) {
      throw new ForbiddenException('Cannot move a user to another building');
    }

    const changes = this.membershipChanges(membership, updateUserDto);
    this.assertMayChangeMembership(membership, changes, person, currentUser, platform);

    await this.dataSource.transaction(async (m) => {
      if (Object.keys(changes).length > 0) {
        if (this.demotesActiveAdmin(membership, changes)) {
          await this.assertNotLastAdmin(m, membership);
        }
        await this.membershipsService.update(membership.id, changes, m);
      }
      if (Object.keys(personChanges).length > 0) {
        await m.update(User, { id: person.id }, personChanges);
      }
    });

    const updated = await this.findMembershipIn(person.id, membership.tenantId);
    if (!updated) {
      // Removed by someone else between the write and this read.
      throw new NotFoundException('User not found');
    }
    return toMembershipRow(updated);
  }

  /**
   * Takes the person out of the targeted building (every role goes through
   * ResidentRemovalService.removeFromBuilding): that building's membership ends
   * and what they held there is released; the person, their account and their
   * other buildings stay. 409 LAST_BUILDING_ADMIN instead of leaving a building
   * without an admin. As in update(), a building admin may not remove a
   * building admin's row (403).
   *
   * scope=platform (platform admin only) removes the person from the whole
   * platform instead. A platform admin without ?tenantId= removes the person's
   * only membership, or gets 400 TENANT_REQUIRED when there are several.
   */
  async remove(
    id: string,
    currentUser: User,
    options: { tenantId?: string | null; scope?: string | null } = {},
  ): Promise<void> {
    if (options.scope === 'platform') {
      await this.membershipLifecycle.removePersonFromPlatform(id, {
        actor: currentUser,
        scope: options.scope,
      });
      return;
    }

    if (id === currentUser.id) {
      throw new ForbiddenException('Cannot delete yourself');
    }

    const { person, membership } = await this.resolveTarget(id, currentUser, options);
    if (!membership) {
      throw new BadRequestException(
        'This person has no building to be removed from. Pass scope=platform to remove them from the platform.',
      );
    }
    // The update() rule: a building admin's row is a platform admin's to change,
    // and removing it is a change (PPL-8).
    if (!isPlatformContext(currentUser) && membership.role === UserRole.BUILDING_ADMIN) {
      throw new ForbiddenException(BUILDING_ADMIN_ROW_LOCKED);
    }

    await this.residentRemovalService.removeFromBuilding(person.id, membership.tenantId, {
      protectLastAdmin: true,
    });
  }

  // ================== Profile (self-service, person-level) ==================

  /**
   * Update the person's profile image URL. A column update, so the legacy
   * columns the membership mirror maintains are never written back from a
   * stale copy.
   */
  async updateProfileImage(userId: string, profileImageUrl: string): Promise<User> {
    const person = await this.userRepository.findOne({ where: { id: userId } });
    if (!person) {
      throw new NotFoundException('User not found');
    }

    await this.userRepository.update({ id: person.id }, { profileImageUrl });
    person.profileImageUrl = profileImageUrl;
    return person;
  }

  /**
   * The caller's own profile: the person (loaded fresh, without relations and
   * without the hash) plus what this request acts as, read from the req.user
   * overlay. With several buildings and no chosen one, role, tenantId and
   * tenant are null and the answer is still 200 (the route is
   * @ContextOptional).
   */
  async getProfile(currentUser: User): Promise<ProfileView> {
    const person = isUuid(currentUser?.id)
      ? await this.userRepository.findOne({ where: { id: currentUser.id } })
      : null;
    if (!person) {
      throw new NotFoundException('User not found');
    }

    return this.toProfileView(person, currentUser);
  }

  /**
   * Render the user's personal access QR code as a PNG data URL.
   *
   * Mirrors VisitorPassService.getQrCode: only the token itself is encoded, not
   * a URL, because gate scanners read the raw token. Users provisioned before
   * qr_code existed, or via a path that skipped it, are backfilled on demand so
   * this never returns an unusable empty code.
   */
  async getProfileQrCode(userId: string): Promise<{ qrCode: string; value: string }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.qrCode) {
      user.qrCode = `GR-${randomUUID()}`;
      await this.userRepository.update(user.id, { qrCode: user.qrCode });
    }

    return {
      qrCode: await QRCode.toDataURL(user.qrCode),
      value: user.qrCode,
    };
  }

  /**
   * Update the caller's own name and phone. Nothing else about the person, and
   * nothing about any building, is written.
   */
  async updateProfile(
    currentUser: User,
    updateData: { firstName?: string; lastName?: string; phone?: string },
  ): Promise<ProfileView> {
    const person = isUuid(currentUser?.id)
      ? await this.userRepository.findOne({ where: { id: currentUser.id } })
      : null;
    if (!person) {
      throw new NotFoundException('User not found');
    }

    const changes: PersonFieldChanges = {};
    if (updateData.firstName) changes.firstName = updateData.firstName;
    if (updateData.lastName) changes.lastName = updateData.lastName;
    if (updateData.phone !== undefined) changes.phone = updateData.phone;

    if (Object.keys(changes).length > 0) {
      await this.userRepository.update({ id: person.id }, changes);
      Object.assign(person, changes);
    }

    return this.toProfileView(person, currentUser);
  }

  // ================== Internals ==================

  /**
   * POST /users with role super_admin: a platform role on the PERSON (A1), so
   * no membership is created. Only a platform admin may grant it. A new email
   * gets an account (credentials email, as for any new person); an existing
   * person is granted the role on their row, keeping their buildings, which is
   * the grant writer contract C2 allows. The legacy mirror never touches a
   * super admin row, so nothing overwrites the grant.
   */
  private async createPlatformAdmin(
    dto: CreateUserDto,
    currentUser: User,
  ): Promise<CreatedUserRow> {
    if (!isPlatformContext(currentUser)) {
      throw new ForbiddenException('Cannot create users with this role');
    }

    const email = dto.email.trim().toLowerCase();
    const known = await this.membershipLifecycle.findPersonByEmail(email);

    if (known) {
      if (!known.deletedAt && known.role === UserRole.SUPER_ADMIN) {
        throw new ConflictException('This person is already a platform admin.');
      }
      if (known.status !== UserStatus.ACTIVE) {
        throw accountSuspended();
      }
      if (known.deletedAt) {
        // Restored as a new user with no building first, exactly as on sign-in.
        await this.membershipLifecycle.restoreDeletedPerson(known.id);
      }

      await this.userRepository.update(
        { id: known.id, role: Not(UserRole.SUPER_ADMIN) },
        { role: UserRole.SUPER_ADMIN },
      );
      this.logger.log(`Granted platform admin to existing person ${known.id}`);

      const granted = await this.userRepository.findOneOrFail({ where: { id: known.id } });
      return { ...toPlatformPersonRow(granted), existingAccount: true };
    }

    // Same order as every other add: the platform identity first, the local row
    // second (see MembershipLifecycleService.addPersonToTenant).
    const identity = await this.accountIdentityClient.provisionUser({
      email,
      first_name: dto.firstName,
      last_name: dto.lastName,
      phone: dto.phone,
      // Deliberately NOT the admin default password: a platform admin account
      // with a shared, known starting password is too valuable a target. The
      // account service generates a strong one, emailed below.
      sendEmail: false,
    });
    const passwordHash = await bcrypt.hash(randomUUID(), 10);

    const person = await this.dataSource.transaction(async (m) => {
      const created = await this.membershipLifecycle.insertPerson(m, {
        email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        userId: identity.id,
        passwordHash,
        mustChangePassword: Boolean(identity.created && identity.password),
      });
      await m.update(User, { id: created.id }, { role: UserRole.SUPER_ADMIN });
      return m.findOneOrFail(User, { where: { id: created.id } });
    });

    if (identity.created && identity.password) {
      const loginUrl = this.configService.get<string>(
        'GATE_LOGIN_URL',
        'https://yaad.global/login',
      );
      Promise.resolve(
        this.emailService.sendNewUserCredentialsEmail(
          person.email,
          fullName(person),
          UserRole.SUPER_ADMIN,
          identity.password,
          'Gate Management',
          fullName(currentUser),
          loginUrl,
        ),
      ).catch((err: unknown) =>
        this.logger.warn(
          `Platform admin ${person.email} created but the credentials email failed to send. ` +
            `Their starting password was NOT delivered. ${(err as Error)?.message ?? ''}`,
        ),
      );
    }

    return { ...toPlatformPersonRow(person), existingAccount: !identity.created };
  }

  /**
   * Which person and which of their memberships a /users/:id request is about:
   *   - building admin: the person's membership in the building the request
   *     acts in, else 404 (a person elsewhere is not confirmed to exist);
   *   - platform admin: the membership in ?tenantId= (404 if none), or the
   *     person's only one (400 TENANT_REQUIRED when there are several; null
   *     when there are none).
   */
  private async resolveTarget(
    personId: string,
    currentUser: User,
    options: { tenantId?: string | null },
  ): Promise<UserTarget> {
    if (isPlatformContext(currentUser)) {
      const person = await this.loadPerson(personId);

      if (options.tenantId) {
        const membership = await this.findMembershipIn(person.id, options.tenantId);
        if (!membership) {
          throw new NotFoundException('User not found');
        }
        return { person, membership };
      }

      const memberships = await this.membershipsService.listForPerson(person.id);
      if (memberships.length > 1) {
        throw tenantRequired();
      }
      return { person, membership: memberships[0] ?? null };
    }

    const tenantId = assertBuildingContext(currentUser, [UserRole.BUILDING_ADMIN]);
    const membership = await this.findMembershipIn(personId, tenantId);
    if (!membership) {
      throw new NotFoundException('User not found');
    }
    return { person: membership.user, membership };
  }

  /** The person a scope=platform request is about; 403 outside the Platform context. */
  private async loadPlatformTarget(personId: string, currentUser: User): Promise<User> {
    if (!isPlatformContext(currentUser)) {
      throw new ForbiddenException('Only a platform admin can act on a person platform-wide.');
    }
    return this.loadPerson(personId);
  }

  /** The live person, loaded fresh; 404 when there is none. */
  private async loadPerson(personId: string): Promise<User> {
    const person = isUuid(personId)
      ? await this.userRepository.findOne({ where: { id: personId } })
      : null;
    if (!person) {
      throw new NotFoundException('User not found');
    }
    return person;
  }

  /** The person's live membership in a live building, with `user` and `tenant` loaded. */
  private async findMembershipIn(personId: string, tenantId: string): Promise<Membership | null> {
    if (!isUuid(personId) || !isUuid(tenantId)) {
      return null;
    }

    return this.membershipRepository
      .createQueryBuilder('membership')
      .innerJoinAndSelect('membership.user', 'person')
      .innerJoinAndSelect('membership.tenant', 'tenant')
      .where('membership.userId = :personId', { personId })
      .andWhere('membership.tenantId = :tenantId', { tenantId })
      .getOne();
  }

  /** The person-level fields the request actually changes (equal values are not changes). */
  private changedPersonFields(person: User, dto: UpdateUserDto): PersonFieldChanges {
    const changes: PersonFieldChanges = {};
    if (dto.firstName !== undefined && dto.firstName !== person.firstName) {
      changes.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined && dto.lastName !== person.lastName) {
      changes.lastName = dto.lastName;
    }
    // An empty phone and no phone are the same value.
    if (dto.phone !== undefined && (dto.phone ?? '') !== (person.phone ?? '')) {
      changes.phone = dto.phone;
    }
    return changes;
  }

  /** The membership fields the request actually changes. */
  private membershipChanges(membership: Membership, dto: UpdateUserDto): UpdateMembershipInput {
    const changes: UpdateMembershipInput = {};
    if (dto.role !== undefined && dto.role !== membership.role) {
      changes.role = dto.role as MembershipRole;
    }
    if (dto.status !== undefined && dto.status !== membership.status) {
      changes.status = dto.status;
    }
    if (dto.unit !== undefined) {
      const unit = normalizeUnit(dto.unit);
      if (unit !== (membership.unit ?? null)) {
        changes.unit = unit;
      }
    }
    return changes;
  }

  private assertMayChangeMembership(
    membership: Membership,
    changes: UpdateMembershipInput,
    person: User,
    currentUser: User,
    platform: boolean,
  ): void {
    if (Object.keys(changes).length === 0) {
      return;
    }

    if (changes.role !== undefined) {
      if ((changes.role as UserRole) === UserRole.SUPER_ADMIN) {
        if (!platform) {
          throw new ForbiddenException('Cannot assign this role');
        }
        throw new BadRequestException(
          'Super admin is a platform role, not a role in a building. Grant it by adding the person with role super_admin.',
        );
      }
      const assignable =
        ADMIN_ASSIGNABLE_ROLES[platform ? UserRole.SUPER_ADMIN : UserRole.BUILDING_ADMIN];
      if (!assignable.includes(changes.role)) {
        throw new ForbiddenException('Cannot assign this role');
      }
    }

    if (platform) {
      return;
    }

    if (membership.role === UserRole.BUILDING_ADMIN) {
      throw new ForbiddenException(BUILDING_ADMIN_ROW_LOCKED);
    }
    if (changes.role !== undefined && person.id === currentUser.id) {
      throw new ForbiddenException('Cannot change your own role');
    }
  }

  /** Whether the changes take an ACTIVE building admin out of that position. */
  private demotesActiveAdmin(membership: Membership, changes: UpdateMembershipInput): boolean {
    if (membership.role !== UserRole.BUILDING_ADMIN || membership.status !== UserStatus.ACTIVE) {
      return false;
    }
    return (
      (changes.role !== undefined && changes.role !== UserRole.BUILDING_ADMIN) ||
      (changes.status !== undefined && changes.status !== UserStatus.ACTIVE)
    );
  }

  /**
   * 409 LAST_BUILDING_ADMIN when no other active admin would remain. Locks the
   * tenant first (the lock order every membership write uses), so two
   * concurrent demotions of the last two admins cannot both pass.
   */
  private async assertNotLastAdmin(m: EntityManager, membership: Membership): Promise<void> {
    await m.findOne(Tenant, {
      where: { id: membership.tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    const otherAdmins = await m.count(Membership, {
      where: {
        tenantId: membership.tenantId,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
        id: Not(membership.id),
      },
    });
    if (otherAdmins === 0) {
      throw lastBuildingAdmin();
    }
  }

  /**
   * A platform admin editing a person who holds no building (a platform admin
   * row, or someone who has not onboarded), or any person with scope=platform:
   * names and phone, and status, which here is the platform-wide ban (the
   * direct gate_users.status writer contract C2 allows). There is no building
   * role or unit to change.
   */
  private async updatePersonWithoutBuilding(
    person: User,
    dto: UpdateUserDto,
    personChanges: PersonFieldChanges,
    currentUser: User,
  ): Promise<MembershipRow> {
    const roleChanged = dto.role !== undefined && dto.role !== person.role;
    if (roleChanged || normalizeUnit(dto.unit) !== null || dto.tenantId !== undefined) {
      throw new BadRequestException(
        'This person has no building. Add them to one with POST /users to give them a role there.',
      );
    }

    const changes: PersonFieldChanges & { status?: UserStatus } = { ...personChanges };
    if (dto.status !== undefined && dto.status !== person.status) {
      // A platform-wide ban on oneself would lock the only person who can lift it out.
      if (person.id === currentUser.id) {
        throw new ForbiddenException('Cannot change your own status');
      }
      changes.status = dto.status;
    }

    if (Object.keys(changes).length > 0) {
      await this.userRepository.update({ id: person.id }, changes);
    }

    const updated = await this.userRepository.findOneOrFail({ where: { id: person.id } });
    return toPlatformPersonRow(updated);
  }

  private toProfileView(person: User, acting: User): ProfileView {
    const tenant = acting.tenant ?? null;
    const actingMembership = isActingUser(acting) ? acting.activeMembership : null;

    return {
      ...toPersonView(person),
      qrCode: person.qrCode ?? null,
      role: acting.role ?? null,
      tenantId: acting.tenantId ?? null,
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            address: tenant.address ?? null,
            status: tenant.status,
            isPaused: tenant.isPaused === true,
          }
        : null,
      unit: acting.unit ?? null,
      status: actingMembership?.status ?? person.status,
      activeMembershipId: activeMembershipIdOf(acting),
      isSuperAdmin: isActingUser(acting)
        ? acting.isSuperAdmin
        : person.role === UserRole.SUPER_ADMIN,
    };
  }
}
