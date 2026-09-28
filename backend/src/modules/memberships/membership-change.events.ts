/**
 * 'membership.changed': published once the transaction that added, changed or
 * ended memberships has COMMITTED, so a listener (the socket gateway, which
 * re-checks the rooms of the people concerned) never acts on a write that is
 * later rolled back, and never re-reads the database before the write is
 * visible there.
 *
 * MembershipsService cannot publish by itself: every write joins the caller's
 * transaction when there is one (the people, tenants and join-request services
 * wrap several writes in one), so when the service returns nothing is committed
 * yet. It queues the change on the transaction's QueryRunner instead
 * (queueMembershipChange), and MembershipChangePublisher, a TypeORM subscriber,
 * publishes the queue from afterTransactionCommit once the OUTERMOST
 * transaction has committed. TypeORM broadcasts that hook for a released
 * savepoint too; isTransactionActive is still true then, so the queue waits.
 * A rollback of the outermost transaction drops the queue. A rollback to a
 * savepoint keeps it: publishing a change that did not happen only makes the
 * listener re-check sockets that turn out to be fine.
 */
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DataSource,
  EntityManager,
  EntitySubscriberInterface,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
} from 'typeorm';

export const MEMBERSHIP_CHANGED_EVENT = 'membership.changed';

/** Payload of MEMBERSHIP_CHANGED_EVENT: one per committed transaction. */
export interface MembershipChangedEvent {
  /** gate_users.id of every person whose memberships were written. */
  personIds: string[];
  /** Buildings emptied as a whole (removeAllForTenant). */
  tenantIds: string[];
}

interface QueuedChange {
  personIds: Set<string>;
  tenantIds: Set<string>;
}

/** Keyed by the QueryRunner of the transaction; weak, so a released runner leaves no trace. */
const queued = new WeakMap<object, QueuedChange>();

/**
 * Records that `manager`'s transaction wrote memberships of these people (and,
 * for a whole building, that building). Nothing is published until that
 * transaction commits. A manager without a QueryRunner (a test double) has no
 * commit to wait for, so nothing is recorded.
 */
export function queueMembershipChange(
  manager: EntityManager,
  change: { personIds?: readonly string[]; tenantId?: string | null },
): void {
  const runner = manager.queryRunner as object | undefined;
  if (!runner) {
    return;
  }

  const entry = queued.get(runner) ?? {
    personIds: new Set<string>(),
    tenantIds: new Set<string>(),
  };
  for (const personId of change.personIds ?? []) {
    entry.personIds.add(personId);
  }
  if (change.tenantId) {
    entry.tenantIds.add(change.tenantId);
  }
  queued.set(runner, entry);
}

/** Removes and returns what was queued on `runner`, merged into one event (or null). */
export function takeQueuedMembershipChange(runner: object): MembershipChangedEvent | null {
  const entry = queued.get(runner);
  queued.delete(runner);
  if (!entry || (entry.personIds.size === 0 && entry.tenantIds.size === 0)) {
    return null;
  }
  return { personIds: [...entry.personIds].sort(), tenantIds: [...entry.tenantIds].sort() };
}

/**
 * Publishes the queued membership changes of a transaction after it commits.
 * Registers itself with the DataSource in its constructor (as
 * ActingUserWriteGuardSubscriber does), so it sees every transaction of the
 * connection, whoever opened it.
 */
@Injectable()
export class MembershipChangePublisher implements EntitySubscriberInterface {
  private readonly logger = new Logger(MembershipChangePublisher.name);

  constructor(
    dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {
    dataSource.subscribers.push(this);
  }

  afterTransactionCommit(event: TransactionCommitEvent): void {
    // Still active: only a savepoint was released; the outer transaction decides.
    if (!event.queryRunner || event.queryRunner.isTransactionActive) {
      return;
    }
    this.publish(event.queryRunner);
  }

  afterTransactionRollback(event: TransactionRollbackEvent): void {
    if (event.queryRunner && !event.queryRunner.isTransactionActive) {
      takeQueuedMembershipChange(event.queryRunner);
    }
  }

  private publish(runner: QueryRunner): void {
    const change = takeQueuedMembershipChange(runner);
    if (!change) {
      return;
    }

    // Never let a listener fail the commit that already happened: an exception
    // here would surface from commitTransaction() as if the write had failed.
    try {
      this.eventEmitter.emit(MEMBERSHIP_CHANGED_EVENT, change);
    } catch (error) {
      this.logger.error(
        `Publishing ${MEMBERSHIP_CHANGED_EVENT} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
