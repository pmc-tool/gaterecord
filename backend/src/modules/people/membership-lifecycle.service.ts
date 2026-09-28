import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In, Not, QueryFailedError } from 'typeorm';

import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import {
  Membership,
  MembershipRole,
  MembershipStatus,
  isMembershipRole,
} from '@database/entities/membership.entity';
import { Notification } from '@database/entities/notification.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import {
  RegistrationType,
  VisitorPass,
  VisitorPassStatus,
} from '@database/entities/visitor-pass.entity';
import { isUniqueViolation } from '@database/pg-errors';
import { isUuid } from '@common/context/acting-user';
import { BuildingContextSubject, isPlatformContext } from '@common/context/assert-building-context';
import {
  accountSuspended,
  lastBuildingAdmin,
  membershipExists,
  multiMembershipDisabled,
  tenantRequired,
} from '@common/context/membership-context.errors';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import {
  AccountIdentityClient,
  ProvisionedIdentity,
} from '../account-identity/account-identity.client';
import { LEGACY_SENTINEL, MembershipsService } from '../memberships/memberships.service';
import { EmailService } from '../notification/email.service';
import { assertSeatAvailable } from './seat-limit';

/** Why a membership ended. Logged; lets later tooling tell the cases apart. */
export type MembershipRemovalReason =
  /** An admin of the building (or a super admin) removed the person. */
  | 'removed_by_admin'
  /** The person left the building themselves. */
  | 'left_building'
  /** A super admin removed the person from the whole platform. */
  | 'platform_removal';

export interface AddPersonToTenantInput {
  /** Matched case-insensitively; stored lowercased for a new person. */
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  /**
   * Passed through to the account service, and used only when it creates a
   * brand-new identity. An existing account's password is never touched.
   */
  password?: string;
  /** The building. A missing value is 400 TENANT_REQUIRED. */
  tenantId: string | null | undefined;
  /** A building role (MEMBERSHIP_ROLES); anything else is 400. */
  role: UserRole;
  unit?: string | null;
  /** The membership's status. Default ACTIVE. */
  status?: MembershipStatus;
  /** Who is adding them, named in the email. Read, never written. */
  actor?: Pick<User, 'firstName' | 'lastName'> | null;
  /** Refuse (403) when the building has no subscription plan: the residents rule. */
  requirePlan?: boolean;
}

export interface AddPersonToTenantResult {
  /** The live person row, without its password hash. */
  person: User;
  /** The new membership, with `user` and `tenant` set, ready for toMembershipRow(). */
  membership: Membership;
  tenant: Tenant;
  /**
   * True when the email already had an account (a gate person, or a platform
   * identity the account service already knew), so no credentials were issued
   * and the 'added to building' email went out instead.
   */
  existingAccount: boolean;
}

export interface RemoveMembershipInput {
  /** gate_users.id of the person. */
  userId: string;
  /** The building to remove them from. A missing value is 400 TENANT_REQUIRED. */
  tenantId: string | null | undefined;
  /** When given, the membership must have this role (else 409, nothing changes). */
  expectedRole?: MembershipRole | null;
  reason: MembershipRemovalReason;
  /**
   * Refuse with 409 LAST_BUILDING_ADMIN when this is the building's last active
   * admin. The tenant row is locked first, so two concurrent removals of the
   * last two admins cannot both pass. Default false.
   */
  protectLastAdmin?: boolean;
}

/** What a removal released in the building it concerned. */
export interface ReleasedAssets {
  personalCards: number;
  vehicles: number;
  vehicleCards: number;
  passesCancelled: number;
  notifications: number;
}

export interface MembershipRemovalResult {
  /** The ended membership (deletedAt set). */
  membership: Membership;
  released: ReleasedAssets;
}

export interface PlatformRemovalResult {
  personId: string;
  membershipsEnded: number;
  joinRequestsCancelled: number;
  /** Summed over every building the person was released from. */
  released: ReleasedAssets;
}

/** Who may remove a person from the platform: a super admin in the Platform context. */
export type PlatformActor = BuildingContextSubject & { id: string };

/** The values a brand-new person row is created from. */
export interface NewPersonValues {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  /** The Keycloak sub from the account service, or null when there is none. */
  userId: string | null;
  /** Precomputed so the bcrypt work happens outside the transaction; generated when omitted. */
  passwordHash?: string;
  mustChangePassword?: boolean;
}

