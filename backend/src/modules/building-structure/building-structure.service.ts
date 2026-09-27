import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { BuildingFloor } from '@database/entities/building-floor.entity';
import { BuildingFlat } from '@database/entities/building-flat.entity';
import { User, UserRole } from '@database/entities/user.entity';
import {
  AddFlatsDto,
  CreateFloorDto,
  CreateFloorRangeDto,
  MAX_FLOORS_PER_RANGE,
  UpdateFlatDto,
  UpdateFloorDto,
} from './dto/building-structure.dto';

/** Sanity cap so one floor cannot be filled with thousands of rows. */
const MAX_FLATS_PER_FLOOR = 200;

/**
 * The comparison form of a flat number: trimmed, inner whitespace collapsed,
 * upper-cased. "4b", " 4B" and "4 b" vs "4 B" compare equal. Used both for the
 * uniqueness rule and for matching residents' free-text `unit` to a flat.
 */
export function normalizeFlatKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Tidy what the admin typed without changing its case. */
function cleanFlatNumber(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function floorLabel(floor: Pick<BuildingFloor, 'floorNumber' | 'name'>): string {
  if (floor.name) return floor.name;
  if (floor.floorNumber === 0) return 'Ground floor';
  if (floor.floorNumber < 0) return `Basement ${-floor.floorNumber}`;
  return `Floor ${floor.floorNumber}`;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Postgres unique_violation — two concurrent saves slipped past the pre-check. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505'
  );
}

export interface FlatView {
  id: string;
  floorId: string;
  flatNumber: string;
  /** Residents of this building whose `unit` matches this flat. */
  residentCount: number;
}

export interface FloorView {
  id: string;
  floorNumber: number;
  name: string | null;
  label: string;
  flats: FlatView[];
}

export interface ResidentFloorView {
  id: string;
  floorNumber: number;
  label: string;
}

/** Key into the map returned by BuildingStructureService.findFloorsForUnits. */
export function floorLookupKey(tenantId: string | null, unit: string | null | undefined): string {
  return `${tenantId ?? ''}|${unit ? normalizeFlatKey(unit) : ''}`;
}

export interface JoinFloorPlanView {
  floors: {
    id: string;
    floorNumber: number;
    label: string;
    flats: { id: string; flatNumber: string }[];
  }[];
}

export interface BuildingStructureView {
  floors: FloorView[];
  summary: {
    floorCount: number;
    flatCount: number;
    occupiedFlatCount: number;
    residentCount: number;
    /** Residents whose unit is empty or matches no configured flat. */
    unassignedResidentCount: number;
  };
}

/**
 * Floors and flats of the caller's OWN building.
 *
 * Every method takes the tenant from the authenticated user, never from the
 * request, so an admin cannot read or edit another building's structure. Rows
 * are always looked up by (id, tenantId) for the same reason.
 *
 * Deliberately does not write to `gate_users.unit`: residents keep their
 * free-text unit, and the structure only READS it to show occupancy. Renaming
 * or deleting a flat therefore never changes resident data.
 */
