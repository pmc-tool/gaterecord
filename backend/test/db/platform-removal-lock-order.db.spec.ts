import { DataSource, QueryRunner } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { MembershipLifecycleService } from '../../src/modules/people/membership-lifecycle.service';
import { AccountIdentityClient } from '../../src/modules/account-identity/account-identity.client';
import { EmailService } from '../../src/modules/notification/email.service';
import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '../../src/database/entities/building-join-request.entity';
import { Membership } from '../../src/database/entities/membership.entity';
import { SubscriptionPlan } from '../../src/database/entities/subscription-plan.entity';
import { Tenant } from '../../src/database/entities/tenant.entity';
import { User, UserRole } from '../../src/database/entities/user.entity';
import { createTestDataSource, describeDb, rebuildSchema } from './test-data-source';
import {
  makeJoinRequest,
  makeMembership,
  makePerson,
  makePlan,
  makeTenant,
  reloadPerson,
} from './fixtures';

/**
 * DATA-3 against Postgres: removing a person from the platform while a
 * building admin approves their join request. Approving locks the request,
 * then the tenant, then the person (the global order, MembershipsService). A
 * removal that locked the person first and the join requests last deadlocked
 * with it (40P01, a 500 on one side). Now the removal cancels, and so locks,
 * the pending requests before the person: it simply waits for the approve.
 * Skipped without TEST_DATABASE_URL.
 */
describeDb('platform removal vs approving a join request (database)', () => {
  const originalFlag = process.env.GATE_MEMBERSHIP_CONTEXT;
  let dataSource: DataSource;
  let lifecycle: MembershipLifecycleService;
  let plan: SubscriptionPlan;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await rebuildSchema(dataSource);
    plan = await makePlan(dataSource);
    lifecycle = new MembershipLifecycleService(
      dataSource,
      new MembershipsService(dataSource),
      {} as AccountIdentityClient,
      {} as EmailService,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
    );
  });

  beforeEach(() => {
    process.env.GATE_MEMBERSHIP_CONTEXT = 'on';
  });

  afterAll(async () => {
    process.env.GATE_MEMBERSHIP_CONTEXT = originalFlag;
    await dataSource?.destroy();
  });

  /** Resolves once a backend other than `runner`'s waits on a row lock (or after ~5 s). */
  async function someoneWaitsOnALock(runner: QueryRunner): Promise<void> {
    const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await dataSource.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
        [pid],
      );
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('the approve finishes, then the removal ends the new membership too; no deadlock', async () => {
    const home = await makeTenant(dataSource, plan);
    const tower = await makeTenant(dataSource, plan);
    const person = await makePerson(dataSource, { role: UserRole.RESIDENT });
    await makeMembership(dataSource, person, home);
    const request = await makeJoinRequest(dataSource, person, tower);
    const superAdmin = await makePerson(dataSource, { role: UserRole.SUPER_ADMIN });

    // approve(), step by step: the request, then the tenant...
    const approve = dataSource.createQueryRunner();
    await approve.connect();
    await approve.startTransaction();
    try {
      await approve.manager.findOne(BuildingJoinRequest, {
        where: { id: request.id },
        lock: { mode: 'pessimistic_write' },
      });
      await approve.manager.findOne(Tenant, {
        where: { id: tower.id },
        lock: { mode: 'pessimistic_write' },
      });

      // ...while the platform removal starts and blocks on the request.
      const removal = lifecycle.removePersonFromPlatform(person.id, {
        actor: superAdmin,
        scope: 'platform',
      });
      const removalSettled = removal.then(
        (value) => ({ ok: true as const, value }),
        (error: Error) => ({ ok: false as const, error }),
      );
      await someoneWaitsOnALock(approve);

      // ...then the requester's row. Locked first by the removal, this waited
      // on it while it waited on the request: deadlock.
      await expect(
        approve.manager.findOne(User, {
          where: { id: person.id },
          lock: { mode: 'pessimistic_write' },
        }),
      ).resolves.toMatchObject({ id: person.id });
      await makeMembership(approve.manager, person, tower);
      await approve.manager.update(
        BuildingJoinRequest,
        { id: request.id },
        { status: JoinRequestStatus.APPROVED },
      );
      await approve.commitTransaction();

      const outcome = await removalSettled;
      expect(outcome.ok ? null : outcome.error.message).toBeNull();
      // Both buildings ended, the approved request is left approved.
      expect(outcome.ok && outcome.value).toMatchObject({
        membershipsEnded: 2,
        joinRequestsCancelled: 0,
      });
    } finally {
      if (approve.isTransactionActive) await approve.rollbackTransaction();
      await approve.release();
    }

    expect(
      await dataSource.getRepository(Membership).find({ where: { userId: person.id } }),
    ).toEqual([]);
    expect((await reloadPerson(dataSource, person.id)).deletedAt).toBeInstanceOf(Date);
    const after = await dataSource
      .getRepository(BuildingJoinRequest)
      .findOneOrFail({ where: { id: request.id } });
    expect(after.status).toBe(JoinRequestStatus.APPROVED);
  });

  it('cancels the pending join requests of the person it removes', async () => {
    const tower = await makeTenant(dataSource, plan);
    const person = await makePerson(dataSource, { role: UserRole.RESIDENT });
    const request = await makeJoinRequest(dataSource, person, tower);
    const superAdmin = await makePerson(dataSource, { role: UserRole.SUPER_ADMIN });

    await expect(
      lifecycle.removePersonFromPlatform(person.id, { actor: superAdmin, scope: 'platform' }),
    ).resolves.toMatchObject({ membershipsEnded: 0, joinRequestsCancelled: 1 });

    const after = await dataSource
      .getRepository(BuildingJoinRequest)
      .findOneOrFail({ where: { id: request.id } });
    expect(after.status).toBe(JoinRequestStatus.CANCELLED);
  });

  it('a person already removed is 404, and the cancel of their requests rolls back', async () => {
    const tower = await makeTenant(dataSource, plan);
    const person = await makePerson(dataSource, { role: UserRole.RESIDENT });
    const request = await makeJoinRequest(dataSource, person, tower);
    const superAdmin = await makePerson(dataSource, { role: UserRole.SUPER_ADMIN });
    await dataSource.getRepository(User).softDelete({ id: person.id });

    await expect(
      lifecycle.removePersonFromPlatform(person.id, { actor: superAdmin, scope: 'platform' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const after = await dataSource
      .getRepository(BuildingJoinRequest)
      .findOneOrFail({ where: { id: request.id } });
    expect(after.status).toBe(JoinRequestStatus.PENDING);
  });
});