interface AddAttempt {
  email: string;
  tenantId: string;
  role: MembershipRole;
  status?: MembershipStatus;
  unit?: string | null;
  input: AddPersonToTenantInput;
  /** The account service's answer; null when the email already had a gate person. */
  identity: ProvisionedIdentity | null;
  passwordHash?: string;
}

interface AddOutcome {
  person: User;
  membership: Membership;
  tenant: Tenant;
}

function noAssets(): ReleasedAssets {
  return { personalCards: 0, vehicles: 0, vehicleCards: 0, passesCancelled: 0, notifications: 0 };
}

function addAssets(total: ReleasedAssets, more: ReleasedAssets): ReleasedAssets {
  total.personalCards += more.personalCards;
  total.vehicles += more.vehicles;
  total.vehicleCards += more.vehicleCards;
  total.passesCancelled += more.passesCancelled;
  total.notifications += more.notifications;
  return total;
}

function describeAssets(released: ReleasedAssets): string {
  return (
    `${released.personalCards} personal card(s), ${released.vehicles} vehicle(s) and ` +
    `${released.vehicleCards} vehicle card(s) released, ${released.passesCancelled} pass(es) ` +
    `cancelled, ${released.notifications} notification(s) deleted`
  );
}

function fullName(person: Pick<User, 'firstName' | 'lastName'> | null | undefined): string {
  return `${person?.firstName ?? ''} ${person?.lastName ?? ''}`.trim();
}

/**
 * A unique violation on gate_users: someone else created this person (a
 * concurrent add of the same email, or the person signing in for the first
 * time) between our lookup and our insert. Membership duplicates never get here:
 * MembershipsService.add turns those into 409 MEMBERSHIP_EXISTS.
 */
function isPersonRowConflict(error: unknown): boolean {
  if (!isUniqueViolation(error)) {
    return false;
  }
  const table = (error as QueryFailedError & { driverError?: { table?: string } }).driverError
    ?.table;
  return table === undefined || table === 'gate_users';
}

/**
 * The people lifecycle on top of memberships: adding someone to a building,
 * taking them out of one, removing them from the platform, and bringing back a
 * soft-deleted person. The business rules live here (seats, bans, account
 * provisioning, emails, which assets a building keeps); every membership write
 * goes through MembershipsService, which keeps the rows and the legacy
 * gate_users mirror consistent. Nothing here writes gate_memberships directly,
 * and nothing writes gate_users.tenant_id / role / unit except the restore of a
 * super admin (see restoreInTransaction).
 *
 * Lock order is the one MembershipsService uses: tenant, then person.
 *
 * Deliberately independent of AuthModule: identity provisioning (AuthModule)
 * reaches restoreDeletedPerson through ResidentRemovalService, so an import in
 * the other direction would be a cycle.
 */
