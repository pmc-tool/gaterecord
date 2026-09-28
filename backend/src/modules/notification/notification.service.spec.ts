/**
 * GATE-9 — notification recipients come from memberships, once per person.
 * GATE-10 — the bell follows the context the request acts in (A5).
 *
 * Pure unit tests: repositories are jest mocks over an in-memory world and the
 * recipient query runs the in-memory MembershipAccessService, so no database.
 *
 * Scenario: P is a super admin who is also admin of A, resident of B (unit 12B)
 * and security of C; P's legacy gate_users row names A.
 */
import { Logger } from '@nestjs/common';
import { FindOperator, FindOptionsWhere } from 'typeorm';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import {
  Notification,
  NotificationPriority,
  NotificationType,
} from '@database/entities/notification.entity';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationLens, notificationLensFor, whereForLens } from './notification-lens';
import {
  PERSON_P,
  TOWER_A,
  TOWER_B,
  TOWER_C,
  makeMembership,
  overlaidUser,
} from '../memberships/testing/overlaid-user.factory';
import {
  InMemoryMembershipAccessService,
  MembershipWorld,
  addPlainPerson,
  worldWithScenarioP,
} from '../memberships/testing/membership-world';

const SUPER_ADMIN_S = '11111111-aaaa-4aaa-8aaa-111111111111';
const ADMIN_OF_C = '22222222-aaaa-4aaa-8aaa-222222222222';
const BANNED_SECURITY_OF_C = '33333333-aaaa-4aaa-8aaa-333333333333';
const RESIDENT_OF_C = '44444444-aaaa-4aaa-8aaa-444444444444';

/** Evaluates a TypeORM where (object or OR-list) against a plain row. */
function matches(row: Record<string, unknown>, where: FindOptionsWhere<Notification>[] | object) {
  const branches = Array.isArray(where) ? where : [where];
  return branches.some((branch) =>
    Object.entries(branch).every(([key, expected]) => {
      if (expected instanceof FindOperator) {
        if (expected.type === 'isNull') return row[key] === null || row[key] === undefined;
        if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
        throw new Error(`Unsupported operator ${expected.type}`);
      }
      return row[key] === expected;
    }),
  );
}

