/**
 * Identity provisioning — turns a verified Keycloak token into a local gate user.
 *
 * The upstream "account" service (backed by Keycloak) owns signup, login and every
 * password flow. gaterecord never authenticates; it only VERIFIES the RS256 token
 * (see ./strategies/keycloak.strategy.ts) and then calls this service to maintain
 * its own rows. Two tables are kept in step on every Keycloak-authenticated request:
 *
 *   1. `users`      (GlobalUser) — the platform-wide identity mirror. Its primary key
 *                                  IS the Keycloak `sub`. Also written in bulk by
 *                                  POST /user-sync; this service must merge with, not
 *                                  clobber, whatever that push already stored.
 *   2. `gate_users` (User)       — gaterecord's own row, with its OWN generated uuid.
 *                                  The Keycloak `sub` lives in its `userId` column.
 *
 * Role model: every user is a plain USER upstream — `profile_type` is never read here.
 * `gate_users.role` is gaterecord's own concept. A user with no gate row becomes
 * BUILDING_ADMIN with tenantId=null and must then complete onboarding; a user who
 * ALREADY has a gate row keeps its stored role, which is what stops an admin-created
 * resident being promoted to building_admin on their first Keycloak login.
 *
 * Security note: never log token contents. Only ids, and only at debug level.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { GlobalUser, GlobalUserMeta } from '@database/entities/global-user.entity';

/**
 * The identity claims this service consumes. Structurally compatible with
 * `KeycloakJwtPayload` from ./strategies/keycloak.strategy.ts, but declared
 * locally so the two files can evolve independently.
 */
