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
 * What a person may do in a building is a MEMBERSHIP (gate_memberships: one role
 * per building, possibly many buildings), and this service never creates, ends or
 * restores one. A brand-new identity gets a person row with ZERO memberships,
 * which is what sends them to onboarding (create a building, or ask to join one).
 * Its legacy role / tenant_id / unit columns hold the no-building sentinel
 * (LEGACY_SENTINEL: building_admin, no tenant, no unit), which only
 * MembershipsService's mirror rewrites afterwards. A person who ALREADY has a
 * gate row is returned as it is, so whatever an admin gave them (a resident
 * membership, say) is untouched by their first Keycloak login.
 *
 * gate_users.status is the platform-wide block: any value but ACTIVE refuses the
 * request here (401), in every building at once. A building's own
 * active/inactive belongs to the membership and is decided later, per request,
 * by the membership context.
 *
 * Security note: never log token contents. Only ids, and only at debug level.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User, UserStatus } from '@database/entities/user.entity';
import { GlobalUser, GlobalUserMeta } from '@database/entities/global-user.entity';
import { LEGACY_SENTINEL } from '../memberships/memberships.service';
import { ResidentRemovalService } from '../residents/resident-removal.service';

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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly residentRemovalService: ResidentRemovalService,
  ) {}

  /**
   * Resolves the PERSON (the `gate_users` row) behind a verified token, creating
   * rows in both tables as needed, and returns it without relations and without
   * passwordHash. It deliberately says nothing about which building the request
   * acts in: the caller (KeycloakStrategy, SocketAuthService) hands the person to
   * MembershipContextService, which loads that building in both modes.
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

    // STEP 3 — enforce status, exactly as JwtStrategy does. A non-ACTIVE
    // gate_users.status is the platform-wide block (a ban, or until the status
    // split the copy of a single membership's status): 401 in every building.
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User is not active');
    }

    // The acting context (and with it the building) is resolved by the caller.
    return user;
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
   *                     `gate_users.email` at (d).
   *   (c) deleted     — a soft-deleted row. (a) and (b) cannot see it, but its
   *                     `user_id` and `email` still hold the unique indexes, so
   *                     (d) would fail on every request. It is restored as a new
   *                     user with no building instead: deleting someone removes
   *                     them from gate management, it does not bar them from
   *                     starting over. Restoring never brings back a membership.
   *   (d) create      — a genuinely new person with zero memberships, who goes
   *                     to onboarding.
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

    // (c) deleted earlier.
    const deleted = await this.findDeleted(sub, email);
    if (deleted) {
      return this.restoreDeletedGateUser(deleted, sub);
    }

    // (d) create.
    return this.createGateUser(sub, email, payload);
  }

  /**
   * The soft-deleted row holding this identity's `user_id`, or failing that its
   * email. Only reached after (a) and (b) found nothing live.
   */
  private async findDeleted(sub: string, email: string): Promise<User | null> {
    const bySub = await this.userRepository.findOne({
      where: { userId: sub },
      withDeleted: true,
    });
    if (bySub) {
      return bySub;
    }

    // Oldest first, so that if legacy data ever holds two rows whose addresses
    // differ only in case, every request resolves to the same one.
    return this.userRepository
      .createQueryBuilder('user')
      .withDeleted()
      .where('LOWER(user.email) = :email', { email })
      .orderBy('user.createdAt', 'ASC')
      .addOrderBy('user.id', 'ASC')
      .getOne();
  }

  /**
   * Restores the row as a new user with no building, through
   * ResidentRemovalService.restoreDeletedUser (MembershipLifecycleService). That
   * ends any membership still live, never un-deletes an ended one, writes the
   * no-building sentinel and releases the cards, vehicles and passes the person
   * still held in those buildings. gate_users.status is kept, so a person who
   * was also suspended is still refused by step 3.
   */
  private async restoreDeletedGateUser(deleted: User, sub: string): Promise<User> {
    if (deleted.userId && deleted.userId !== sub) {
      // Same rule as (b): the address belongs to a different global identity.
      this.logger.warn(
        `Refusing to restore gate user ${deleted.id} for sub ${sub}: it is linked to a different identity`,
      );
      throw new UnauthorizedException('User not found');
    }

    // A no-op when a concurrent first request has already restored it.
    await this.residentRemovalService.restoreDeletedUser(deleted.id);

    const restored = await this.userRepository.findOne({ where: { id: deleted.id } });
    if (!restored) {
      throw new UnauthorizedException('User not found');
    }

    if (!restored.userId) {
      await this.userRepository.update(restored.id, { userId: sub });
      restored.userId = sub;
    }

    this.logger.log(`Restored deleted gate user ${restored.id} as a new user for ${sub}`);
    return restored;
  }

  /**
   * Case-insensitive email lookup.
   *
   * The fast path is a plain equality match on the lowercased address, which is
   * what every write path in this codebase stores and what the unique index can
   * serve. The fallback catches legacy rows written before that convention, which
   * would otherwise fall through to a create and hit the unique index. The unique
   * index is case-sensitive, so the fallback can match several rows ('A@x.com'
   * and 'a@X.com'); it takes the oldest, so adoption is deterministic rather than
   * whatever row Postgres happens to return first.
   */
  private async findByEmail(email: string): Promise<User | null> {
    const exact = await this.userRepository.findOne({ where: { email } });
    if (exact) {
      return exact;
    }

    return this.userRepository
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .orderBy('user.createdAt', 'ASC')
      .addOrderBy('user.id', 'ASC')
      .getOne();
  }

  /**
   * Creates the person row for a brand-new identity, and nothing else: no
   * membership. With zero memberships the person has no building to act in, so
   * the web offers onboarding (create a building, which makes them its admin,
   * or ask to join one as a resident). Every building role is added later by
   * MembershipsService, which also rewrites the legacy columns set here.
   *
   * Note `gate_users.id` is its own generated uuid — it is NOT the Keycloak sub,
   * which goes in `userId`. The legacy role / tenant_id / unit are the
   * no-building sentinel (LEGACY_SENTINEL), exactly what the mirror writes for
   * a person with zero memberships. status is ACTIVE: it is the platform ban,
   * not a building status.
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
          role: LEGACY_SENTINEL.role,
          status: UserStatus.ACTIVE,
          tenantId: LEGACY_SENTINEL.tenantId,
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
      // The saved entity still holds the hash it was created with; the person
      // handed to the request must look like a loaded row (select: false).
      Reflect.deleteProperty(created, 'passwordHash');
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
