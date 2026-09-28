import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { CONTEXT_OPTIONAL_KEY } from '../decorators/context-optional.decorator';
import { SUBSCRIPTION_EXEMPT_KEY } from '../decorators/subscription-exempt.decorator';

/**
 * AUTH-6: the @ContextOptional route list is fixed by the contract. This reads
 * the Reflector metadata of EVERY controller under src/ and checks that the set
 * of context-optional routes is exactly the contract's, so a decorator added,
 * moved or dropped anywhere fails here.
 *
 * Two contract routes are created later by PPL-12 (GET /resident-join/requests
 * and DELETE /resident-join/request/:id). They are covered by the class-level
 * @ContextOptional on ResidentJoinController; until they exist they are simply
 * not in the route table, and once they do they must come out optional.
 */

/** Whole controllers that are context-optional (class-level decorator). */
const OPTIONAL_CONTROLLERS = [
  'MembershipsController',
  'SettingsController',
  'NotificationController',
  'FirmwareDownloadController',
];

/** Individually listed optional routes. Path params are normalised to ':param'. */
const OPTIONAL_ROUTES = [
  'POST /auth/logout-all',
  'POST /auth/me',
  'GET /onboarding/status',
  'POST /onboarding/building',
  'GET /resident-join/buildings',
  'GET /resident-join/buildings/:param/floors',
  'GET /resident-join/request',
  'POST /resident-join/request',
  'DELETE /resident-join/request',
  'GET /users/profile',
  'GET /users/profile/qr',
  'PATCH /users/profile',
  'POST /users/profile/upload-image',
  'GET /security-alerts/test/types',
];

/** Contract routes that PPL-12 adds; optional when present, allowed to be absent. */
const OPTIONAL_ROUTES_ADDED_LATER = [
  'GET /resident-join/requests',
  'DELETE /resident-join/request/:param',
];

/** Must stay context-REQUIRED (the contract names them explicitly). */
const REQUIRED_ROUTES = ['POST /resident-join/leave', 'PATCH /onboarding/building'];

interface Route {
  key: string;
  controller: string;
  optional: boolean;
  subscriptionExempt: boolean;
}

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

function joinPath(...parts: Array<string | string[] | undefined>): string {
  const segments = parts
    .map((part) => (Array.isArray(part) ? part[0] : part) ?? '')
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? ':param' : segment));
  return `/${segments.join('/')}`;
}

function collectRoutes(): Route[] {
  const reflector = new Reflector();
  const routes: Route[] = [];
  const srcDir = path.resolve(__dirname, '../..');

  for (const file of controllerFiles(srcDir)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, value);
      if (controllerPath === undefined) continue;

      const proto = (value as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;

        const targets = [handler as () => void, value as new () => object];
        routes.push({
          key: `${RequestMethod[method]} ${joinPath(controllerPath, Reflect.getMetadata(PATH_METADATA, handler))}`,
          controller: (value as { name: string }).name,
          optional: reflector.getAllAndOverride<boolean>(CONTEXT_OPTIONAL_KEY, targets) === true,
          subscriptionExempt:
            reflector.getAllAndOverride<boolean>(SUBSCRIPTION_EXEMPT_KEY, targets) === true,
        });
      }
    }
  }

  return routes;
}

describe('@ContextOptional route list (contract, AUTH-6)', () => {
  let routes: Route[];

  beforeAll(() => {
    routes = collectRoutes();
  });

  const keys = () => new Set(routes.map((route) => route.key));
  const find = (key: string) => routes.find((route) => route.key === key);

  it('finds the controllers (sanity)', () => {
    expect(routes.length).toBeGreaterThan(100);
    for (const name of [...OPTIONAL_CONTROLLERS, 'ResidentJoinController', 'AuthController']) {
      expect(routes.some((route) => route.controller === name)).toBe(true);
    }
  });

  it('every individually listed route exists', () => {
    const missing = [...OPTIONAL_ROUTES, ...REQUIRED_ROUTES].filter((key) => !keys().has(key));
    expect(missing).toEqual([]);
  });

  it('the optional routes are exactly the contract list', () => {
    const expected = new Set<string>([
      ...OPTIONAL_ROUTES,
      ...OPTIONAL_ROUTES_ADDED_LATER.filter((key) => keys().has(key)),
      ...routes
        .filter((route) => OPTIONAL_CONTROLLERS.includes(route.controller))
        .map((route) => route.key),
      ...routes
        .filter(
          (route) =>
            route.controller === 'ResidentJoinController' &&
            route.key !== 'POST /resident-join/leave',
        )
        .map((route) => route.key),
    ]);
    const actual = new Set(routes.filter((route) => route.optional).map((route) => route.key));

    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('keeps POST /resident-join/leave and PATCH /onboarding/building context-required', () => {
    for (const key of REQUIRED_ROUTES) {
      expect(find(key)?.optional).toBe(false);
    }
  });

  it('keeps POST /resident-join/leave subscription-exempt', () => {
    expect(find('POST /resident-join/leave')?.subscriptionExempt).toBe(true);
  });

  it('marks no platform (super admin) controller', () => {
    const platform = routes.filter(
      (route) => route.key.includes(' /admin/') || route.key.endsWith(' /admin'),
    );
    expect(platform.length).toBeGreaterThan(0);
    expect(platform.filter((route) => route.optional)).toEqual([]);
  });
});