@Injectable()
export class BuildingStructureService {
  constructor(
    @InjectRepository(BuildingFloor)
    private readonly floorRepository: Repository<BuildingFloor>,
    @InjectRepository(BuildingFlat)
    private readonly flatRepository: Repository<BuildingFlat>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ==================== Read ====================

  /**
   * `forTenantId` is honoured for SUPER_ADMIN only — they manage residents of
   * every building and need its floor plan for the resident unit picker. Every
   * other role always reads its own building, whatever is passed. Read-only:
   * the write methods never take a tenant from the request.
   */
  async getStructure(user: User, forTenantId?: string): Promise<BuildingStructureView> {
    const tenantId =
      forTenantId && user.role === UserRole.SUPER_ADMIN ? forTenantId : this.requireTenant(user);

    const [floors, flats, residentUnits] = await Promise.all([
      this.floorRepository.find({ where: { tenantId }, order: { floorNumber: 'ASC' } }),
      this.flatRepository.find({ where: { tenantId } }),
      this.countResidentsByUnit(tenantId),
    ]);

    const knownKeys = new Set(flats.map((flat) => flat.flatKey));
    let residentCount = 0;
    let unassignedResidentCount = 0;
    for (const [key, count] of residentUnits) {
      residentCount += count;
      if (!key || !knownKeys.has(key)) unassignedResidentCount += count;
    }

    const flatsByFloor = new Map<string, FlatView[]>();
    let occupiedFlatCount = 0;
    for (const flat of flats) {
      const count = residentUnits.get(flat.flatKey) ?? 0;
      if (count > 0) occupiedFlatCount += 1;
      const list = flatsByFloor.get(flat.floorId) ?? [];
      list.push({
        id: flat.id,
        floorId: flat.floorId,
        flatNumber: flat.flatNumber,
        residentCount: count,
      });
      flatsByFloor.set(flat.floorId, list);
    }

    return {
      floors: floors.map((floor) => ({
        id: floor.id,
        floorNumber: floor.floorNumber,
        name: floor.name,
        label: floorLabel(floor),
        flats: (flatsByFloor.get(floor.id) ?? []).sort((a, b) =>
          naturalCompare(a.flatNumber, b.flatNumber),
        ),
      })),
      summary: {
        floorCount: floors.length,
        flatCount: flats.length,
        occupiedFlatCount,
        residentCount,
        unassignedResidentCount,
      },
    };
  }

  /**
   * Floor plan shown to someone asking to JOIN a building, so they can pick
   * their flat. Names only — no resident counts, which would tell an outsider
   * which flats are occupied.
   *
   * Same audience rule as ResidentRequestsService.searchBuildings: only callers
   * without a building of their own may read it.
   */
  async getJoinFloorPlan(user: User, tenantId: string): Promise<JoinFloorPlanView> {
    if (user.tenantId) {
      throw new ForbiddenException('You already belong to a building.');
    }

    const [floors, flats] = await Promise.all([
      this.floorRepository.find({ where: { tenantId }, order: { floorNumber: 'ASC' } }),
      this.flatRepository.find({ where: { tenantId } }),
    ]);

    return {
      floors: floors.map((floor) => ({
        id: floor.id,
        floorNumber: floor.floorNumber,
        label: floorLabel(floor),
        flats: flats
          .filter((flat) => flat.floorId === floor.id)
          .map((flat) => ({ id: flat.id, flatNumber: flat.flatNumber }))
          .sort((a, b) => naturalCompare(a.flatNumber, b.flatNumber)),
      })),
    };
  }

  /**
   * Which floor each resident's free-text unit sits on, for list views.
   * Keyed by `floorLookupKey(tenantId, unit)`; units that match no flat are
   * simply absent. One query regardless of how many residents are passed.
   */
  async findFloorsForUnits(
    residents: { tenantId: string | null; unit: string | null | undefined }[],
  ): Promise<Map<string, ResidentFloorView>> {
    const tenantIds = new Set<string>();
    const keys = new Set<string>();
    for (const { tenantId, unit } of residents) {
      if (!tenantId || !unit?.trim()) continue;
      tenantIds.add(tenantId);
      keys.add(normalizeFlatKey(unit));
    }

    const result = new Map<string, ResidentFloorView>();
    if (tenantIds.size === 0) return result;

    const flats = await this.flatRepository.find({
      where: { tenantId: In([...tenantIds]), flatKey: In([...keys]) },
      relations: ['floor'],
    });
    for (const flat of flats) {
      result.set(`${flat.tenantId}|${flat.flatKey}`, {
        id: flat.floor.id,
        floorNumber: flat.floor.floorNumber,
        label: floorLabel(flat.floor),
      });
    }
    return result;
  }

  // ==================== Floors ====================

  async createFloor(user: User, dto: CreateFloorDto): Promise<FloorView> {
    const tenantId = this.requireTenant(user);
    await this.assertFloorNumberFree(tenantId, dto.floorNumber);

    const floor = this.floorRepository.create({
      tenantId,
      floorNumber: dto.floorNumber,
      name: dto.name?.trim() || null,
    });

    const saved = await this.saveOrConflict(
      () => this.floorRepository.save(floor),
      `${floorLabel({ floorNumber: dto.floorNumber, name: null })} already exists`,
    );

    return { ...this.toFloorView(saved), flats: [] };
  }

  /**
   * Creates every floor from `fromFloor` to `toFloor` inclusive, skipping the
   * numbers that already exist, so "floors 1–10" can be re-run safely after a
   * few were added by hand.
   */
  async createFloorRange(
    user: User,
    dto: CreateFloorRangeDto,
  ): Promise<{ created: FloorView[]; skipped: number[] }> {
    const tenantId = this.requireTenant(user);
    const from = Math.min(dto.fromFloor, dto.toFloor);
    const to = Math.max(dto.fromFloor, dto.toFloor);

    if (to - from + 1 > MAX_FLOORS_PER_RANGE) {
      throw new BadRequestException(`Add at most ${MAX_FLOORS_PER_RANGE} floors at a time`);
    }

    const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const existing = await this.floorRepository.find({
      where: { tenantId, floorNumber: In(numbers) },
      select: ['id', 'floorNumber'],
    });
    const taken = new Set(existing.map((floor) => floor.floorNumber));
    const missing = numbers.filter((n) => !taken.has(n));

    const saved = missing.length
      ? await this.saveOrConflict(
          () =>
            this.dataSource.transaction((manager) =>
              manager.save(
                missing.map((floorNumber) =>
                  manager.create(BuildingFloor, { tenantId, floorNumber, name: null }),
                ),
              ),
            ),
          'Some of these floors were just added by someone else. Refresh and try again.',
        )
      : [];

    return {
      created: saved
        .sort((a, b) => a.floorNumber - b.floorNumber)
        .map((floor) => ({ ...this.toFloorView(floor), flats: [] })),
      skipped: numbers.filter((n) => taken.has(n)),
    };
  }

  async updateFloor(user: User, floorId: string, dto: UpdateFloorDto): Promise<FloorView> {
    const tenantId = this.requireTenant(user);
    const floor = await this.findFloor(tenantId, floorId);

    if (dto.floorNumber !== undefined && dto.floorNumber !== floor.floorNumber) {
      await this.assertFloorNumberFree(tenantId, dto.floorNumber);
      floor.floorNumber = dto.floorNumber;
    }
    if (dto.name !== undefined) {
      floor.name = dto.name?.trim() || null;
    }

    const saved = await this.saveOrConflict(
      () => this.floorRepository.save(floor),
      `${floorLabel({ floorNumber: floor.floorNumber, name: null })} already exists`,
    );

    return { ...this.toFloorView(saved), flats: [] };
  }

  /** Removes the floor and every flat on it. Resident units are untouched. */
  async deleteFloor(user: User, floorId: string): Promise<{ id: string; flatsRemoved: number }> {
    const tenantId = this.requireTenant(user);
    const floor = await this.findFloor(tenantId, floorId);

    // Flats are deleted explicitly rather than relying on the FK cascade, so the
    // result is the same on a schema that was built without it.
    const flatsRemoved = await this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(BuildingFlat, { tenantId, floorId: floor.id });
      await manager.delete(BuildingFloor, { id: floor.id, tenantId });
      return result.affected ?? 0;
    });

