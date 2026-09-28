import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User, UserRole } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { buildActingUser } from '../../modules/memberships/membership-context.service';
import { Roles } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/**
 * AUTH-8: RolesGuard is unchanged; this pins what it now means. It reads the
 * OVERLAID role (the role held in the building the request acts in) and a null
 * role (the 'none' context) matches nothing.
 */
class Routes {
  @Roles(UserRole.BUILDING_ADMIN) adminOnly() {}
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN) adminOrSuper() {}
  open() {}
}

function contextFor(method: keyof Routes, user: unknown): ExecutionContext {
  return {
    getHandler: () => Routes.prototype[method],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const TOWER_A = Object.assign(new Tenant(), { id: 'aaaaaaaa-0000-4000-8000-00000000000a' });
const TOWER_B = Object.assign(new Tenant(), { id: 'bbbbbbbb-0000-4000-8000-00000000000b' });

// One person: gate_users mirrors "admin of A"; the request acts as resident of B.
const person = Object.assign(new User(), {
  id: 'x',
  role: UserRole.BUILDING_ADMIN,
  tenantId: TOWER_A.id,
});

function actingAs(role: UserRole | null, tenant: Tenant | null) {
  return buildActingUser(person, {
    contextKind: role === null ? 'none' : role === UserRole.SUPER_ADMIN ? 'platform' : 'membership',
    role,
    tenantId: tenant?.id ?? null,
    tenant,
    unit: null,
    isSuperAdmin: false,
  });
}

describe('RolesGuard (AUTH-8)', () => {
  const guard = new RolesGuard(new Reflector());

  it('uses the role of the building the request acts in, not the gate_users row', () => {
    expect(
      guard.canActivate(contextFor('adminOnly', actingAs(UserRole.BUILDING_ADMIN, TOWER_A))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(contextFor('adminOnly', actingAs(UserRole.RESIDENT, TOWER_B))),
    ).toThrow(ForbiddenException);
  });

  it('denies a null role (no context chosen)', () => {
    expect(() => guard.canActivate(contextFor('adminOrSuper', actingAs(null, null)))).toThrow(
      'Insufficient permissions',
    );
  });

  it('lets the Platform context through super-admin routes', () => {
    expect(
      guard.canActivate(contextFor('adminOrSuper', actingAs(UserRole.SUPER_ADMIN, null))),
    ).toBe(true);
  });

  it('allows routes without @Roles and still refuses a missing user', () => {
    expect(guard.canActivate(contextFor('open', undefined))).toBe(true);
    expect(() => guard.canActivate(contextFor('adminOnly', undefined))).toThrow('Access denied');
  });

  it('reads a legacy gate_users row exactly as before', () => {
    expect(guard.canActivate(contextFor('adminOnly', person))).toBe(true);
  });
});