describe('NotificationService', () => {
  let world: MembershipWorld;
  let rows: Array<Record<string, unknown>>;
  let userRepository: { find: jest.Mock; findOne: jest.Mock };
  let notificationRepository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findAndCount: jest.Mock;
    count: jest.Mock;
  };
  let emailService: { sendNotificationEmail: jest.Mock };
  let service: NotificationService;

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    ({ world } = worldWithScenarioP());
    addPlainPerson(world, SUPER_ADMIN_S, { role: UserRole.SUPER_ADMIN });
    for (const [id, role, status] of [
      [ADMIN_OF_C, UserRole.BUILDING_ADMIN, UserStatus.ACTIVE],
      [BANNED_SECURITY_OF_C, UserRole.SECURITY, UserStatus.INACTIVE],
      [RESIDENT_OF_C, UserRole.RESIDENT, UserStatus.ACTIVE],
    ] as const) {
      // Their legacy rows name Tower A: recipients must not be read from them.
      addPlainPerson(world, id, { role, status, tenantId: TOWER_A });
      world.addMembership(
        makeMembership(`${id.slice(0, 8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, id, TOWER_C, role),
      );
    }

    rows = [];
    userRepository = {
      find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...world.people.values()].filter((p) => !p.deletedAt && matches(p as never, where)),
      ),
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) =>
        world.livePerson(id),
      ),
    };
    notificationRepository = {
      create: jest.fn((n: Record<string, unknown>) => n),
      save: jest.fn(async (n: Record<string, unknown>) => {
        const saved = { id: `n-${rows.length + 1}`, isRead: false, ...n };
        rows.push(saved);
        return saved;
      }),
      update: jest.fn(),
      findAndCount: jest.fn(async ({ where }: { where: object }) => {
        const found = rows.filter((r) => matches(r, where));
        return [found, found.length];
      }),
      count: jest.fn(
        async ({ where }: { where: object }) => rows.filter((r) => matches(r, where)).length,
      ),
    };
    emailService = { sendNotificationEmail: jest.fn().mockResolvedValue(undefined) };

    service = new NotificationService(
      notificationRepository as never,
      userRepository as never,
      emailService as never,
      new InMemoryMembershipAccessService(world),
    );
  });

  const recipientsOf = () => rows.map((r) => r.userId).sort();
  const noTenantReads = () =>
    userRepository.find.mock.calls.every(
      ([options]: [{ where: Record<string, unknown> }]) => !('tenantId' in options.where),
    );

  describe('recipients (GATE-9)', () => {
    it("C's alert notifies P once, C's active admin and security, and each super admin once, all tagged C", async () => {
      await service.notifySecurityAlert(TOWER_C, 'Alert', 'Something happened', { alertId: 'a1' });

      expect(recipientsOf()).toEqual([ADMIN_OF_C, PERSON_P, SUPER_ADMIN_S].sort());
      // P is a super admin AND security of C: one notification.
      expect(rows.filter((r) => r.userId === PERSON_P)).toHaveLength(1);
      expect(rows.every((r) => r.tenantId === TOWER_C)).toBe(true);
      expect(rows.find((r) => r.userId === SUPER_ADMIN_S)?.metadata).toEqual(
        expect.objectContaining({ tenantId: TOWER_C, alertId: 'a1' }),
      );
      // Residents and banned people are not alert recipients.
      expect(recipientsOf()).not.toContain(RESIDENT_OF_C);
      expect(recipientsOf()).not.toContain(BANNED_SECURITY_OF_C);
      expect(noTenantReads()).toBe(true);
    });

    it('reaches the building role holders, not the people whose legacy row names the building', async () => {
      // All three C members have legacy rows naming Tower A.
      await service.createForTenantRoles(TOWER_A, [UserRole.BUILDING_ADMIN], {
        type: NotificationType.INFO,
        title: 'Hello A admins',
        message: 'Hi',
      });

      // Only P holds building_admin in A.
      expect(recipientsOf()).toEqual([PERSON_P]);
      expect(rows[0].tenantId).toBe(TOWER_A);
      expect(noTenantReads()).toBe(true);
    });

    it('createForUsers notifies each person once and skips people who are not active', async () => {
      await service.createForUsers([PERSON_P, PERSON_P, BANNED_SECURITY_OF_C, 'not-a-uuid'], {
        type: NotificationType.INFO,
        title: 'x',
        message: 'y',
      });

      expect(recipientsOf()).toEqual([PERSON_P]);
    });

    it('ignores super_admin as a building role and refuses a missing building', async () => {
      await service.createForTenantRoles(TOWER_C, [UserRole.SUPER_ADMIN], {
        type: NotificationType.INFO,
        title: 'x',
        message: 'y',
      });
      await service.createForTenantRoles(null as unknown as string, [UserRole.BUILDING_ADMIN], {
        type: NotificationType.INFO,
        title: 'x',
        message: 'y',
      });

      expect(rows).toHaveLength(0);
    });

    it('createForSuperAdmins skips excluded ids', async () => {
      await service.createForSuperAdmins(
        { type: NotificationType.INFO, title: 'x', message: 'y', tenantId: TOWER_B },
        [PERSON_P],
      );

      expect(recipientsOf()).toEqual([SUPER_ADMIN_S]);
      expect(rows[0].tenantId).toBe(TOWER_B);
    });

    it('notifyVisitorEntry tags the building it is given', async () => {
      await service.notifyVisitorEntry(PERSON_P, TOWER_B, 'Guest', 'Gate B', {}, false);

      expect(rows).toEqual([
        expect.objectContaining({
          userId: PERSON_P,
          tenantId: TOWER_B,
          type: NotificationType.VISITOR_ENTRY,
          priority: NotificationPriority.NORMAL,
        }),
      ]);
    });
  });

  describe('the bell follows the context (GATE-10)', () => {
    const seed = () => {
      rows.push(
        { id: 'na', userId: PERSON_P, tenantId: TOWER_A, isRead: false },
        { id: 'nb', userId: PERSON_P, tenantId: TOWER_B, isRead: false },
        { id: 'nc', userId: PERSON_P, tenantId: TOWER_C, isRead: true },
        { id: 'np', userId: PERSON_P, tenantId: null, isRead: false },
        { id: 'other', userId: SUPER_ADMIN_S, tenantId: TOWER_B, isRead: false },
      );
    };
    const ids = (list: Array<{ id?: unknown }>) => list.map((n) => n.id).sort();

    it('in the B context shows only B and personal items', async () => {
      seed();
      const { as } = worldWithScenarioP();
      const lens = notificationLensFor(as.B);

      const { notifications, total } = await service.findForUser(lens, {});

      expect(ids(notifications)).toEqual(['nb', 'np']);
      expect(total).toBe(2);
      await expect(service.getCountsForUser(lens)).resolves.toEqual({ total: 2, unread: 2 });
    });

    it('the Platform context shows everything of the person', async () => {
      seed();
      const { as } = worldWithScenarioP();

      const { notifications } = await service.findForUser(notificationLensFor(as.platform), {});

      expect(ids(notifications)).toEqual(['na', 'nb', 'nc', 'np']);
    });

    it('with no context shows personal items only', async () => {
      seed();
      const none = overlaidUser(world.people.get(PERSON_P) as User, {
        kind: 'none',
        problem: 'MEMBERSHIP_INVALID',
      });

      const { notifications } = await service.findForUser(notificationLensFor(none), {});

      expect(ids(notifications)).toEqual(['np']);
    });

    it('legacy mode: a single-building person sees their building and personal items', async () => {
      seed();
      const legacyRowOfP = { ...world.people.get(PERSON_P), role: UserRole.BUILDING_ADMIN } as User;

      const { notifications } = await service.findForUser(notificationLensFor(legacyRowOfP), {});

      expect(ids(notifications)).toEqual(['na', 'np']);
    });

    it('filters (isRead) apply inside the lens', async () => {
      seed();
      const { as } = worldWithScenarioP();

      const { notifications } = await service.findForUser(notificationLensFor(as.C), {
        isRead: false,
      });

      expect(ids(notifications)).toEqual(['np']);
    });

    it('mark-all-read only touches what the lens shows', async () => {
      const lens: NotificationLens = { userId: PERSON_P, tenantId: TOWER_B, platform: false };

      await service.markAllAsRead(lens);

      expect(notificationRepository.update).toHaveBeenCalledWith(
        whereForLens(lens, { isRead: false }),
        expect.objectContaining({ isRead: true }),
      );
      const where = notificationRepository.update.mock.calls[0][0];
      expect(matches({ userId: PERSON_P, tenantId: TOWER_A, isRead: false }, where)).toBe(false);
      expect(matches({ userId: PERSON_P, tenantId: TOWER_B, isRead: false }, where)).toBe(true);
      expect(matches({ userId: PERSON_P, tenantId: null, isRead: false }, where)).toBe(true);
    });
  });
});

describe('notificationLensFor', () => {
  const { person, as } = worldWithScenarioP();

  it.each([
    ['membership B', as.B, { tenantId: TOWER_B, platform: false }],
    ['membership C', as.C, { tenantId: TOWER_C, platform: false }],
    ['platform', as.platform, { tenantId: null, platform: true }],
    [
      'no context',
      overlaidUser(person, { kind: 'none', problem: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' }),
      { tenantId: null, platform: false },
    ],
    ['legacy super admin row', { ...person } as User, { tenantId: null, platform: true }],
    [
      'legacy building admin row',
      { ...person, role: UserRole.BUILDING_ADMIN } as User,
      { tenantId: TOWER_A, platform: false },
    ],
    [
      'legacy tenantless row',
      { ...person, role: UserRole.BUILDING_ADMIN, tenantId: null } as User,
      { tenantId: null, platform: false },
    ],
  ])('%s', (_label, user, expected) => {
    expect(notificationLensFor(user)).toEqual({ userId: person.id, ...expected });
  });
});

describe('NotificationController', () => {
  it('passes the lens of the acting principal to the service', async () => {
    const { as } = worldWithScenarioP();
    const notificationService = {
      findForUser: jest.fn().mockResolvedValue({ notifications: [], total: 0 }),
      getCountsForUser: jest.fn().mockResolvedValue({ total: 0, unread: 0 }),
      markAllAsRead: jest.fn(),
    };
    const controller = new NotificationController(notificationService as never);

    await controller.findAll(as.B, {});
    await controller.findUnread(as.B);
    await controller.getCounts(as.C);
    await controller.markAllAsRead(as.platform);

    const lensB = { userId: PERSON_P, tenantId: TOWER_B, platform: false };
    expect(notificationService.findForUser).toHaveBeenNthCalledWith(1, lensB, {});
    expect(notificationService.findForUser).toHaveBeenNthCalledWith(2, lensB, {
      isRead: false,
      limit: '10',
    });
    expect(notificationService.getCountsForUser).toHaveBeenCalledWith({
      userId: PERSON_P,
      tenantId: TOWER_C,
      platform: false,
    });
    expect(notificationService.markAllAsRead).toHaveBeenCalledWith({
      userId: PERSON_P,
      tenantId: null,
      platform: true,
    });
  });
});