    return { id: floor.id, flatsRemoved };
  }

  // ==================== Flats ====================

  async addFlats(user: User, floorId: string, dto: AddFlatsDto): Promise<FlatView[]> {
    const tenantId = this.requireTenant(user);
    const floor = await this.findFloor(tenantId, floorId);

    const entries = dto.flatNumbers
      .map(cleanFlatNumber)
      .filter((value) => value.length > 0)
      .map((flatNumber) => ({ flatNumber, flatKey: normalizeFlatKey(flatNumber) }));

    if (entries.length === 0) {
      throw new BadRequestException('Enter at least one flat number');
    }

    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.flatKey)) repeated.add(entry.flatNumber);
      seen.add(entry.flatKey);
    }
    if (repeated.size > 0) {
      throw new BadRequestException(`Listed more than once: ${[...repeated].join(', ')}`);
    }

    const existing = await this.flatRepository.find({
      where: { tenantId, flatKey: In(entries.map((entry) => entry.flatKey)) },
      relations: ['floor'],
    });
    if (existing.length > 0) {
      const taken = existing
        .map(
          (flat) =>
            `${flat.flatNumber} (${floor.id === flat.floorId ? 'this floor' : floorLabel(flat.floor)})`,
        )
        .join(', ');
      throw new ConflictException(`Flat already exists in this building: ${taken}`);
    }

    const onFloor = await this.flatRepository.count({ where: { tenantId, floorId: floor.id } });
    if (onFloor + entries.length > MAX_FLATS_PER_FLOOR) {
      throw new BadRequestException(
        `A floor can hold at most ${MAX_FLATS_PER_FLOOR} flats (${floorLabel(floor)} has ${onFloor})`,
      );
    }

    const residentUnits = await this.countResidentsByUnit(tenantId);

    const saved = await this.saveOrConflict(
      () =>
        this.dataSource.transaction((manager) =>
          manager.save(
            entries.map((entry) =>
              manager.create(BuildingFlat, { tenantId, floorId: floor.id, ...entry }),
            ),
          ),
        ),
      'One of these flats was just added by someone else. Refresh and try again.',
    );

    return saved
      .map((flat) => this.toFlatView(flat, residentUnits))
      .sort((a, b) => naturalCompare(a.flatNumber, b.flatNumber));
  }

  async updateFlat(user: User, flatId: string, dto: UpdateFlatDto): Promise<FlatView> {
    const tenantId = this.requireTenant(user);
    const flat = await this.findFlat(tenantId, flatId);

    if (dto.flatNumber !== undefined) {
      const flatNumber = cleanFlatNumber(dto.flatNumber);
      if (!flatNumber) {
        throw new BadRequestException('Flat number is required');
      }
      const flatKey = normalizeFlatKey(flatNumber);
      if (flatKey !== flat.flatKey) {
        const clash = await this.flatRepository.findOne({
          where: { tenantId, flatKey },
          relations: ['floor'],
        });
        if (clash && clash.id !== flat.id) {
          throw new ConflictException(
            `Flat ${clash.flatNumber} already exists on ${floorLabel(clash.floor)}`,
          );
        }
      }
      flat.flatNumber = flatNumber;
      flat.flatKey = flatKey;
    }

    if (dto.floorId !== undefined && dto.floorId !== flat.floorId) {
      // Target must be a floor of the SAME building.
      const target = await this.findFloor(tenantId, dto.floorId);
      const onTarget = await this.flatRepository.count({ where: { tenantId, floorId: target.id } });
      if (onTarget >= MAX_FLATS_PER_FLOOR) {
        throw new BadRequestException(
          `${floorLabel(target)} already has the maximum of ${MAX_FLATS_PER_FLOOR} flats`,
        );
      }
      flat.floorId = target.id;
    }

    const saved = await this.saveOrConflict(
      () => this.flatRepository.save(flat),
      `Flat ${flat.flatNumber} already exists in this building`,
    );

    return this.toFlatView(saved, await this.countResidentsByUnit(tenantId));
  }

  async deleteFlat(user: User, flatId: string): Promise<{ id: string }> {
    const tenantId = this.requireTenant(user);
    const flat = await this.findFlat(tenantId, flatId);
    await this.flatRepository.delete({ id: flat.id, tenantId });
    return { id: flat.id };
  }

  // ==================== Helpers ====================

  private requireTenant(user: User): string {
    if (!user.tenantId) {
      throw new ConflictException(
        'This account is not linked to a building yet. Complete onboarding first.',
      );
    }
    return user.tenantId;
  }

  private async findFloor(tenantId: string, floorId: string): Promise<BuildingFloor> {
    const floor = await this.floorRepository.findOne({ where: { id: floorId, tenantId } });
    if (!floor) {
      throw new NotFoundException('Floor not found');
    }
    return floor;
  }

  private async findFlat(tenantId: string, flatId: string): Promise<BuildingFlat> {
    const flat = await this.flatRepository.findOne({ where: { id: flatId, tenantId } });
    if (!flat) {
      throw new NotFoundException('Flat not found');
    }
    return flat;
  }

  private async assertFloorNumberFree(tenantId: string, floorNumber: number): Promise<void> {
    const clash = await this.floorRepository.findOne({ where: { tenantId, floorNumber } });
    if (clash) {
      throw new ConflictException(
        `${floorLabel({ floorNumber, name: null })} already exists${clash.name ? ` (${clash.name})` : ''}`,
      );
    }
  }

  private async saveOrConflict<T>(save: () => Promise<T>, conflictMessage: string): Promise<T> {
    try {
      return await save();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(conflictMessage);
      }
      throw error;
    }
  }

  /**
   * Residents of the building grouped by normalised unit. Soft-deleted
   * residents are excluded by the query builder. The empty key ('') collects
   * residents with no unit at all.
   */
  private async countResidentsByUnit(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.userRepository
      .createQueryBuilder('resident')
      .select('resident.unit', 'unit')
      .addSelect('COUNT(*)', 'count')
      .where('resident.tenantId = :tenantId', { tenantId })
      .andWhere('resident.role = :role', { role: UserRole.RESIDENT })
      .groupBy('resident.unit')
      .getRawMany<{ unit: string | null; count: string }>();

    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.unit ? normalizeFlatKey(row.unit) : '';
      counts.set(key, (counts.get(key) ?? 0) + Number(row.count));
    }
    return counts;
  }

  private toFloorView(floor: BuildingFloor): Omit<FloorView, 'flats'> {
    return {
      id: floor.id,
      floorNumber: floor.floorNumber,
      name: floor.name,
      label: floorLabel(floor),
    };
  }

  private toFlatView(flat: BuildingFlat, residentUnits: Map<string, number>): FlatView {
    return {
      id: flat.id,
      floorId: flat.floorId,
      flatNumber: flat.flatNumber,
      residentCount: residentUnits.get(flat.flatKey) ?? 0,
    };
  }
}
