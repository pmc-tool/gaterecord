import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { UserRole } from '@database/entities/user.entity';
import { assertBuildingContext, isPlatformContext } from './assert-building-context';
import { ContextKind } from './acting-user';

const TENANT = '11111111-1111-4111-8111-111111111111';

function bodyOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse() as Record<string, unknown>;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('assertBuildingContext', () => {
  it('returns the tenant in legacy mode (a plain gate_users row, no contextKind)', () => {
    expect(assertBuildingContext({ tenantId: TENANT, role: UserRole.BUILDING_ADMIN })).toBe(TENANT);
  });

  it('returns the tenant for an explicit legacy or membership context', () => {
    for (const contextKind of ['legacy', 'membership'] as ContextKind[]) {
      expect(
        assertBuildingContext({ tenantId: TENANT, role: UserRole.RESIDENT, contextKind }),
      ).toBe(TENANT);
    }
  });

  it("gives 409 MEMBERSHIP_REQUIRED for the 'none' context", () => {
    const error = thrown(() =>
      assertBuildingContext({
        tenantId: null,
        role: null,
        contextKind: 'none',
        contextProblemReason: 'AMBIGUOUS',
      }),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(bodyOf(error)).toMatchObject({
      statusCode: 409,
      code: 'MEMBERSHIP_REQUIRED',
      reason: 'AMBIGUOUS',
    });
  });

  it('gives 409 NO_MEMBERSHIPS for a legacy row without a tenant (never "unscoped")', () => {
    const error = thrown(() =>
      assertBuildingContext({ tenantId: null, role: UserRole.BUILDING_ADMIN }),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(bodyOf(error)).toMatchObject({ code: 'MEMBERSHIP_REQUIRED', reason: 'NO_MEMBERSHIPS' });
  });

  it('gives 409 for the platform context, even if a tenant id leaked onto it', () => {
    const error = thrown(() =>
      assertBuildingContext({
        tenantId: TENANT,
        role: UserRole.SUPER_ADMIN,
        contextKind: 'platform',
      }),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(bodyOf(error)).toMatchObject({ code: 'MEMBERSHIP_REQUIRED', reason: 'AMBIGUOUS' });
  });

  it("gives 403 MEMBERSHIP_INVALID (not 409) for a 'membership' context without a tenant", () => {
    const error = thrown(() =>
      assertBuildingContext({ tenantId: null, role: UserRole.RESIDENT, contextKind: 'membership' }),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(error)).toMatchObject({ statusCode: 403, code: 'MEMBERSHIP_INVALID' });
    expect(bodyOf(error)).not.toHaveProperty('reason');
  });

  it('gives 403 ROLE_NOT_ALLOWED_IN_BUILDING on a role mismatch', () => {
    const error = thrown(() =>
      assertBuildingContext(
        { tenantId: TENANT, role: UserRole.RESIDENT, contextKind: 'membership' },
        [UserRole.BUILDING_ADMIN],
      ),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(bodyOf(error)).toMatchObject({ code: 'ROLE_NOT_ALLOWED_IN_BUILDING' });
  });

  it('accepts a role in the list', () => {
    expect(
      assertBuildingContext(
        { tenantId: TENANT, role: UserRole.SECURITY, contextKind: 'membership' },
        [UserRole.BUILDING_ADMIN, UserRole.SECURITY],
      ),
    ).toBe(TENANT);
  });

  it('refuses a missing principal', () => {
    expect(thrown(() => assertBuildingContext(undefined))).toBeInstanceOf(ConflictException);
  });
});

describe('isPlatformContext', () => {
  it('is true for a super admin in the platform context', () => {
    expect(
      isPlatformContext({ role: UserRole.SUPER_ADMIN, tenantId: null, contextKind: 'platform' }),
    ).toBe(true);
  });

  it('is true for a legacy super_admin row (explicit or implicit legacy)', () => {
    expect(isPlatformContext({ role: UserRole.SUPER_ADMIN, tenantId: null })).toBe(true);
    expect(
      isPlatformContext({ role: UserRole.SUPER_ADMIN, tenantId: null, contextKind: 'legacy' }),
    ).toBe(true);
  });

  it('is false for a super admin acting inside one of their buildings', () => {
    expect(
      isPlatformContext({ role: UserRole.RESIDENT, tenantId: TENANT, contextKind: 'membership' }),
    ).toBe(false);
  });

  it('is false for everyone else', () => {
    expect(isPlatformContext({ role: UserRole.BUILDING_ADMIN, tenantId: TENANT })).toBe(false);
    expect(isPlatformContext({ role: null, tenantId: null, contextKind: 'none' })).toBe(false);
    expect(isPlatformContext(null)).toBe(false);
  });
});
