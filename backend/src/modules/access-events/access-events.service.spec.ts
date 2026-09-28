/**
 * GATE-8 — overlay regression: the access log scopes by the OVERLAID principal
 * (contract C5), so person P sees building A's log as A's admin, only their own
 * events as B's resident, C's log as C's security, and everything in the
 * Platform context. The resident lens keys on resident_id = the PERSON id
 * (gate_users.id), which is what gate events record.
 *
 * No production code changed for this; pure unit tests over a recording query
 * builder (memberships/testing).
 */
import { AccessEventsService } from './access-events.service';
import {
  TOWER_A,
  TOWER_B,
  TOWER_C,
  TOWER_D,
  overlaidUser,
  scenarioP,
} from '../memberships/testing/overlaid-user.factory';
import {
  RecordingQueryBuilder,
  recordingQueryBuilder,
} from '../memberships/testing/recording-query-builder';

describe('AccessEventsService — overlay regression (GATE-8)', () => {
  const { person, as } = scenarioP();
  let recorder: RecordingQueryBuilder;
  let tenantRepository: { findOne: jest.Mock };
  let service: AccessEventsService;

  beforeEach(() => {
    recorder = recordingQueryBuilder();
    tenantRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        subscriptionPlan: { logRetentionDays: id === TOWER_B ? 7 : 90 },
      })),
    };
    service = new AccessEventsService(
      { createQueryBuilder: jest.fn(() => recorder.qb) } as never,
      tenantRepository as never,
    );
  });

  const tenantFilter = () => recorder.matching('event.tenant_id').map((c) => c.params?.tenantId);
  const residentFilter = () =>
    recorder.matching('event.resident_id').map((c) => c.params?.residentId);

  describe.each([
    [
      'findAll',
      (user: typeof as.A, tenantId?: string) => service.findAll({ tenantId } as never, user),
    ],
    ['getStats', (user: typeof as.A) => service.getStats(new Date(0), new Date(), user)],
    ['getLiveEvents', (user: typeof as.A) => service.getLiveEvents(user)],
    [
      'exportToCsv',
      (user: typeof as.A, tenantId?: string) => service.exportToCsv({ tenantId } as never, user),
    ],
  ])('%s', (_name, call) => {
    it('A context (building admin): all of A, ?tenantId= ignored', async () => {
      await call(as.A, TOWER_D);
      expect(tenantFilter()).toEqual([TOWER_A]);
      expect(residentFilter()).toEqual([]);
    });

    it('B context (resident): own events in B only, keyed on the person id', async () => {
      await call(as.B, TOWER_D);
      expect(tenantFilter()).toEqual([TOWER_B]);
      expect(residentFilter()).toEqual([person.id]);
    });

    it('C context (security): all of C', async () => {
      await call(as.C);
      expect(tenantFilter()).toEqual([TOWER_C]);
      expect(residentFilter()).toEqual([]);
    });

    it('Platform context: unscoped', async () => {
      await call(as.platform);
      expect(tenantFilter()).toEqual([]);
    });
  });

  it('the Platform context may narrow findAll with ?tenantId=', async () => {
    await service.findAll({ tenantId: TOWER_D } as never, as.platform);
    expect(tenantFilter()).toEqual([TOWER_D]);
  });

  it("log retention is the acting building's plan", async () => {
    await expect(service.getLogRetentionDays(as.B)).resolves.toBe(7);
    await expect(service.getLogRetentionDays(as.A)).resolves.toBe(90);
    await expect(service.getLogRetentionDays(as.platform)).resolves.toBe(9999);
  });

  it('a principal without a building context matches nothing (tenant_id = NULL)', async () => {
    const none = overlaidUser(person, { kind: 'none', problem: 'MEMBERSHIP_REQUIRED' });

    await service.findAll({} as never, none);

    // Only reachable on @ContextOptional routes, which the log is not; even
    // so the query is bound to NULL rather than left unscoped.
    expect(tenantFilter()).toEqual([null]);
  });
});
