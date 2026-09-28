import { randomUUID } from 'crypto';
import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, FindOperator } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { Membership } from '@database/entities/membership.entity';
import { MembershipsService, pickPrimaryMembership } from './memberships.service';
import { takeQueuedMembershipChange } from './membership-change.events';

/**
 * Unit coverage of MembershipsService against a small in-memory stand-in for
 * the EntityManager methods it uses. Locks and SQL are covered by the database
 * suite (test/db/memberships.service.db.spec.ts); this pins the rules.
 */
type Row = Record<string, unknown> & { id: string };
type Target = new () => object;

class FakeManager {
  readonly queryRunner = { isTransactionActive: true };
  private readonly tables = new Map<Target, Row[]>();
  private clock = Date.UTC(2026, 0, 1);

  rows(target: Target): Row[] {
    if (!this.tables.has(target)) this.tables.set(target, []);
    return this.tables.get(target) as Row[];
  }

  insert<T extends object>(target: new () => T, values: Partial<T>): T {
    const row = {
      id: randomUUID(),
      createdAt: new Date((this.clock += 1000)),
      deletedAt: null,
      ...values,
    } as unknown as Row;
    this.rows(target).push(row);
    return Object.assign(new target(), row);
  }

  async transaction<T>(work: (m: EntityManager) => Promise<T>): Promise<T> {
    return work(this as unknown as EntityManager);
  }

  create<T extends object>(target: new () => T, values: Partial<T>): T {
    return Object.assign(new target(), values);
  }

  async save<T extends { id?: string }>(entity: T): Promise<T> {
    const target = entity.constructor as Target;
    if (!entity.id) {
      return this.insert(target, entity as Partial<object>) as unknown as T;
    }
    const row = this.rows(target).find((existing) => existing.id === entity.id);
    Object.assign(row as Row, { ...entity });
    return entity;
  }

  async findOne(target: Target, options: { where: object; withDeleted?: boolean }) {
    const row = this.match(target, options.where, options.withDeleted)[0];
    return row ? Object.assign(new target(), row) : null;
  }

  async find(target: Target, options: { where: object; withDeleted?: boolean }) {
    return this.match(target, options.where, options.withDeleted).map((row) =>
      Object.assign(new target(), row),
    );
  }

  async count(target: Target, options: { where: object }) {
    return this.match(target, options.where).length;
  }

  async update(target: Target, criteria: object, values: object) {
    const rows = this.match(target, criteria, true);
    rows.forEach((row) => Object.assign(row, values));
    return { affected: rows.length };
  }

  private match(target: Target, where: object, withDeleted = false): Row[] {
    return this.rows(target)
      .filter((row) => withDeleted || row.deletedAt == null)
      .filter((row) =>
        Object.entries(where).every(([key, condition]) => matches(row[key], condition)),
      )
      .sort(
        (a, b) =>
          (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() ||
          a.id.localeCompare(b.id),
      );
  }
}

function matches(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    switch (condition.type) {
      case 'in':
        return (condition.value as unknown as unknown[]).includes(value);
      case 'isNull':
        return value == null;
      case 'not':
        return !matches(value, condition.value);
      default:
        throw new Error(`FakeManager: unsupported operator ${condition.type}`);
    }
  }
  return value === condition;
}

function codeOf(error: unknown): unknown {
  expect(error).toBeInstanceOf(HttpException);
  return ((error as HttpException).getResponse() as { code?: unknown }).code;
}

