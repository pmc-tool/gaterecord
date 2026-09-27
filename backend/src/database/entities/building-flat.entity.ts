import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { BuildingFloor } from './building-floor.entity';

/**
 * A flat (apartment / unit) on a building floor. Hard deleted — see
 * BuildingFloor for why.
 *
 * Flat numbers are unique per BUILDING, not per floor, because a resident's
 * `gate_users.unit` names a flat without naming its floor; two "4B"s in one
 * building would make that ambiguous.
 */
@Entity('building_flats')
@Index('UQ_building_flats_tenant_flat_key', ['tenantId', 'flatKey'], { unique: true })
@Index('IDX_building_flats_floor', ['floorId'])
export class BuildingFlat extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'floor_id', type: 'uuid' })
  floorId: string;

  @ManyToOne(() => BuildingFloor, (floor) => floor.flats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'floor_id' })
  floor: BuildingFloor;

  /** As the admin typed it, e.g. "4B". */
  @Column({ name: 'flat_number', type: 'varchar', length: 20 })
  flatNumber: string;

  /**
   * `flatNumber` normalised by `normalizeFlatKey` (trimmed, single-spaced,
   * upper-cased). Backs the uniqueness rule so "4b" and "4B " collide, and is
   * how resident units are matched to flats.
   */
  @Column({ name: 'flat_key', type: 'varchar', length: 20 })
  flatKey: string;
}