export interface IdentityTokenPayload {
  /** Keycloak user id. Becomes `users.id` and `gate_users.user_id`. */
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
}

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/** Both `users.id` and `gate_users.user_id` are uuid columns. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cheap sanity check — the real authority on the address is Keycloak. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Injectable()
export class IdentityProvisioningService {
  private readonly logger = new Logger(IdentityProvisioningService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(GlobalUser)
    private readonly globalUserRepository: Repository<GlobalUser>,
  ) {}

  /**
   * Resolves the `gate_users` row to attach to the request, creating rows in both
   * tables as needed, and returns it with the `tenant` relation loaded so that
   * RolesGuard / TenantGuard / @CurrentUser see exactly the shape they already get
   * under the existing local 'jwt' strategy.
   */
  async provisionFromToken(payload: IdentityTokenPayload): Promise<User> {
    const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
    if (!sub || !UUID_PATTERN.test(sub)) {
      // A non-uuid subject can never match either uuid column, and handing it to
      // Postgres raises a driver error rather than a clean 401.
      throw new UnauthorizedException('User not found');
    }

    const email = this.resolveEmail(payload);
    if (!email) {
      // DELIBERATE REJECTION. `users.email` is NOT NULL and unique, so there is no
      // row we could legally write, and `gate_users.email` is likewise unique and
      // is the join key used to adopt pre-integration accounts (step 2b). A
      // synthetic placeholder would either collide or silently create an orphan
      // account that can never be reconciled with the real one. Failing closed is
      // the only safe option: fix it upstream by requiring an email in the realm.
      throw new UnauthorizedException('Token does not contain a usable email');
    }

    // STEP 1 — keep the global identity mirror in step. Self-healing: a user who
    // was never pushed through /user-sync still gets a mirror row on first login.
    await this.upsertGlobalUser(sub, email, payload);

    // STEP 2 — resolve the gaterecord row (link or create).
    const user = await this.resolveGateUser(sub, email, payload);

    // STEP 3 — enforce status, exactly as JwtStrategy does today.
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    // STEP 4 — return with the tenant relation loaded.
    return this.withTenant(user);
  }

  // ---------------------------------------------------------------------------
  // Step 1 — global `users` mirror
  // ---------------------------------------------------------------------------

  /**
   * Upserts the mirror row for `sub`.
   *
   * userMeta is MERGED, never replaced: /user-sync may already have written a much
   * richer upstream profile than the handful of claims a token carries, and losing
   * it on every login would be a silent data regression. Token claims win for the
   * keys they actually carry; absent claims leave the stored value untouched.
   *
   * A failure here is logged and swallowed rather than propagated. The token is
   * already cryptographically valid and `gate_users` — the row authorization
   * actually depends on — is written in step 2; refusing an otherwise legitimate
   * request because a mirror row could not be refreshed would trade a reporting
   * inconsistency for an outage.
   */
  private async upsertGlobalUser(
    sub: string,
    email: string,
    payload: IdentityTokenPayload,
  ): Promise<void> {
    const claims = this.identityClaims(payload, email);

    try {
      const existing = await this.globalUserRepository.findOne({ where: { id: sub } });

      const userMeta: GlobalUserMeta = {
        ...(existing?.userMeta ?? {}),
        ...claims,
      };

      await this.globalUserRepository.save(
        this.globalUserRepository.create({
          ...(existing ?? {}),
          id: sub,
          email,
          userMeta,
          isActive: true,
          syncedAt: new Date(),
        }),
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        // Either a concurrent first login for the same sub (harmless — the other
        // writer stored the same data), or this address is already held by a
        // DIFFERENT global id, which is an upstream data conflict this service
        // cannot resolve. Note it and let authorization continue on gate_users.
        this.logger.warn(
          `Global user mirror conflict for sub ${sub}; leaving the existing row in place`,
        );
        return;
      }

      this.logger.warn(
        `Failed to refresh the global user mirror for sub ${sub}: ${this.describe(error)}`,
      );
    }
  }

  /** The identity claims worth mirroring. Never the raw token, never credentials. */
  private identityClaims(payload: IdentityTokenPayload, email: string): GlobalUserMeta {
    const claims: GlobalUserMeta = { email };

    const optional: Array<[string, unknown]> = [
      ['given_name', payload.given_name],
      ['family_name', payload.family_name],
      ['name', payload.name],
      ['preferred_username', payload.preferred_username],
    ];

    for (const [key, value] of optional) {
      // Only overwrite from claims the token actually carries, so a sparse token
      // cannot erase a richer value written by /user-sync.
      if (typeof value === 'string' && value.trim()) {
        claims[key] = value.trim();
      }
    }

    return claims;
  }

  // ---------------------------------------------------------------------------
  // Step 2 — the `gate_users` row
  // ---------------------------------------------------------------------------

  /**
   * Lookup order is load-bearing:
   *   (a) by `userId` — already linked, the steady state.
   *   (b) by email    — a gaterecord account that predates the integration. It is
   *                     ADOPTED by stamping `userId`, never duplicated. Skipping
   *                     this would drive straight into the unique index on
   *                     `gate_users.email` at (c).
   *   (c) create      — a genuinely new user, provisioned as an unonboarded
   *                     building admin.
   */
  private async resolveGateUser(
    sub: string,
    email: string,
    payload: IdentityTokenPayload,
  ): Promise<User> {
    // (a) already linked.
    const linked = await this.userRepository.findOne({ where: { userId: sub } });
    if (linked) {
      return linked;
    }

    // (b) pre-existing account, matched on email.
    const byEmail = await this.findByEmail(email);
    if (byEmail) {
      if (byEmail.userId && byEmail.userId !== sub) {
        // The address is already claimed by a different global identity. Adopting
        // it would hand one person's building to another, so fail closed.
        this.logger.warn(
          `Refusing to link sub ${sub}: gate user ${byEmail.id} is already linked to a different identity`,
        );
        throw new UnauthorizedException('User not found');
      }

      await this.userRepository.update(byEmail.id, { userId: sub });
      byEmail.userId = sub;
      this.logger.log(`Linked existing gate user ${byEmail.id} to global identity ${sub}`);
      return byEmail;
    }

    // (c) create.
    return this.createGateUser(sub, email, payload);
  }

  /**
   * Case-insensitive email lookup.
   *
   * The fast path is a plain equality match on the lowercased address, which is
   * what every write path in this codebase stores and what the unique index can
   * serve. The fallback catches legacy rows written before that convention, which
   * would otherwise fall through to a create and hit the unique index.
   */
  private async findByEmail(email: string): Promise<User | null> {
    const exact = await this.userRepository.findOne({ where: { email } });
    if (exact) {
      return exact;
    }

    return this.userRepository
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .getOne();
  }

  /**
   * Creates the gate row for a brand-new user.
   *
   * Note `gate_users.id` is its own generated uuid — it is NOT the Keycloak sub,
   * which goes in `userId`. Role is BUILDING_ADMIN with tenantId=null: onboarding
   * (building name, address, plan) is what creates the Tenant.
   *
   * Concurrency: two simultaneous first requests for the same new user both reach
   * here, and one loses the race on the unique index over `email` / `user_id`.
   * That loser re-reads instead of failing, so the outcome is one row either way
   * and neither request 500s. Anything that is not a unique violation propagates.
   */
  private async createGateUser(
    sub: string,
    email: string,
    payload: IdentityTokenPayload,
  ): Promise<User> {
    const { firstName, lastName } = this.resolveName(payload, email);

    try {
      const created = await this.userRepository.save(
        this.userRepository.create({
          email,
          userId: sub,
          firstName,
          lastName,
          role: UserRole.BUILDING_ADMIN,
          status: UserStatus.ACTIVE,
          tenantId: null,
          qrCode: `GR-${uuidv4()}`,
          // `password_hash` is NOT NULL and the local HS256 login path still reads
          // it during this dual-accept phase. Keycloak owns this user's credentials,
          // so store the hash of a value nobody holds: bcrypt.compare can then only
          // ever return false, and the column stays non-null without opening a
          // password login for an account that has no local password.
          passwordHash: await bcrypt.hash(uuidv4(), 10),
          mustChangePassword: false,
        }),
      );

      this.logger.log(`Provisioned gate user ${created.id} for global identity ${sub}`);
      return created;
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      // Lost the race — the winner's row is now visible. Re-read in the same order.
      const raced =
        (await this.userRepository.findOne({ where: { userId: sub } })) ??
        (await this.findByEmail(email));

      if (raced) {
        this.logger.debug(`Concurrent provisioning for ${sub} resolved to gate user ${raced.id}`);
        return raced;
      }

      // A unique violation with nothing to re-read means the collision was on some
      // other unique column (a qrCode collision is astronomically unlikely, but
      // guessing here would be worse than surfacing it).
      throw error;
    }
  }

  /**
   * `first_name` / `last_name` are NOT NULL, and a token may carry none of the
   * name claims — so there is always a fallback. The email local part is a far
   * better placeholder in a resident list than an empty string.
   */
  private resolveName(
    payload: IdentityTokenPayload,
    email: string,
  ): { firstName: string; lastName: string } {
    const given = this.trimmed(payload.given_name);
    const family = this.trimmed(payload.family_name);

    if (given || family) {
      return { firstName: given || family, lastName: given ? family : '' };
    }

    const full = this.trimmed(payload.name);
    if (full) {
      const parts = full.split(/\s+/);
      return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
    }

    const username = this.trimmed(payload.preferred_username);
    return { firstName: username || email.split('@')[0], lastName: '' };
  }

  // ---------------------------------------------------------------------------
  // Step 4 — the shape consumers expect
  // ---------------------------------------------------------------------------

  /**
   * Reloads with the `tenant` relation. A freshly provisioned user has
   * tenantId=null and therefore a null tenant, which is the signal the onboarding
   * flow keys off.
   */
  private async withTenant(user: User): Promise<User> {
    const withRelation = await this.userRepository.findOne({
      where: { id: user.id },
      relations: ['tenant'],
    });

    if (!withRelation) {
      // Deleted between resolution and reload.
      throw new UnauthorizedException('User not found');
    }

    return withRelation;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Emails are stored lowercased everywhere in this codebase; normalizing here
   * keeps the mirror, the email lookup and any row we create mutually consistent.
   */
  private resolveEmail(payload: IdentityTokenPayload): string | null {
    const candidates = [payload?.email, payload?.preferred_username];

    for (const candidate of candidates) {
      const value = this.trimmed(candidate).toLowerCase();
      // `preferred_username` is frequently a bare username rather than an address,
      // so it is only usable as an email when it actually looks like one.
      if (value && EMAIL_PATTERN.test(value)) {
        return value;
      }
    }

    return null;
  }

  private trimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === PG_UNIQUE_VIOLATION
    );
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