describe('MembershipsService', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let m: FakeManager;
  let service: MembershipsService;
  let towerA: Tenant;
  let towerB: Tenant;

  const person = (values: Partial<User> = {}) =>
    m.insert(User, {
      email: `${randomUUID()}@example.test`,
      role: UserRole.BUILDING_ADMIN,
      status: UserStatus.ACTIVE,
      tenantId: null,
      unit: null as unknown as string,
      ...values,
    });
  const reload = (id: string) => m.rows(User).find((row) => row.id === id) as unknown as User;
  const live = (userId: string) =>
    m.rows(Membership).filter((row) => row.userId === userId && row.deletedAt == null);

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'off';
    m = new FakeManager();
    service = new MembershipsService({ manager: m } as unknown as DataSource);
    towerA = m.insert(Tenant, { name: 'A' });
    towerB = m.insert(Tenant, { name: 'B' });
  });

  afterAll(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
  });

  const em = () => m as unknown as EntityManager;

  describe('add()', () => {
    it('adds a membership and mirrors it onto the legacy columns', async () => {
      const p = person();
      const saved = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT, unit: '12B' },
        em(),
      );

      expect(saved).toMatchObject({
        role: UserRole.RESIDENT,
        status: UserStatus.ACTIVE,
        unit: '12B',
      });
      expect(reload(p.id)).toMatchObject({
        tenantId: towerA.id,
        role: UserRole.RESIDENT,
        unit: '12B',
        status: UserStatus.ACTIVE,
      });
    });

    it('refuses a second building with 409 MULTI_MEMBERSHIP_DISABLED while the flag is off', async () => {
      const p = person();
      await service.add({ userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT }, em());

      const error = await service
        .add({ userId: p.id, tenantId: towerB.id, role: UserRole.SECURITY }, em())
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(codeOf(error)).toBe('MULTI_MEMBERSHIP_DISABLED');
      expect(live(p.id)).toHaveLength(1);
    });

    it('allows a second building with the flag on and keeps the oldest active as primary', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      await service.add({ userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT }, em());
      await service.add({ userId: p.id, tenantId: towerB.id, role: UserRole.SECURITY }, em());

      expect(live(p.id)).toHaveLength(2);
      expect(reload(p.id)).toMatchObject({ tenantId: towerA.id, role: UserRole.RESIDENT });
    });

    it('refuses a second role in the same building with 409 MEMBERSHIP_EXISTS', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      await service.add({ userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT }, em());

      const error = await service
        .add({ userId: p.id, tenantId: towerA.id, role: UserRole.SECURITY }, em())
        .catch((e) => e);

      expect(codeOf(error)).toBe('MEMBERSHIP_EXISTS');
      expect((error as HttpException).getResponse()).toMatchObject({ role: UserRole.RESIDENT });
    });

    it("never touches a super admin's role or status, but mirrors their building and unit", async () => {
      const admin = person({ role: UserRole.SUPER_ADMIN });
      const membership = await service.add(
        {
          userId: admin.id,
          tenantId: towerA.id,
          role: UserRole.RESIDENT,
          status: UserStatus.INACTIVE,
          unit: '3A',
        },
        em(),
      );

      expect(reload(admin.id)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: towerA.id,
        unit: '3A',
        status: UserStatus.ACTIVE,
      });

      // Removed from the building: the stale tenant_id would keep them passing
      // the legacy gate check there (DATA-1).
      await service.remove(membership.id, em());
      expect(reload(admin.id)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        unit: null,
        status: UserStatus.ACTIVE,
      });
    });

    it('re-derives the building of a person granted super_admin while holding one', async () => {
      const p = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT, unit: '1A' },
        em(),
      );
      // The grant: gate_users.role only, tenant_id left as the old mirror.
      m.rows(User).find((row) => row.id === p.id)!.role = UserRole.SUPER_ADMIN;

      await service.remove(inA.id, em());

      expect(reload(p.id)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        unit: null,
      });
    });

    it('copies a non-active status onto a single-building person, but never lifts one', async () => {
      const newcomer = person();
      await service.add(
        {
          userId: newcomer.id,
          tenantId: towerA.id,
          role: UserRole.RESIDENT,
          status: UserStatus.INACTIVE,
        },
        em(),
      );
      expect(reload(newcomer.id).status).toBe(UserStatus.INACTIVE);

      const banned = person({ status: UserStatus.INACTIVE });
      await service.add({ userId: banned.id, tenantId: towerA.id, role: UserRole.RESIDENT }, em());
      expect(reload(banned.id).status).toBe(UserStatus.INACTIVE);
    });

    it('404s for a missing building or person, and rejects super_admin as a building role', async () => {
      const p = person();
      await expect(
        service.add({ userId: p.id, tenantId: randomUUID(), role: UserRole.RESIDENT }, em()),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.add({ userId: randomUUID(), tenantId: towerA.id, role: UserRole.RESIDENT }, em()),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.add(
          { userId: p.id, tenantId: towerA.id, role: UserRole.SUPER_ADMIN as never },
          em(),
        ),
      ).rejects.toThrow('not a role');
    });
  });

  describe('update()', () => {
    it('dual-writes status for a single-building person, both ways', async () => {
      const p = person();
      const membership = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );

      await service.update(membership.id, { status: UserStatus.INACTIVE }, em());
      expect(reload(p.id).status).toBe(UserStatus.INACTIVE);

      await service.update(membership.id, { status: UserStatus.ACTIVE }, em());
      expect(reload(p.id).status).toBe(UserStatus.ACTIVE);
    });

    it('does not touch gate_users.status for a person with several buildings', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      await service.add({ userId: p.id, tenantId: towerB.id, role: UserRole.SECURITY }, em());

      await service.update(inA.id, { status: UserStatus.INACTIVE }, em());

      // Still active on the platform; the mirror moves to the remaining active building.
      expect(reload(p.id)).toMatchObject({
        status: UserStatus.ACTIVE,
        tenantId: towerB.id,
        role: UserRole.SECURITY,
      });
    });

    it('re-mirrors a role or unit change and 404s for an ended membership', async () => {
      const p = person();
      const membership = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT, unit: '1A' },
        em(),
      );

      await service.update(membership.id, { role: UserRole.SECURITY, unit: null }, em());
      expect(reload(p.id)).toMatchObject({ role: UserRole.SECURITY, unit: null });

      await service.remove(membership.id, em());
      await expect(service.update(membership.id, { unit: '2B' }, em())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove() / removeAllForTenant() / restorePerson()', () => {
    it('writes the sentinel when the last membership ends and releases a mirrored status', async () => {
      const p = person();
      const membership = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT, unit: '5C' },
        em(),
      );
      await service.update(membership.id, { status: UserStatus.INACTIVE }, em());

      await service.remove(membership.id, em());

      expect(live(p.id)).toHaveLength(0);
      expect(reload(p.id)).toMatchObject({
        tenantId: null,
        role: UserRole.BUILDING_ADMIN,
        unit: null,
        status: UserStatus.ACTIVE,
      });
    });

    it('copies the status of the one inactive membership left onto gate_users (DATA-2)', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      const inB = await service.add(
        { userId: p.id, tenantId: towerB.id, role: UserRole.RESIDENT },
        em(),
      );
      await service.update(inB.id, { status: UserStatus.INACTIVE }, em());
      expect(reload(p.id).status).toBe(UserStatus.ACTIVE);

      await service.remove(inA.id, em());

      expect(reload(p.id)).toMatchObject({
        status: UserStatus.INACTIVE,
        tenantId: towerB.id,
        role: UserRole.RESIDENT,
      });
    });

    it('copies a pending status left behind the same way', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      await service.add(
        { userId: p.id, tenantId: towerB.id, role: UserRole.RESIDENT, status: UserStatus.PENDING },
        em(),
      );

      await service.remove(inA.id, em());

      expect(reload(p.id).status).toBe(UserStatus.PENDING);
    });

    it('never lifts a platform ban when the membership left is active', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      await service.add({ userId: p.id, tenantId: towerB.id, role: UserRole.SECURITY }, em());
      m.rows(User).find((row) => row.id === p.id)!.status = UserStatus.INACTIVE;

      await service.remove(inA.id, em());

      expect(reload(p.id)).toMatchObject({ status: UserStatus.INACTIVE, tenantId: towerB.id });
    });

    it('leaves gate_users.status alone while two or more memberships are left', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const towerC = m.insert(Tenant, { name: 'C' });
      const p = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      for (const tower of [towerB, towerC]) {
        await service.add(
          {
            userId: p.id,
            tenantId: tower.id,
            role: UserRole.RESIDENT,
            status: UserStatus.INACTIVE,
          },
          em(),
        );
      }

      await service.remove(inA.id, em());

      expect(reload(p.id).status).toBe(UserStatus.ACTIVE);
    });

    it('keeps a platform ban that did not come from the ended membership', async () => {
      const p = person();
      const membership = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      m.rows(User).find((row) => row.id === p.id)!.status = UserStatus.INACTIVE;

      await service.remove(membership.id, em());

      expect(reload(p.id).status).toBe(UserStatus.INACTIVE);
    });

    it('ends a whole building with one deleted_at and re-mirrors everyone', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const multi = person();
      const single = person();
      await service.add(
        { userId: multi.id, tenantId: towerA.id, role: UserRole.BUILDING_ADMIN },
        em(),
      );
      await service.add({ userId: multi.id, tenantId: towerB.id, role: UserRole.RESIDENT }, em());
      await service.add({ userId: single.id, tenantId: towerA.id, role: UserRole.SECURITY }, em());

      await expect(service.removeAllForTenant(towerA.id, em())).resolves.toBe(2);

      const ended = m.rows(Membership).filter((row) => row.tenantId === towerA.id);
      expect(new Set(ended.map((row) => (row.deletedAt as Date).getTime())).size).toBe(1);
      expect(reload(multi.id)).toMatchObject({ tenantId: towerB.id, role: UserRole.RESIDENT });
      expect(reload(single.id)).toMatchObject({ tenantId: null, role: UserRole.BUILDING_ADMIN });
    });

    it('removeAllForTenant copies the status of the one inactive membership left (DATA-2)', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      await service.add({ userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT }, em());
      const inB = await service.add(
        { userId: p.id, tenantId: towerB.id, role: UserRole.SECURITY },
        em(),
      );
      await service.update(inB.id, { status: UserStatus.INACTIVE }, em());

      await service.removeAllForTenant(towerA.id, em());

      expect(reload(p.id)).toMatchObject({
        status: UserStatus.INACTIVE,
        tenantId: towerB.id,
        role: UserRole.SECURITY,
      });
    });

    it('restorePerson leaves zero live memberships, the sentinel and the status as it was', async () => {
      const p = person();
      const membership = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      await service.update(membership.id, { status: UserStatus.INACTIVE }, em());

      await expect(service.restorePerson(p.id, em())).resolves.toBe(1);

      expect(live(p.id)).toHaveLength(0);
      expect(reload(p.id)).toMatchObject({
        tenantId: null,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.INACTIVE,
      });
    });
  });

  describe("'membership.changed' queue", () => {
    it('queues every write on its transaction, merged per transaction', async () => {
      process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
      const p = person();
      const q = person();
      const inA = await service.add(
        { userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT },
        em(),
      );
      await service.update(inA.id, { unit: '9Z' }, em());
      await service.add({ userId: q.id, tenantId: towerA.id, role: UserRole.SECURITY }, em());

      expect(takeQueuedMembershipChange(m.queryRunner)).toEqual({
        personIds: [p.id, q.id].sort(),
        tenantIds: [],
      });
      // Taken: nothing is published twice.
      expect(takeQueuedMembershipChange(m.queryRunner)).toBeNull();

      await service.remove(inA.id, em());
      expect(takeQueuedMembershipChange(m.queryRunner)).toEqual({
        personIds: [p.id],
        tenantIds: [],
      });
    });

    it('names the building for removeAllForTenant, and queues nothing for an empty one', async () => {
      const p = person();
      await service.add({ userId: p.id, tenantId: towerA.id, role: UserRole.RESIDENT }, em());
      takeQueuedMembershipChange(m.queryRunner);

      await service.removeAllForTenant(towerB.id, em());
      expect(takeQueuedMembershipChange(m.queryRunner)).toBeNull();

      await service.removeAllForTenant(towerA.id, em());
      expect(takeQueuedMembershipChange(m.queryRunner)).toEqual({
        personIds: [p.id],
        tenantIds: [towerA.id],
      });
    });
  });

  describe('reads', () => {
    it('never turns a missing id into an unscoped query', async () => {
      const findOne = jest.spyOn(m, 'findOne');
      const find = jest.spyOn(m, 'find');

      await expect(
        service.findLive(undefined as unknown as string, towerA.id, em()),
      ).resolves.toBeNull();
      await expect(
        service.findLive(randomUUID(), null as unknown as string, em()),
      ).resolves.toBeNull();
      await expect(service.listLiveForUser('', em())).resolves.toEqual([]);

      expect(findOne).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
    });
  });
});

describe('pickPrimaryMembership', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);

  it('prefers active, then oldest, then lowest id', () => {
    const rows = [
      { id: 'b', status: UserStatus.ACTIVE, createdAt: at(2) },
      { id: 'c', status: UserStatus.INACTIVE, createdAt: at(0) },
      { id: 'a', status: UserStatus.ACTIVE, createdAt: at(2) },
      { id: 'd', status: UserStatus.ACTIVE, createdAt: at(5) },
    ];
    expect(pickPrimaryMembership(rows)?.id).toBe('a');
    expect(pickPrimaryMembership([rows[1]])?.id).toBe('c');
    expect(pickPrimaryMembership([])).toBeNull();
  });
});
