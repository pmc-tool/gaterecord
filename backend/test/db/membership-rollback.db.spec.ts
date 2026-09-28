/**
 * The flag-off rollback path against Postgres: what a person's gate_users row
 * and the legacy readers say after multi-building writes made while
 * GATE_MEMBERSHIP_CONTEXT was on (DATA-2 / GATE-ROLLBACK-STATUS), the super
 * admin mirror (DATA-1), the reconcile checks that find what is left (K2b, K7,
 * R1), migration down(), and 'membership.changed' being published only after
 * the commit (SOCKET-STALE-ROOMS).
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Not } from 'typeorm';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { MembershipAccessService } from '../../src/modules/memberships/membership-access.service';
import { MembershipContextService } from '../../src/modules/memberships/membership-context.service';
import { PERSONAL_QR_ROLES } from '../../src/modules/memberships/membership-access.constants';
import { recordMembershipTablePresence } from '../../src/modules/memberships/membership-table';
import {
  MEMBERSHIP_CHANGED_EVENT,
  MembershipChangePublisher,
  MembershipChangedEvent,
} from '../../src/modules/memberships/membership-change.events';
import { CreateGateMemberships1775740000000 } from '../../src/database/migrations/1775740000000-CreateGateMemberships';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '../../src/database/entities/user.entity';
import { buildChecks } from '../../scripts/reconcile-memberships';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import { makeMembership, makePerson, makePlan, makeTenant, reloadPerson } from './fixtures';

describeDb('flag-off rollback, super admin mirror and change events (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let memberships: MembershipsService;
  let access: MembershipAccessService;
  let context: MembershipContextService;
  let plan: SubscriptionPlan;
  let towerA: Tenant;
  let towerB: Tenant;

  const flagOn = () => (process.env.GATE_MEMBERSHIP_CONTEXT = 'on');
  const flagOff = () => (process.env.GATE_MEMBERSHIP_CONTEXT = 'off');

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    memberships = new MembershipsService(dataSource);
    access = new MembershipAccessService(dataSource);
    context = new MembershipContextService(memberships, dataSource.getRepository(Tenant));
    plan = await makePlan(dataSource);
    // As MembershipsModule's boot check records it on a migrated database.
    recordMembershipTablePresence(true);
  });

  beforeEach(async () => {
    flagOff();
    towerA = await makeTenant(dataSource, plan);
    towerB = await makeTenant(dataSource, plan);
  });

  afterAll(async () => {
    recordMembershipTablePresence(false);
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  const gateAt = (personId: string, tenantId: string) =>
    access.checkHolder(personId, tenantId, { roles: PERSONAL_QR_ROLES });

  /** The person ids a reconcile check lists right now. */
  async function findings(key: string, membershipContextOn = false): Promise<string[]> {
    const check = buildChecks(membershipContextOn).find((candidate) => candidate.key === key);
    if (!check) throw new Error(`No reconcile check ${key}`);
    const rows: Array<{ person_id: string }> = await dataSource.query(check.sql);
    return rows.map((row) => row.person_id);
  }

  /** P: a resident of A and of B, both added while the flag is on. */
  async function residentOfAandB() {
    flagOn();
    const person = await makePerson(dataSource);
    const inA = await memberships.add({
      userId: person.id,
      tenantId: towerA.id,
      role: UserRole.RESIDENT,
    });
    const inB = await memberships.add({
      userId: person.id,
      tenantId: towerB.id,
      role: UserRole.RESIDENT,
    });
    return { person, inA, inB };
  }

  describe('status dual-write after removals (DATA-2)', () => {
    it('case 1: deactivated in A, then removed from B: gate_users carries the inactive status', async () => {
      const { person, inA, inB } = await residentOfAandB();
      await memberships.update(inA.id, { status: UserStatus.INACTIVE });
      expect((await reloadPerson(dataSource, person.id)).status).toBe(UserStatus.ACTIVE);

      await memberships.remove(inB.id);

      expect(await reloadPerson(dataSource, person.id)).toMatchObject({
        status: UserStatus.INACTIVE,
        tenantId: towerA.id,
        role: UserRole.RESIDENT,
      });
      expect((await gateAt(person.id, towerA.id)).allowed).toBe(false);

      flagOff();
      expect(await gateAt(person.id, towerA.id)).toMatchObject({
        allowed: false,
        reason: 'MEMBERSHIP_INACTIVE',
        source: 'legacy',
      });
      expect(await findings('K7')).not.toContain(person.id);
      expect(await findings('R1')).not.toContain(person.id);
    });

    it('the same when B is deleted as a building (removeAllForTenant)', async () => {
      const { person, inA } = await residentOfAandB();
      await memberships.update(inA.id, { status: UserStatus.INACTIVE });

      await dataSource.transaction(async (m) => {
        await m.softDelete(Tenant, { id: towerB.id });
        await memberships.removeAllForTenant(towerB.id, m);
      });

      expect(await reloadPerson(dataSource, person.id)).toMatchObject({
        status: UserStatus.INACTIVE,
        tenantId: towerA.id,
      });
      flagOff();
      expect((await gateAt(person.id, towerA.id)).reason).toBe('MEMBERSHIP_INACTIVE');
    });

    it('never lifts a platform ban when the membership left is active', async () => {
      const { person, inA } = await residentOfAandB();
      await dataSource
        .getRepository(User)
        .update({ id: person.id }, { status: UserStatus.INACTIVE });

      await memberships.remove(inA.id);

      expect(await reloadPerson(dataSource, person.id)).toMatchObject({
        status: UserStatus.INACTIVE,
        tenantId: towerB.id,
      });
    });
  });

  describe('legacy readers after a rollback (GATE-ROLLBACK-STATUS)', () => {
    it('case 2: inactive in both buildings: the gate and the principal refuse the legacy building', async () => {
      const { person, inA, inB } = await residentOfAandB();
      await memberships.update(inA.id, { status: UserStatus.INACTIVE });
      await memberships.update(inB.id, { status: UserStatus.INACTIVE });

      // Two live memberships: gate_users.status is not a copy of either.
      const row = await reloadPerson(dataSource, person.id);
      expect(row).toMatchObject({ status: UserStatus.ACTIVE, tenantId: towerA.id });
      expect((await gateAt(person.id, towerA.id)).reason).toBe('MEMBERSHIP_INACTIVE');

      flagOff();
      expect(await gateAt(person.id, towerA.id)).toMatchObject({
        allowed: false,
        reason: 'MEMBERSHIP_INACTIVE',
        source: 'legacy',
      });
      expect(await context.resolve(row)).toMatchObject({
        contextKind: 'legacy',
        role: null,
        tenantId: null,
        tenant: null,
        unit: null,
      });

      // K7 lists them as drift while the flag is off; with it on it is a note.
      expect(await findings('K7')).toContain(person.id);
      expect(buildChecks(false).find((check) => check.key === 'K7')?.drift).toBe(true);
      expect(buildChecks(true).find((check) => check.key === 'K7')?.drift).toBe(false);
    });

    it('an active member of the legacy building is unaffected', async () => {
      const person = await makePerson(dataSource);
      await memberships.add({ userId: person.id, tenantId: towerA.id, role: UserRole.SECURITY });
      const row = await reloadPerson(dataSource, person.id);

      expect(await gateAt(person.id, towerA.id)).toMatchObject({ allowed: true, source: 'legacy' });
      expect(await context.resolve(row)).toMatchObject({
        contextKind: 'legacy',
        role: UserRole.SECURITY,
        tenantId: towerA.id,
      });
      expect((await context.resolve(row)).tenant?.id).toBe(towerA.id);
    });

    it('reads no membership until the table is known to exist', async () => {
      const { person, inA, inB } = await residentOfAandB();
      await memberships.update(inA.id, { status: UserStatus.INACTIVE });
      await memberships.update(inB.id, { status: UserStatus.INACTIVE });
      flagOff();

      recordMembershipTablePresence(false);
      try {
        expect((await gateAt(person.id, towerA.id)).allowed).toBe(true);
        const acting = await context.resolve(await reloadPerson(dataSource, person.id));
        expect(acting.tenantId).toBe(towerA.id);
      } finally {
        recordMembershipTablePresence(true);
      }
    });
  });

  describe('super admin mirror (DATA-1)', () => {
    it('a super admin removed from a building no longer passes its legacy gate check', async () => {
      const person = await makePerson(dataSource);
      const inA = await memberships.add({
        userId: person.id,
        tenantId: towerA.id,
        role: UserRole.RESIDENT,
        unit: '7C',
      });
      // createPlatformAdmin for an existing person: the role only.
      await dataSource
        .getRepository(User)
        .update({ id: person.id, role: Not(UserRole.SUPER_ADMIN) }, { role: UserRole.SUPER_ADMIN });
      expect((await gateAt(person.id, towerA.id)).allowed).toBe(true);

      await memberships.remove(inA.id);

      expect(await reloadPerson(dataSource, person.id)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: null,
        unit: null,
        status: UserStatus.ACTIVE,
      });
      expect((await gateAt(person.id, towerA.id)).reason).toBe('NO_MEMBERSHIP');
    });

    it('K2b lists a super admin whose building has no membership of theirs', async () => {
      const admin = await makePerson(dataSource, {
        role: UserRole.SUPER_ADMIN,
        tenantId: towerA.id,
      });
      expect(await findings('K2b')).toContain(admin.id);
      expect(buildChecks(true).find((check) => check.key === 'K2b')?.drift).toBe(true);

      const inB = await memberships.add({
        userId: admin.id,
        tenantId: towerB.id,
        role: UserRole.RESIDENT,
      });
      expect(await reloadPerson(dataSource, admin.id)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        tenantId: towerB.id,
      });
      expect(await findings('K2b')).not.toContain(admin.id);

      await memberships.remove(inB.id);
      expect((await reloadPerson(dataSource, admin.id)).tenantId).toBeNull();
      expect(await findings('K2b')).not.toContain(admin.id);
    });
  });

  describe('reconcile R1 / K7 (the pre-rollback check)', () => {
    it('R1 and K7 list a single-membership person the dual-write missed, as drift while off', async () => {
      const person = await makePerson(dataSource, {
        role: UserRole.RESIDENT,
        tenantId: towerA.id,
      });
      await makeMembership(dataSource, person, towerA, { status: UserStatus.INACTIVE });

      expect(await findings('R1')).toContain(person.id);
      expect(await findings('K7')).toContain(person.id);
      expect(buildChecks(false).find((check) => check.key === 'R1')?.drift).toBe(true);
      expect(buildChecks(true).find((check) => check.key === 'R1')?.drift).toBe(false);
    });
  });

  describe("'membership.changed' after the commit (SOCKET-STALE-ROOMS)", () => {
    let events: MembershipChangedEvent[];

    beforeAll(() => {
      const emitter = new EventEmitter2();
      events = [];
      emitter.on(MEMBERSHIP_CHANGED_EVENT, (change: MembershipChangedEvent) => events.push(change));
      new MembershipChangePublisher(dataSource, emitter);
    });

    beforeEach(() => {
      events.length = 0;
    });

    it('is published after the caller transaction commits, not inside it', async () => {
      const person = await makePerson(dataSource);

      await dataSource.transaction(async (m) => {
        await memberships.add(
          { userId: person.id, tenantId: towerA.id, role: UserRole.RESIDENT },
          m,
        );
        expect(events).toEqual([]);
      });

      expect(events).toEqual([{ personIds: [person.id], tenantIds: [] }]);
    });

    it('is not published when the caller transaction rolls back', async () => {
      const person = await makePerson(dataSource);

      await expect(
        dataSource.transaction(async (m) => {
          await memberships.add(
            { userId: person.id, tenantId: towerA.id, role: UserRole.RESIDENT },
            m,
          );
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      expect(events).toEqual([]);
    });

    it("is published for the service's own transaction, and for a building emptied as a whole", async () => {
      const person = await makePerson(dataSource);
      const inA = await memberships.add({
        userId: person.id,
        tenantId: towerA.id,
        role: UserRole.SECURITY,
      });
      expect(events).toEqual([{ personIds: [person.id], tenantIds: [] }]);

      await memberships.update(inA.id, { unit: 'G1' });
      await memberships.removeAllForTenant(towerA.id);

      expect(events.slice(1)).toEqual([
        { personIds: [person.id], tenantIds: [] },
        { personIds: [person.id], tenantIds: [towerA.id] },
      ]);
    });

    it('waits past a released savepoint for the outer commit', async () => {
      const person = await makePerson(dataSource);
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      try {
        await queryRunner.startTransaction();
        await queryRunner.startTransaction();
        await memberships.add(
          { userId: person.id, tenantId: towerB.id, role: UserRole.RESIDENT },
          queryRunner.manager,
        );
        await queryRunner.commitTransaction();
        expect(events).toEqual([]);

        await queryRunner.commitTransaction();
        expect(events).toEqual([{ personIds: [person.id], tenantIds: [] }]);
      } finally {
        await queryRunner.release();
      }
    });
  });

  // Last: down() drops gate_memberships.
  describe('migration 1775740000000 down()', () => {
    it('copies a non-active membership status onto gate_users and never lifts a ban', async () => {
      await rebuildSchema(dataSource);
      const freshPlan = await makePlan(dataSource);
      const tower = await makeTenant(dataSource, freshPlan);

      const rows = {
        missedDualWrite: await makePerson(dataSource, {
          role: UserRole.RESIDENT,
          tenantId: tower.id,
        }),
        pending: await makePerson(dataSource, {
          role: UserRole.SECURITY,
          tenantId: tower.id,
        }),
        banned: await makePerson(dataSource, {
          role: UserRole.RESIDENT,
          tenantId: tower.id,
          status: UserStatus.INACTIVE,
        }),
        active: await makePerson(dataSource, { role: UserRole.RESIDENT, tenantId: tower.id }),
        superAdmin: await makePerson(dataSource, { role: UserRole.SUPER_ADMIN }),
      };
      await makeMembership(dataSource, rows.missedDualWrite, tower, {
        status: UserStatus.INACTIVE,
      });
      await makeMembership(dataSource, rows.pending, tower, {
        role: UserRole.SECURITY,
        status: UserStatus.PENDING,
      });
      await makeMembership(dataSource, rows.banned, tower);
      await makeMembership(dataSource, rows.active, tower);
      await makeMembership(dataSource, rows.superAdmin, tower, { status: UserStatus.INACTIVE });

      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        await new CreateGateMemberships1775740000000().down(queryRunner);
        await queryRunner.commitTransaction();
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }

      const statusOf = async (person: User) => (await reloadPerson(dataSource, person.id)).status;
      expect(await statusOf(rows.missedDualWrite)).toBe(UserStatus.INACTIVE);
      expect(await statusOf(rows.pending)).toBe(UserStatus.PENDING);
      expect(await statusOf(rows.banned)).toBe(UserStatus.INACTIVE);
      expect(await statusOf(rows.active)).toBe(UserStatus.ACTIVE);
      expect(await reloadPerson(dataSource, rows.superAdmin.id)).toMatchObject({
        role: UserRole.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        tenantId: null,
      });

      await rebuildSchema(dataSource);
    });
  });
});
