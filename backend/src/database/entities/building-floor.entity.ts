import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { BuildingFlat } from './building-flat.entity';

/**
 * One floor of a building, managed by that building's admin from
 * Building Settings.
 *
 * Floors and flats are building CONFIGURATION, not history, so they are hard
 * deleted (repository.delete) rather than soft deleted. That keeps the unique
 * index below a plain one: a soft-deleted "Floor 3" would otherwise block
 * re-creating Floor 3, or force a partial index that `synchronize` cannot
 * express on the entity.
 *
 * Nothing references a floor or flat by foreign key — residents still carry
 * their flat as the free-text `gate_users.unit` — so removing one can never
 * orphan a resident, gate or access event.
 */
@Entity('building_floors')
@Index('UQ_building_floors_tenant_floor_number', ['tenantId', 'floorNumber'], { unique: true })
export class BuildingFloor extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  // onDelete matches the migration's FK so synchronize-built and
  // migration-built schemas behave the same on a hard tenant delete.
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  /** 0 = ground floor, negative = basement levels. */
  @Column({ name: 'floor_number', type: 'int' })
  floorNumber: number;

  /** Optional display label, e.g. "Ground Floor", "Lobby", "Penthouse". */
  @Column({ type: 'varchar', length: 60, nullable: true })
  name: string | null;

  @OneToMany(() => BuildingFlat, (flat) => flat.floor)
  flats: BuildingFlat[];
}