@Injectable()
export class MembershipLifecycleService {
  private readonly logger = new Logger(MembershipLifecycleService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly membershipsService: MembershipsService,
    private readonly accountIdentityClient: AccountIdentityClient,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  // ============ Adding ============

  /**
   * Gives the person with this email a role in a building, creating the person
   * (and their platform identity) only when the email is new.
   *
   *   - Existing person (live or soft-deleted, email matched case-insensitively):
   *     no account-service call, no password change; a soft-deleted row is
   *     restored first (with nothing of its old access). They get the 'added to
   *     building' email and existingAccount=true.
   *   - New email: the account service creates (or returns) the identity OUTSIDE
   *     the transaction, then the person row (QR code, sentinel legacy columns)
   *     and the membership are written in one transaction. A brand-new identity
   *     gets the credentials email; an identity the account service already knew
   *     gets the 'added' email.
   *
   * Refusals, all checked BEFORE any identity is provisioned:
   *   - 409 MEMBERSHIP_EXISTS {role}: already has a role in this building;
   *   - 403 ACCOUNT_SUSPENDED: gate_users.status is not active (a ban, or the
   *     single-membership status copy, which blocks sign-in all the same);
   *   - 409 MULTI_MEMBERSHIP_DISABLED: another building already, while
   *     GATE_MEMBERSHIP_CONTEXT is off;
   *   - 403 (legacy wording): no free seat, or no plan when requirePlan.
   * The seat is checked again under the tenant lock before the insert.
   *
   * A unique violation on gate_users (someone created the person concurrently)
   * is retried once, as the existing-person case.
   */
  async addPersonToTenant(input: AddPersonToTenantInput): Promise<AddPersonToTenantResult> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    if (!isMembershipRole(input.role)) {
      throw new BadRequestException(
        `'${String(input.role)}' is not a role a person can hold in a building.`,
      );
    }
    if (!input.tenantId) {
      throw tenantRequired();
    }
    if (!isUuid(input.tenantId)) {
      throw new NotFoundException('Tenant not found');
    }

    const attempt: AddAttempt = {
      email,
      tenantId: input.tenantId.toLowerCase(),
      role: input.role,
      status: input.status,
      unit: input.unit,
      input,
      identity: null,
    };

    // Pre-checks outside any transaction, so a request that is going to be
    // refused never creates a platform identity (and its credentials).
    const known = await this.findPersonByEmail(email);
    if (known) {
      await this.assertCanBeAdded(known, attempt.tenantId);
    }
    await assertSeatAvailable(this.dataSource.manager, attempt.tenantId, {
      requirePlan: input.requirePlan,
      lock: false,
    });

    // ORDER MATTERS, as it always has: the platform identity first, the local
    // row second. If this call fails nothing local is written; if the local
    // write fails afterwards, the identity is reconciled by email on the next
    // attempt (the account endpoint is idempotent by email). Only for emails
    // with no gate person: an existing person already has their identity, and
    // calling the account service again must never reset their password.
    if (!known) {
      attempt.identity = await this.accountIdentityClient.provisionUser({
        email,
        first_name: input.firstName,
        last_name: input.lastName,
        phone: input.phone ?? undefined,
        password: input.password,
        // gaterecord sends its own branded email below: it knows the building,
        // the role and who added the person, which the account service does not.
        sendEmail: false,
      });
      if (!attempt.identity.created) {
        this.logger.log(
          'Platform identity already existed for this email; linking the new gate person to it.',
        );
      }
      // NOT NULL column kept satisfied with an unguessable value nobody holds;
      // authentication happens at the account service. Hashed here, not inside
      // the transaction, so the tenant lock is never held across bcrypt.
      attempt.passwordHash = await bcrypt.hash(randomUUID(), 10);
    }

    let outcome: AddOutcome;
    try {
      outcome = await this.dataSource.transaction((m) => this.addInTransaction(m, attempt));
    } catch (error) {
      if (!isPersonRowConflict(error)) {
        throw error;
      }
      // The failed transaction is gone (a 23505 aborts it); start a fresh one,
      // in which the lookup now finds the row the other writer created.
      this.logger.warn(
        `Person for ${email} was created concurrently; retrying the add as an existing person.`,
      );
      outcome = await this.dataSource.transaction((m) => this.addInTransaction(m, attempt));
    }

    const newCredentials =
      attempt.identity?.created && attempt.identity.password ? attempt.identity.password : null;
    this.sendAddedEmail(outcome, attempt.role, newCredentials, input.actor);

    return {
      person: outcome.person,
      membership: outcome.membership,
      tenant: outcome.tenant,
      existingAccount: !attempt.identity?.created,
    };
  }

  /**
   * Inserts a brand-new person: a fresh personal QR code, ACTIVE (gate_users.status
   * is the platform ban, not the building status) and the sentinel legacy
   * columns (no building). The caller adds the membership next, in the same
   * transaction, which re-mirrors the legacy columns.
   *
   * Public for the other creators of people (tenant creation, paid signup), so
   * every new person row looks the same.
   */
  async insertPerson(manager: EntityManager, values: NewPersonValues): Promise<User> {
    const passwordHash = values.passwordHash ?? (await bcrypt.hash(randomUUID(), 10));

    const saved = await manager.save(
      manager.create(User, {
        email: values.email.trim().toLowerCase(),
        firstName: values.firstName,
        lastName: values.lastName,
        ...(values.phone ? { phone: values.phone } : {}),
        userId: values.userId,
        passwordHash,
        qrCode: `GR-${randomUUID()}`,
        status: UserStatus.ACTIVE,
        role: LEGACY_SENTINEL.role,
        tenantId: LEGACY_SENTINEL.tenantId,
        mustChangePassword: values.mustChangePassword ?? false,
      }),
    );

    // The in-memory entity still carries the hash it was created with.
    delete (saved as Partial<User>).passwordHash;
    return saved;
  }

