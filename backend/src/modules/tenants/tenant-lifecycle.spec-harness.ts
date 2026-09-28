/**
 * Test-only harness shared by the tenant, onboarding and paid-signup specs.
 * Never imported by application code.
 *
 * RollbackPeopleManager is B0's in-memory FakePeopleManager (people.spec-harness)
 * with one addition these specs need: an outermost transaction() that fails
 * puts every table back as it was, so "a refusal inside the transaction leaves
 * no orphan tenant" can be asserted. Nested transaction() calls join the
 * outer one, as MembershipsService does with a real manager. SQL, locks and
 * isolation are still not simulated; the database suites cover those.
 */
import { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { BuildingJoinRequest } from '@database/entities/building-join-request.entity';
import { Membership } from '@database/entities/membership.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User } from '@database/entities/user.entity';
import { FakePeopleManager, Row, buildLifecycle } from '../people/people.spec-harness';

type Target = new () => object;

/** The tables a snapshot covers. */
const SNAPSHOT_TABLES: Target[] = [Tenant, User, Membership, BuildingJoinRequest, SubscriptionPlan];

export class RollbackPeopleManager extends FakePeopleManager {
  /** Raw SQL the code under test ran (advisory locks), for assertions. */
  readonly queries: { sql: string; params: unknown[] }[] = [];
  private depth = 0;

  async transaction<T>(work: (m: EntityManager) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      return work(this as unknown as EntityManager);
    }

    const snapshot = SNAPSHOT_TABLES.map(
      (target) => [target, this.rows(target).map((row) => ({ ...row }))] as const,
    );
    this.depth += 1;
    try {
      return await work(this as unknown as EntityManager);
    } catch (error) {
      for (const [target, rows] of snapshot) {
        const live = this.rows(target);
        live.splice(0, live.length, ...(rows as Row[]));
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    this.queries.push({ sql, params });
    return [];
  }

  /** Live (not soft-deleted) rows of a table. */
  live(target: Target): Row[] {
    return this.rows(target).filter((row) => row.deletedAt == null);
  }
}

/**
 * The real MembershipsService and MembershipLifecycleService over a
 * RollbackPeopleManager, plus a DataSource double whose transaction() is the
 * manager's.
 */
export function buildMembershipStack(m = new RollbackPeopleManager()) {
  const lifecycle = buildLifecycle(m);
  const dataSource = {
    manager: m,
    transaction: <T>(work: (em: EntityManager) => Promise<T>) => m.transaction(work),
  } as unknown as DataSource;

  return { ...lifecycle, m, dataSource };
}

export type MembershipStack = ReturnType<typeof buildMembershipStack>;
