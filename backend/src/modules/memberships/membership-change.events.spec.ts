import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  MEMBERSHIP_CHANGED_EVENT,
  MembershipChangePublisher,
  queueMembershipChange,
  takeQueuedMembershipChange,
} from './membership-change.events';

/**
 * SOCKET-STALE-ROOMS: 'membership.changed' is published only after the
 * OUTERMOST transaction commits. The real commit/rollback broadcast is covered
 * by test/db/membership-rollback.db.spec.ts; here the TypeORM hooks are called
 * the way PostgresQueryRunner calls them (isTransactionActive is already false
 * after the outer COMMIT / ROLLBACK, still true after a savepoint).
 */
const P = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a01';
const Q = '0b6f6a3c-8a53-4d8e-9d1f-2c5a7b1e0a02';
const TOWER_A = '1a1a1a1a-1111-4111-8111-111111111111';

describe('membership.changed publishing', () => {
  let subscribers: unknown[];
  let emitter: EventEmitter2;
  let emitted: unknown[];
  let publisher: MembershipChangePublisher;

  beforeAll(() => Logger.overrideLogger(false));

  const runner = () => ({ isTransactionActive: true }) as unknown as QueryRunner;
  const managerOf = (queryRunner: QueryRunner) => ({ queryRunner }) as unknown as EntityManager;
  const committed = (queryRunner: QueryRunner, stillActive = false) => {
    (queryRunner as { isTransactionActive: boolean }).isTransactionActive = stillActive;
    publisher.afterTransactionCommit({ queryRunner } as never);
  };
  const rolledBack = (queryRunner: QueryRunner, stillActive = false) => {
    (queryRunner as { isTransactionActive: boolean }).isTransactionActive = stillActive;
    publisher.afterTransactionRollback({ queryRunner } as never);
  };

  beforeEach(() => {
    subscribers = [];
    emitter = new EventEmitter2();
    emitted = [];
    emitter.on(MEMBERSHIP_CHANGED_EVENT, (change: unknown) => emitted.push(change));
    publisher = new MembershipChangePublisher({ subscribers } as unknown as DataSource, emitter);
  });

  it('registers itself with the DataSource', () => {
    expect(subscribers).toEqual([publisher]);
  });

  it('publishes once, merged, when the outermost transaction commits', () => {
    const qr = runner();
    queueMembershipChange(managerOf(qr), { personIds: [Q] });
    queueMembershipChange(managerOf(qr), { personIds: [P, Q], tenantId: TOWER_A });
    expect(emitted).toEqual([]);

    committed(qr);

    expect(emitted).toEqual([{ personIds: [P, Q].sort(), tenantIds: [TOWER_A] }]);
    committed(qr);
    expect(emitted).toHaveLength(1);
  });

  it('waits past a released savepoint for the outer commit', () => {
    const qr = runner();
    queueMembershipChange(managerOf(qr), { personIds: [P] });

    committed(qr, true);
    expect(emitted).toEqual([]);

    committed(qr);
    expect(emitted).toEqual([{ personIds: [P], tenantIds: [] }]);
  });

  it('drops the queue when the outermost transaction rolls back', () => {
    const qr = runner();
    queueMembershipChange(managerOf(qr), { personIds: [P] });

    rolledBack(qr);
    committed(qr);

    expect(emitted).toEqual([]);
  });

  it('keeps the queue over a savepoint rollback (a harmless extra re-check)', () => {
    const qr = runner();
    queueMembershipChange(managerOf(qr), { personIds: [P] });

    rolledBack(qr, true);
    committed(qr);

    expect(emitted).toEqual([{ personIds: [P], tenantIds: [] }]);
  });

  it('keeps transactions apart', () => {
    const first = runner();
    const second = runner();
    queueMembershipChange(managerOf(first), { personIds: [P] });
    queueMembershipChange(managerOf(second), { personIds: [Q] });

    committed(second);

    expect(emitted).toEqual([{ personIds: [Q], tenantIds: [] }]);
    expect(takeQueuedMembershipChange(first)).toEqual({ personIds: [P], tenantIds: [] });
  });

  it('records nothing for a manager without a transaction runner, or for an empty change', () => {
    queueMembershipChange({} as EntityManager, { personIds: [P] });
    const qr = runner();
    queueMembershipChange(managerOf(qr), { personIds: [] });

    committed(qr);

    expect(emitted).toEqual([]);
  });

  it('never lets a failing listener fail the commit that already happened', () => {
    emitter.on(MEMBERSHIP_CHANGED_EVENT, () => {
      throw new Error('listener exploded');
    });
    const qr = runner();
    queueMembershipChange(managerOf(qr), { personIds: [P] });

    expect(() => committed(qr)).not.toThrow();
  });
});