  /**
   * The person holding this email, live or soft-deleted (live first, then the
   * oldest), or null. Case-insensitive, like identity provisioning, because
   * legacy rows may differ from the lowercased address only in case.
   */
  async findPersonByEmail(
    email: string,
    manager?: EntityManager,
    options: { lock?: boolean } = {},
  ): Promise<User | null> {
    const normalized = (email ?? '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const query = this.em(manager)
      .createQueryBuilder(User, 'person')
      .withDeleted()
      .where('LOWER(person.email) = :email', { email: normalized })
      .orderBy('person.deletedAt', 'ASC', 'NULLS FIRST')
      .addOrderBy('person.createdAt', 'ASC')
      .addOrderBy('person.id', 'ASC');
    if (options.lock) {
      query.setLock('pessimistic_write');
    }
    return query.getOne();
  }

  // ============ Removing ============

  /**
   * Takes a person out of ONE building, in one transaction:
   *   - deletes their personal RFID cards in that building;
   *   - deletes their vehicles in that building and those vehicles' cards;
   *   - cancels the open passes they created (self-service) or that name them
   *     as the resident being visited, in that building;
   *   - deletes their notifications of that building;
   *   - ends the membership through MembershipsService.remove(), which
   *     re-mirrors the legacy columns and lifts a mirrored status when this was
   *     their last building.
   *
   * Every delete and update is scoped by tenant_id, so what the person holds in
   * their other buildings is untouched. gate_users is never written here.
   *
   * 404 when the person does not exist; 409 when they have no membership in the
   * building (or not the expected role); 409 LAST_BUILDING_ADMIN with
   * protectLastAdmin. Joins the caller's transaction when given one.
   */
  async removeMembership(
    input: RemoveMembershipInput,
    manager?: EntityManager,
  ): Promise<MembershipRemovalResult> {
    const { userId, tenantId, expectedRole, reason, protectLastAdmin = false } = input;
    if (!tenantId) {
      throw tenantRequired();
    }
    if (!isUuid(userId)) {
      throw new NotFoundException(this.personNotFoundMessage(expectedRole));
    }
    if (!isUuid(tenantId)) {
      throw new ConflictException(this.notAMemberMessage(expectedRole));
    }

    return this.inTransaction(manager, async (m) => {
      // Lock order: tenant, then person. The tenant lock is only needed to count
      // the remaining admins safely.
      if (protectLastAdmin) {
        await m.findOne(Tenant, {
          where: { id: tenantId },
          withDeleted: true,
          lock: { mode: 'pessimistic_write' },
        });
      }

      // Locked so a concurrent removal, or an admin editing the person, waits
      // for this one instead of writing over half of it.
      const person = await this.lockPerson(m, userId, true);
      if (!person) {
        throw new NotFoundException(this.personNotFoundMessage(expectedRole));
      }

      const membership = await this.membershipsService.findLive(person.id, tenantId, m);
      if (!membership || (expectedRole && membership.role !== expectedRole)) {
        throw new ConflictException(this.notAMemberMessage(expectedRole));
      }

      if (protectLastAdmin) {
        await this.assertNotLastAdmin(m, membership);
      }

      const released = await this.releaseTenantAssets(m, person.id, membership.tenantId);
      const ended = await this.membershipsService.remove(membership.id, m);

      this.logger.log(
        `Removed person ${person.id} (${membership.role}) from building ${membership.tenantId} ` +
          `[${reason}]: ${describeAssets(released)}`,
      );

      return { membership: ended, released };
    });
  }

  /**
   * Removes a person from the whole platform: every membership is ended through
   * removeMembership (so each building's assets are released), pending join
   * requests are cancelled, and the person row is soft-deleted. If they sign in
   * again later they come back as a new user with no building (see
   * restoreDeletedPerson).
   *
   * Only a super admin acting in the Platform context, and only with the
   * explicit scope 'platform': removing a person from ONE building is
   * removeMembership, and a missing scope must never widen into this.
   */
  async removePersonFromPlatform(
    personId: string,
    options: { actor: PlatformActor; scope: string | null | undefined },
  ): Promise<PlatformRemovalResult> {
    if (options.scope !== 'platform') {
      throw new BadRequestException(
        'Removing a person from the whole platform needs scope=platform.',
      );
    }
    if (!isPlatformContext(options.actor)) {
      throw new ForbiddenException('Only a platform admin can remove a person from the platform.');
    }
    if (options.actor.id === personId) {
      throw new ForbiddenException('Cannot delete yourself');
    }
    if (!isUuid(personId)) {
      throw new NotFoundException('Person not found');
    }

    return this.dataSource.transaction(async (m) => {
      // Pending join requests first: cancelling them row-locks them BEFORE the
      // person, the global order (join request -> tenant -> person) that
      // approving a request also takes. Person first would deadlock with a
      // concurrent approve. An approve that got in first commits its
      // membership, which is ended below; one that comes later finds its
      // request cancelled. An unknown person rolls this back with the 404.
      const cancelled = await m.update(
        BuildingJoinRequest,
        { userId: personId, status: JoinRequestStatus.PENDING },
        { status: JoinRequestStatus.CANCELLED },
      );

      const person = await this.lockPerson(m, personId, false);
      if (!person) {
        throw new NotFoundException('Person not found');
      }

      const legacyTenantId = person.tenantId;
      const live = await this.membershipsService.listLiveForUser(person.id, m);
      const released = noAssets();

      for (const membership of [...live].sort((a, b) => a.tenantId.localeCompare(b.tenantId))) {
        const result = await this.removeMembership(
          { userId: person.id, tenantId: membership.tenantId, reason: 'platform_removal' },
          m,
        );
        addAssets(released, result.released);
      }

      // A building the legacy column still names without a membership (data
      // written by an older backend): release it too, so nothing stays usable.
      if (isUuid(legacyTenantId) && !live.some((x) => x.tenantId === legacyTenantId)) {
        addAssets(released, await this.releaseTenantAssets(m, person.id, legacyTenantId));
      }

      await m.softDelete(User, { id: person.id });

      this.logger.log(
        `Removed person ${person.id} from the platform: ${live.length} membership(s) ended, ` +
          `${cancelled.affected ?? 0} join request(s) cancelled, ${describeAssets(released)}`,
      );

      return {
        personId: person.id,
        membershipsEnded: live.length,
        joinRequestsCancelled: cancelled.affected ?? 0,
        released,
      };
    });
  }

  // ============ Restoring ============

  /**
   * Brings back a soft-deleted person as a new user with NO building. Identity
   * provisioning calls this (through ResidentRemovalService.restoreDeletedUser)
   * when such a person signs in again; without it every request they make
   * fails, because the hidden row still holds their user_id and email.
   *
   * Restoring can never hand back old access: any membership still live is
   * ended, and whatever the person held in those buildings, or in the building
   * the legacy column still names, is released exactly as on removal. Their
   * status is kept, so an account that was also deactivated stays blocked.
   *
   * Returns false (and does nothing) when the person is gone for good or was
   * restored a moment ago by a concurrent sign-in: the first request of a
   * session fires several at once.
   */
  async restoreDeletedPerson(personId: string, manager?: EntityManager): Promise<boolean> {
    if (!isUuid(personId)) {
      return false;
    }

    return this.inTransaction(manager, async (m) => {
      const person = await this.lockPerson(m, personId, true);
      if (!person || !person.deletedAt) {
        return false;
      }

      await this.restoreInTransaction(m, person);
      return true;
    });
  }

  // ============ Shared internals ============

  /**
   * Releases what a person holds in ONE building. Every where-clause carries
   * tenant_id: nothing in another building is touched.
   *
   * Credentials are deleted, not deactivated: a UID can be registered only once
   * per building, and both the registration check and the unique index on
   * (tenant_id, uid) count inactive rows, so deleting is what lets the same
   * physical card or vehicle be handed to the next person.
   */
  async releaseTenantAssets(
    manager: EntityManager,
    personId: string,
    tenantId: string,
  ): Promise<ReleasedAssets> {
    if (!isUuid(personId) || !isUuid(tenantId)) {
      throw new Error('releaseTenantAssets needs a person id and a building id');
    }

    const personalCards = await manager.delete(RfidCard, { userId: personId, tenantId });

    const vehicles = await manager.find(Vehicle, {
      where: { ownerId: personId, tenantId },
      select: ['id'],
    });
    const vehicleIds = vehicles.map((vehicle) => vehicle.id);

    let vehicleCards = 0;
    if (vehicleIds.length > 0) {
      // Cards before vehicles: rfid_cards.vehicle_id references vehicles.
      const deleted = await manager.delete(RfidCard, { vehicleId: In(vehicleIds), tenantId });
      vehicleCards = deleted.affected ?? 0;

      // The vehicle row goes too. Its built-in tag (rfid_uid) and its licence
      // plate are unique per building and cannot be cleared on a kept row.
      await manager.delete(Vehicle, { id: In(vehicleIds), tenantId });
    }

    // Passes stay as history but can no longer open a gate: the ones this
    // person made for their own visitors, and the ones registered for visiting
    // them. On-premise passes a guard or admin registered belong to the host
    // resident, so a removed guard's are left alone.
    const openPass = In([VisitorPassStatus.PENDING, VisitorPassStatus.ACTIVE]);
    const ownPasses = await manager.update(
      VisitorPass,
      {
        createdById: personId,
        tenantId,
        registrationType: RegistrationType.SELF_SERVICE,
        status: openPass,
      },
      { status: VisitorPassStatus.CANCELLED },
    );
    const hostedPasses = await manager.update(
      VisitorPass,
      { residentId: personId, tenantId, status: openPass },
      { status: VisitorPassStatus.CANCELLED },
    );

    // That building's alerts must not follow the person into whatever they do
    // next. Personal notifications (tenant_id NULL) are kept.
    const notifications = await manager.delete(Notification, { userId: personId, tenantId });

    return {
      personalCards: personalCards.affected ?? 0,
      vehicles: vehicleIds.length,
      vehicleCards,
      passesCancelled: (ownPasses.affected ?? 0) + (hostedPasses.affected ?? 0),
      notifications: notifications.affected ?? 0,
    };
  }

  /**
   * The body of every restore (sign-in and admin re-add). The person row must
   * already be locked.
   */
  private async restoreInTransaction(m: EntityManager, person: User): Promise<void> {
    const live = await this.membershipsService.listLiveForUser(person.id, m);
    const buildings = [
      ...new Set(
        [person.tenantId, ...live.map((membership) => membership.tenantId)].filter(isUuid),
      ),
    ].sort();

    await m.restore(User, person.id);
    // Ends every membership still live and writes the sentinel mirror.
    const ended = await this.membershipsService.restorePerson(person.id, m);

    // The mirror never touches a super admin row, so a restored super admin
    // would otherwise get platform-wide access back. Before memberships a
    // restore always came back as a new user (building_admin, no building); a
    // deleted super admin still does. Re-granting is an explicit act.
    if (person.role === UserRole.SUPER_ADMIN) {
      await m.update(
        User,
        { id: person.id, role: UserRole.SUPER_ADMIN },
        { role: LEGACY_SENTINEL.role, tenantId: LEGACY_SENTINEL.tenantId, unit: () => 'NULL' },
      );
    }

    const released = noAssets();
    for (const tenantId of buildings) {
      addAssets(released, await this.releaseTenantAssets(m, person.id, tenantId));
    }

    this.logger.log(
      `Restored deleted person ${person.id} as a new user: ${ended} membership(s) ended, ` +
        describeAssets(released),
    );
  }

  private async addInTransaction(m: EntityManager, attempt: AddAttempt): Promise<AddOutcome> {
    // Lock order: tenant (taken by the seat check), then person.
    const { tenant } = await assertSeatAvailable(m, attempt.tenantId, {
      requirePlan: attempt.input.requirePlan,
    });

    let person =
      (await this.findPersonByEmail(attempt.email, m, { lock: true })) ??
      // The account service is the identity authority: a gate row already linked
      // to the identity it returned is this same person, even if the two
      // addresses have drifted apart.
      (attempt.identity ? await this.lockPersonBySub(m, attempt.identity.id) : null);

    if (person) {
      await this.assertCanBeAdded(person, tenant.id, m);
      if (person.deletedAt) {
        await this.restoreInTransaction(m, person);
      }
    } else {
      if (!attempt.identity) {
        // Seen by the pre-check, gone now (hard-deleted in between). No identity
        // was provisioned for it, so nothing can be linked.
        throw new ConflictException('This person changed while being added. Please try again.');
      }
      person = await this.insertPerson(m, {
        email: attempt.email,
        firstName: attempt.input.firstName,
        lastName: attempt.input.lastName,
        phone: attempt.input.phone,
        userId: attempt.identity.id,
        passwordHash: attempt.passwordHash,
        // A temporary password is being handed out: the person should replace it.
        mustChangePassword: Boolean(attempt.identity.created && attempt.identity.password),
      });
    }

    const membership = await this.membershipsService.add(
      {
        userId: person.id,
        tenantId: tenant.id,
        role: attempt.role,
        status: attempt.status,
        unit: attempt.unit ?? null,
      },
      m,
    );

    // Re-read: the mirror and a restore changed the row, and select:false keeps
    // the hash out of what is returned.
    const saved = await m.findOneOrFail(User, { where: { id: person.id } });
    membership.user = saved;
    membership.tenant = tenant;

    return { person: saved, membership, tenant };
  }

  /**
   * The refusals that do not depend on the building's seats, most specific
   * first. A soft-deleted person's leftover memberships do not count: restoring
   * ends them.
   */
  private async assertCanBeAdded(
    person: User,
    tenantId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const live = person.deletedAt
      ? []
      : await this.membershipsService.listLiveForUser(person.id, manager);

    const here = live.find((membership) => membership.tenantId === tenantId);
    if (here) {
      throw membershipExists(here.role);
    }

    // Until the status split (deferred) a non-active gate_users.status is both
    // a platform ban and the copy of a single membership's status; either way
    // it blocks sign-in, and adding would only hide the person in one more
    // building. MembershipsService.add never lifts it.
    if (person.status !== UserStatus.ACTIVE) {
      throw accountSuspended();
    }

    if (live.length > 0 && !isMembershipContextEnabled()) {
      throw multiMembershipDisabled();
    }
  }

  private async assertNotLastAdmin(m: EntityManager, membership: Membership): Promise<void> {
    if (membership.role !== UserRole.BUILDING_ADMIN || membership.status !== UserStatus.ACTIVE) {
      return;
    }

    const otherAdmins = await m.count(Membership, {
      where: {
        tenantId: membership.tenantId,
        role: UserRole.BUILDING_ADMIN,
        status: UserStatus.ACTIVE,
        id: Not(membership.id),
      },
    });
    if (otherAdmins === 0) {
      throw lastBuildingAdmin();
    }
  }

  /** After commit, never fatal: the person and the membership already exist. */
  private sendAddedEmail(
    outcome: AddOutcome,
    role: MembershipRole,
    newPassword: string | null,
    actor: Pick<User, 'firstName' | 'lastName'> | null | undefined,
  ): void {
    const { person, tenant } = outcome;
    const loginUrl = this.configService.get<string>('GATE_LOGIN_URL', 'https://yaad.global/login');
    const name = fullName(person);
    const addedBy = fullName(actor);

    const sending = newPassword
      ? this.emailService.sendNewUserCredentialsEmail(
          person.email,
          name,
          role,
          newPassword,
          tenant.name,
          addedBy,
          loginUrl,
        )
      : this.emailService.sendAddedToBuildingEmail(
          person.email,
          name,
          role,
          tenant.name,
          addedBy || null,
          loginUrl,
        );

    Promise.resolve(sending).catch((err: unknown) =>
      this.logger.warn(
        `Added ${person.email} to building ${tenant.id} but the email failed to send` +
          (newPassword ? '; they can use "forgot password". ' : '. ') +
          ((err as Error)?.message ?? ''),
      ),
    );
  }

  private personNotFoundMessage(expectedRole?: MembershipRole | null): string {
    return expectedRole === UserRole.RESIDENT ? 'Resident not found' : 'Person not found';
  }

  private notAMemberMessage(expectedRole?: MembershipRole | null): string {
    return expectedRole === UserRole.RESIDENT
      ? 'Not currently a resident of this building.'
      : 'Not currently a member of this building.';
  }

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  /** Joins the caller's transaction when it has one; otherwise opens one. */
  private async inTransaction<T>(
    manager: EntityManager | undefined,
    work: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (manager?.queryRunner?.isTransactionActive) {
      return work(manager);
    }
    return this.em(manager).transaction(work);
  }

  /** FOR UPDATE on the person row, without relations (Postgres refuses FOR UPDATE across an outer join). */
  private lockPerson(m: EntityManager, personId: string, withDeleted: boolean) {
    return m.findOne(User, {
      where: { id: personId },
      withDeleted,
      lock: { mode: 'pessimistic_write' },
    });
  }

  private async lockPersonBySub(m: EntityManager, sub: string): Promise<User | null> {
    // user_id is a uuid column: anything else would be a Postgres error, not a miss.
    if (!isUuid(sub)) {
      return null;
    }
    return m.findOne(User, {
      where: { userId: sub },
      withDeleted: true,
      lock: { mode: 'pessimistic_write' },
    });
  }
}
