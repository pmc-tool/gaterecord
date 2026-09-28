/**
 * GATE-8 — overlay regression: gates scope by the OVERLAID principal (contract
 * C5). Person P is admin of A, resident of B and security of C, and also a
 * super admin; acting in one building must never reach another building's
 * gates, and the super-admin powers (listing everything, re-homing a gate)
 * belong to the Platform context only, not to P acting in a building.
 *
 * GATE-7 — a caller without a building context gets 409 MEMBERSHIP_REQUIRED.
 *
 * Pure unit tests with jest-mocked repositories (no database).
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { membershipErrorCodeOf } from '@common/context/membership-context.errors';
import { GateType } from '@database/entities/gate.entity';
import { GatesService } from './gates.service';
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

const gateIdOf = (tenantId: string) => `${tenantId.slice(0, 8)}-6666-4666-8666-666666666666`;

describe('GatesService — overlay regression (GATE-8)', () => {
  const { person, as } = scenarioP();
  let recorder: RecordingQueryBuilder;
  let gateRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    softDelete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let tenantRepository: { findOne: jest.Mock };
  let service: GatesService;

  beforeEach(() => {
    recorder = recordingQueryBuilder();
    gateRepository = {
      findOne: jest.fn(async ({ where }: { where: { id?: string } }) => {
        const tenantId = [TOWER_A, TOWER_B, TOWER_C, TOWER_D].find((t) => gateIdOf(t) === where.id);
        return tenantId
          ? {
              id: where.id,
              name: `Gate ${tenantId.slice(0, 1)}`,
              tenantId,
              tenant: { id: tenantId },
            }
          : null;
      }),
      save: jest.fn(async (g: unknown) => ({ id: 'new-gate', ...(g as object) })),
      create: jest.fn((g: unknown) => g),
      softDelete: jest.fn(),
      createQueryBuilder: jest.fn(() => recorder.qb),
    };
    tenantRepository = {
      findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => ({
        id,
        subscriptionPlan: { maxGates: 5 },
        gates: [],
      })),
    };
    service = new GatesService(
      gateRepository as never,
      { create: jest.fn((c: unknown) => c), save: jest.fn(async (c: unknown) => c) } as never,
      { save: jest.fn() } as never,
      tenantRepository as never,
      { find: jest.fn().mockResolvedValue([]), createQueryBuilder: jest.fn() } as never,
    );
  });

  describe('findAll', () => {
    it.each([
      ['A (building admin)', as.A, TOWER_A],
      ['B (resident)', as.B, TOWER_B],
      ['C (security)', as.C, TOWER_C],
    ])('P acting in %s lists that building only, ignoring ?tenantId=', async (_l, user, tenant) => {
      await service.findAll(user, { tenantId: TOWER_D });

      expect(recorder.matching('gate.tenant_id').map((c) => c.params?.tenantId)).toEqual([tenant]);
    });

    it('the Platform context lists everything, or the building it names', async () => {
      await service.findAll(as.platform);
      expect(recorder.matching('gate.tenant_id')).toHaveLength(0);

      await service.findAll(as.platform, { tenantId: TOWER_D });
      expect(recorder.matching('gate.tenant_id').map((c) => c.params?.tenantId)).toEqual([TOWER_D]);
    });

    it('no building context is 409 MEMBERSHIP_REQUIRED, never a 403 with that code', async () => {
      const none = overlaidUser(person, {
        kind: 'none',
        problem: 'MEMBERSHIP_REQUIRED',
        reason: 'NO_MEMBERSHIPS',
      });

      const error = await service.findAll(none).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
      expect(gateRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('by id (findOne / getHealth / remove)', () => {
    it.each([
      ['A', as.A],
      ['B', as.B],
      ['C', as.C],
    ])('P acting in %s only reaches its own building', async (label, user) => {
      for (const tenant of [TOWER_A, TOWER_B, TOWER_C]) {
        const own = tenant.startsWith(label.toLowerCase());
        const attempt = service.findOne(gateIdOf(tenant), user);
        if (own) {
          await expect(attempt).resolves.toEqual(expect.objectContaining({ tenantId: tenant }));
        } else {
          await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
        }
      }
      await expect(service.getHealth(gateIdOf(TOWER_D), user)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.remove(gateIdOf(TOWER_D), user)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('the Platform context reaches any building', async () => {
      await expect(service.findOne(gateIdOf(TOWER_D), as.platform)).resolves.toEqual(
        expect.objectContaining({ tenantId: TOWER_D }),
      );
    });
  });

  describe('super-admin powers belong to the Platform context', () => {
    it('P acting as admin of A cannot re-home a gate; the Platform context can', async () => {
      const kept = await service.update(gateIdOf(TOWER_A), { tenantId: TOWER_B }, as.A);
      expect(kept.tenantId).toBe(TOWER_A);

      const moved = await service.update(gateIdOf(TOWER_A), { tenantId: TOWER_B }, as.platform);
      expect(moved.tenantId).toBe(TOWER_B);
    });

    it('create: P acting in A creates in A, the Platform context must name the building', async () => {
      const dto = { name: 'North', type: GateType.PEDESTRIAN, tenantId: TOWER_B };

      const created = await service.create(dto as never, as.A);
      expect(created.tenantId).toBe(TOWER_A);

      await expect(
        service.create({ ...dto, tenantId: undefined } as never, as.platform),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const byPlatform = await service.create(dto as never, as.platform);
      expect(byPlatform.tenantId).toBe(TOWER_B);
    });

    it('create without a building context is 409 MEMBERSHIP_REQUIRED', async () => {
      const none = overlaidUser(person, { kind: 'none', problem: 'MEMBERSHIP_REQUIRED' });

      const error = await service
        .create({ name: 'x', type: GateType.PEDESTRIAN } as never, none)
        .catch((e: unknown) => e);

      expect(membershipErrorCodeOf(error)).toBe('MEMBERSHIP_REQUIRED');
    });
  });
});
