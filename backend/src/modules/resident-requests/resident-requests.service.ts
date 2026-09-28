import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, ILike, In, Not, Repository } from 'typeorm';

import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { NotificationPriority, NotificationType } from '@database/entities/notification.entity';
import { isUniqueViolation } from '@database/pg-errors';
import { contextKindOf, isActingUser, isUuid } from '@common/context/acting-user';
import { assertBuildingContext, isPlatformContext } from '@common/context/assert-building-context';
import {
  accountSuspended,
  joinRequestPending,
  membershipExists,
  multiMembershipDisabled,
} from '@common/context/membership-context.errors';
import { isMembershipContextEnabled } from '@common/context/membership-flags';
import { NotificationService } from '@modules/notification/notification.service';
import { MembershipsService } from '@modules/memberships/memberships.service';
import { ResidentRemovalService } from '@modules/residents/resident-removal.service';
import { assertSeatAvailable } from '@modules/people/seat-limit';

import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { LeaveBuildingDto } from './dto/leave-building.dto';
import { ReviewJoinRequestDto } from './dto/review-join-request.dto';
import { SearchBuildingsDto } from './dto/search-buildings.dto';

/** Shape returned by the building picker. Nothing else about a tenant is exposed. */
export interface BuildingSearchResult {
  id: string;
  name: string;
  slug: string;
  address: string | null;
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

/**
 * How many requests one person may have waiting at once, across buildings,
 * while GATE_MEMBERSHIP_CONTEXT is on (with it off the legacy rule of one
 * request at a time holds). At most one per building is enforced separately,
 * by the service and by the partial unique index below.
 */
export const MAX_PENDING_JOIN_REQUESTS = 5;

/** Partial unique index: one PENDING request per (person, building). */
export const JOIN_REQUEST_PENDING_INDEX = 'UQ_building_join_requests_one_pending_per_user_tenant';

/** How many of their own requests GET /resident-join/requests returns. */
const MY_REQUESTS_LIMIT = 50;

/** `%` and `_` are LIKE wildcards; a term of "%" would otherwise match everything. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Roles that may not join a building as a resident while GATE_MEMBERSHIP_CONTEXT
 * is off.
 *
 * Approval used to rewrite the requester's single gate_users row, so approving
 * a platform super admin would have turned the platform owner into a resident
 * with no way back. Approval now only adds a RESIDENT membership and never
 * touches gate_users.role, so with the context on a super admin may hold a
 * resident role like anyone else. With it off (legacy), requests act as the
 * gate_users row, which for a super admin is always the platform: such a
 * membership could never be used, so the old refusal stays.
 */
const ROLES_INELIGIBLE_TO_JOIN_IN_LEGACY_MODE: UserRole[] = [UserRole.SUPER_ADMIN];

/**
 * Strip anything that could break out of the surrounding markup when a
 * notification is delivered as HTML email.
 *
 * `unit` and the requester's name are attacker-controlled and are rendered to
 * building admins of a tenant the requester has no relationship with, so they
 * are never interpolated raw.
 */
function plain(value: string | null | undefined, max = 80): string {
  if (!value) return '';
  return value
    .replace(/[<>&"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Self-service resident onboarding.
 *
 * A signed-in person picks an existing building and asks to join it as a
 * resident; that building's admin approves or rejects. A request is never a
 * membership: nothing about the requester changes until approval, which adds a
 * RESIDENT membership in that building and leaves every other role the person
 * holds (an admin of Tower A may ask to be a resident of Tower B) untouched.
 *
 * GATE_MEMBERSHIP_CONTEXT off keeps today's single-building rules: a person who
 * already belongs to a building cannot search, request or be approved (409
 * MULTI_MEMBERSHIP_DISABLED, or 403 as before), and only one request may wait
 * at a time.
 */
@Injectable()
export class ResidentRequestsService {
  private readonly logger = new Logger(ResidentRequestsService.name);

  constructor(
    @InjectRepository(BuildingJoinRequest)
    private readonly requestRepository: Repository<BuildingJoinRequest>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly notificationService: NotificationService,
    private readonly dataSource: DataSource,
    private readonly membershipsService: MembershipsService,
    private readonly residentRemovalService: ResidentRemovalService,
  ) {}

  // ============ Requester side ============

  /**
   * Building picker.
   *
   * Lists buildings the caller could still join: every building where they
   * hold no role yet (a person has at most one role per building). With
   * GATE_MEMBERSHIP_CONTEXT off, a caller who already belongs to a building
   * gets 403 as before, since they could not join a second one; that audience
   * rule, not a minimum term length, is what kept the endpoint from being a
   * directory for everyone. With it on, anyone signed in may look for a
   * building to join, so the projection stays deliberately narrow and the page
   * size capped. A blank box lists the newest buildings.
   *
   * The projection is explicit because the Tenant row also carries
   * stripeCustomerId, contact details, subscription state and a `settings` jsonb
   * that onboarding writes payment information into.
   */
  async searchBuildings(user: User, dto: SearchBuildingsDto): Promise<BuildingSearchResult[]> {
    const memberships = await this.membershipsService.listLiveForUser(user.id);
    if (memberships.length > 0 && !isMembershipContextEnabled()) {
      throw new ForbiddenException('You already belong to a building.');
    }

    const limit = Math.min(dto.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const term = dto.q?.trim() ?? '';
    const select = ['id', 'name', 'slug', 'address'] as const;

    // Buildings where the caller already has a role are not offered.
    const held = [...new Set(memberships.map((membership) => membership.tenantId))];
    const notHeld: FindOptionsWhere<Tenant> = held.length > 0 ? { id: Not(In(held)) } : {};

    const tenants = term
      ? await this.tenantRepository.find({
          where: [
            { name: ILike(`%${escapeLike(term)}%`), ...notHeld },
            { address: ILike(`%${escapeLike(term)}%`), ...notHeld },
          ],
          select: [...select],
          // Alphabetical once the user has narrowed it down: easier to scan.
          order: { name: 'ASC' },
          take: limit,
        })
      : await this.tenantRepository.find({
          // Nothing typed yet — show the newest buildings, which is what a
          // person who just signed up is most likely looking for.
          where: notHeld,
          select: [...select],
          order: { createdAt: 'DESC' },
          take: limit,
        });

    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      address: t.address ?? null,
    }));
  }

  /**
   * The caller's own latest request, or null. The frontend polls this to decide
   * between the chooser, the waiting screen and the rejection notice.
   */
  async getMyRequest(user: User) {
    const request = await this.requestRepository.findOne({
      where: { userId: user.id },
      relations: ['tenant'],
      order: { createdAt: 'DESC' },
    });

    if (!request) {
      return null;
    }

    // An approval only means something while the person is still a resident of
    // that building. After they leave or are removed it is history, and
    // reporting it would hold them on the "You're approved" screen instead of
    // letting them start over.
    if (
      request.status === JoinRequestStatus.APPROVED &&
      !(await this.isResidentOf(user.id, request.tenantId))
    ) {
      return null;
    }

    return this.toRequesterView(request);
  }

  /**
   * The caller's own requests, newest first: pending and declined ones, and
   * approved ones while they are still a resident there (the getMyRequest
   * rule). Cancelled requests are the caller's own undo and are left out.
   */
  async listMyRequests(user: User) {
    const [requests, memberships] = await Promise.all([
      this.requestRepository.find({
        where: { userId: user.id, status: Not(JoinRequestStatus.CANCELLED) },
        relations: ['tenant'],
        order: { createdAt: 'DESC' },
        take: MY_REQUESTS_LIMIT,
      }),
      this.membershipsService.listLiveForUser(user.id),
    ]);

    const residentOf = new Set(
      memberships
        .filter((membership) => membership.role === UserRole.RESIDENT)
        .map((membership) => membership.tenantId),
    );

    return requests
      .filter(
        (request) =>
          request.status !== JoinRequestStatus.APPROVED || residentOf.has(request.tenantId),
      )
      .map((request) => this.toRequesterView(request));
  }

  /**
   * Asks to join a building as a resident. In order:
   *   - 409 MULTI_MEMBERSHIP_DISABLED up front when GATE_MEMBERSHIP_CONTEXT is
   *     off and the person already belongs to a building;
   *   - 403 ACCOUNT_SUSPENDED for a person suspended platform-wide;
   *   - 404 for an unknown building;
   *   - 409 MEMBERSHIP_EXISTS when they already hold a role there;
   *   - 409 JOIN_REQUEST_PENDING when a request to that building is waiting
   *     (also what a concurrent duplicate submit gets from the unique index);
   *   - 409 when MAX_PENDING_JOIN_REQUESTS are already waiting (one while the
   *     context is off).
   */
  async createRequest(userId: string, dto: CreateJoinRequestDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const multiBuilding = isMembershipContextEnabled();
    const memberships = await this.membershipsService.listLiveForUser(user.id);
    if (!multiBuilding && memberships.length > 0) {
      throw multiMembershipDisabled();
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw accountSuspended();
    }

    if (!multiBuilding && ROLES_INELIGIBLE_TO_JOIN_IN_LEGACY_MODE.includes(user.role)) {
      throw new ForbiddenException('This account cannot join a building as a resident.');
    }

    const tenant = await this.tenantRepository.findOne({ where: { id: dto.tenantId } });
    if (!tenant) {
      throw new NotFoundException('Building not found');
    }

    const here = memberships.find((membership) => membership.tenantId === tenant.id);
    if (here) {
      throw membershipExists(here.role);
    }

    const pending = await this.requestRepository.find({
      where: { userId: user.id, status: JoinRequestStatus.PENDING },
    });
    if (pending.some((request) => request.tenantId === tenant.id)) {
      throw joinRequestPending();
    }
    const maxPending = multiBuilding ? MAX_PENDING_JOIN_REQUESTS : 1;
    if (pending.length >= maxPending) {
      throw new ConflictException(
        multiBuilding
          ? `You already have ${MAX_PENDING_JOIN_REQUESTS} requests awaiting review. Cancel one before requesting another building.`
          : 'You already have a request awaiting review. Cancel it before requesting another building.',
      );
    }

    const request = this.requestRepository.create({
      userId: user.id,
      tenantId: tenant.id,
      status: JoinRequestStatus.PENDING,
      unit: dto.unit,
      phone: dto.phone,
      note: dto.note ?? null,
    });

    let saved: BuildingJoinRequest;
    try {
      saved = await this.requestRepository.save(request);
    } catch (error) {
      // A second submit for the same building that raced past the check above.
      if (isUniqueViolation(error, JOIN_REQUEST_PENDING_INDEX)) {
        throw joinRequestPending();
      }
      throw error;
    }

    // Never let a notification failure lose an accepted request.
    await this.notifyAdmins(tenant.id, user, saved).catch((err) =>
      this.logger.error(
        `Join request ${saved.id} saved but admin notification failed: ${err?.message}`,
      ),
    );

    saved.tenant = tenant;
    return this.toRequesterView(saved);
  }

  /**
   * Withdraws a waiting request: the one named by id, or, without an id, the
   * caller's only waiting request (400 when several are waiting and none is
   * named; 404 when none is).
   *
   * The status changes only while it is still PENDING, so a cancel that lands
   * while an admin is approving the same request cannot overwrite the approval:
   * it waits for the reviewer's row lock, then finds nothing to cancel.
   */
  async cancelMyRequest(userId: string, requestId?: string) {
    let request: BuildingJoinRequest | null;

    if (requestId !== undefined) {
      request = isUuid(requestId)
        ? await this.requestRepository.findOne({
            where: { id: requestId, userId, status: JoinRequestStatus.PENDING },
            relations: ['tenant'],
          })
        : null;
    } else {
      const pending = await this.requestRepository.find({
        where: { userId, status: JoinRequestStatus.PENDING },
        relations: ['tenant'],
        order: { createdAt: 'DESC' },
      });
      if (pending.length > 1) {
        throw new BadRequestException(
          'Several requests are awaiting review. Cancel one by its id (DELETE /resident-join/request/:id).',
        );
      }
      request = pending[0] ?? null;
    }

    if (!request) {
      throw new NotFoundException('No request awaiting review');
    }

    const result = await this.requestRepository.update(
      { id: request.id, status: JoinRequestStatus.PENDING },
      { status: JoinRequestStatus.CANCELLED },
    );
    if (!result.affected) {
      throw new BadRequestException('This request is no longer awaiting review.');
    }

    request.status = JoinRequestStatus.CANCELLED;
    return this.toRequesterView(request);
  }

  /**
   * A resident leaving a building by themselves (POST /resident-join/leave):
   * the RESIDENT membership in the building the request acts in ends, and what
   * they held there is released (ResidentRemovalService). Their account and
   * every other role they hold stay.
   *
   * With the context on, the building is the chosen membership's, and it must
   * be a resident one: acting as an admin or a guard is 400, since that role is
   * not something one leaves from here. A body tenantId is read only in legacy
   * mode, where the request acts as the gate_users row.
   */
  async leaveBuilding(user: User, dto: LeaveBuildingDto = {}): Promise<void> {
    const kind = isActingUser(user) ? contextKindOf(user) : 'legacy';

    let tenantId: string;
    if (kind === 'legacy') {
      const legacyTenantId = dto.tenantId ?? user.tenantId;
      if (!legacyTenantId) {
        throw new ConflictException('Not currently a resident of any building.');
      }
      tenantId = legacyTenantId;
    } else {
      tenantId = assertBuildingContext(user);
      if (user.role !== UserRole.RESIDENT) {
        throw new BadRequestException(
          'Only a resident can leave a building. Choose your resident role in that building first.',
        );
      }
    }

    await this.residentRemovalService.removeFromBuilding(user.id, tenantId, {
      expectedRole: UserRole.RESIDENT,
      reason: 'left_building',
    });
  }

  // ============ Admin side ============

  /**
   * The review queue. A building admin sees the requests for the building the
   * request acts in; a platform admin sees every building's.
   */
  async listForReviewer(reviewer: User, status?: JoinRequestStatus) {
    const where: FindOptionsWhere<BuildingJoinRequest> = {};
    if (!isPlatformContext(reviewer)) {
      where.tenantId = assertBuildingContext(reviewer, [UserRole.BUILDING_ADMIN]);
    }
    if (status) {
      where.status = status;
    }

    const requests = await this.requestRepository.find({
      where,
      relations: ['user', 'tenant'],
      order: { createdAt: 'DESC' },
    });

    return requests.map((r) => this.toReviewerView(r));
  }

  /**
   * Makes the requester a resident of the request's building by adding a
   * RESIDENT membership. The person row is never saved, so every other role
   * they hold is untouched. Everything runs under row locks taken in the order
   * every membership write uses (join request, tenant, person), so a concurrent
   * approve and reject cannot both commit and two approvals cannot both take
   * the last seat:
   *   - 403 ACCOUNT_SUSPENDED for a person suspended platform-wide;
   *   - 409 MEMBERSHIP_EXISTS when they already hold a role in the building;
   *   - the seat rule (a plan is required), then MembershipsService.add, which
   *     with GATE_MEMBERSHIP_CONTEXT off refuses a person who belongs to
   *     another building (409 MULTI_MEMBERSHIP_DISABLED);
   *   - an empty phone on the person is filled from the request.
   */
  async approve(reviewer: User, requestId: string, dto: ReviewJoinRequestDto) {
    // Authorisation and a first look. The decisive status check happens again
    // under a row lock inside the transaction.
    const preview = await this.loadForReview(reviewer, requestId);

    const approved = await this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, requestId);

      const tenant = await manager.findOne(Tenant, {
        where: { id: request.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }

      const requester = await manager.findOne(User, {
        where: { id: request.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!requester) {
        throw new NotFoundException('Requester no longer exists');
      }

      // A building admin must not be able to undo a platform-level suspension by
      // approving a request the suspended person filed beforehand.
      if (requester.status !== UserStatus.ACTIVE) {
        throw accountSuspended();
      }

      if (
        !isMembershipContextEnabled() &&
        ROLES_INELIGIBLE_TO_JOIN_IN_LEGACY_MODE.includes(requester.role)
      ) {
        throw new ForbiddenException(
          'This account cannot be made a resident. Decline the request instead.',
        );
      }

      // They may have been added to the building by an admin while this
      // request waited.
      const existing = await this.membershipsService.findLive(requester.id, tenant.id, manager);
      if (existing) {
        throw membershipExists(existing.role);
      }

      await assertSeatAvailable(manager, tenant.id, { requirePlan: true });

      await this.membershipsService.add(
        {
          userId: requester.id,
          tenantId: tenant.id,
          role: UserRole.RESIDENT,
          unit: request.unit?.trim() || null,
        },
        manager,
      );

      if (request.phone && !requester.phone) {
        await manager.update(User, { id: requester.id }, { phone: request.phone });
      }

      request.status = JoinRequestStatus.APPROVED;
      request.reviewedBy = reviewer.id;
      request.reviewedAt = new Date();
      request.decisionNote = dto.decisionNote ?? null;
      return manager.save(BuildingJoinRequest, request);
    });

    await this.notifyRequester(
      approved,
      NotificationType.SUCCESS,
      NotificationPriority.NORMAL,
      'Join request approved',
      `You are now a resident of ${plain(preview.tenant?.name) || 'the building'}.`,
    );

    approved.user = preview.user;
    return this.toReviewerView(approved);
  }

  async reject(reviewer: User, requestId: string, dto: ReviewJoinRequestDto) {
    const preview = await this.loadForReview(reviewer, requestId);

    // Same lock as approve, so a concurrent approve+reject cannot both commit.
    const saved = await this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, requestId);

      request.status = JoinRequestStatus.REJECTED;
      request.reviewedBy = reviewer.id;
      request.reviewedAt = new Date();
      request.decisionNote = dto.decisionNote ?? null;
      return manager.save(BuildingJoinRequest, request);
    });

    const reason = plain(dto.decisionNote, 300);
    const building = plain(preview.tenant?.name) || 'the building';

    await this.notifyRequester(
      saved,
      NotificationType.WARNING,
      NotificationPriority.NORMAL,
      'Join request declined',
      reason
        ? `Your request to join ${building} was declined: ${reason}`
        : `Your request to join ${building} was declined.`,
    );

    saved.user = preview.user;
    return this.toReviewerView(saved);
  }

  // ============ Internals ============

  /** Whether the person currently holds a RESIDENT membership in the building. */
  private async isResidentOf(personId: string, tenantId: string): Promise<boolean> {
    const membership = await this.membershipsService.findLive(personId, tenantId);
    return membership?.role === UserRole.RESIDENT;
  }

  /**
   * Re-read the request inside the transaction and take a write lock on it, so
   * two reviewers acting at the same moment serialise instead of both passing
   * the status check and committing contradictory outcomes.
   *
   * Loaded without relations on purpose: a pessimistic lock combined with joins
   * is rejected by Postgres ("FOR UPDATE cannot be applied to the nullable side
   * of an outer join").
   */
  private async lockPending(
    manager: EntityManager,
    requestId: string,
  ): Promise<BuildingJoinRequest> {
    const request = await manager.findOne(BuildingJoinRequest, {
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!request) {
      throw new NotFoundException('Request not found');
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new BadRequestException(`This request has already been ${request.status}.`);
    }

    return request;
  }

  /**
   * The request, if the reviewer may decide it: a building admin only for the
   * building the request acts in, a platform admin for any. Another building's
   * request answers 404, the same as a missing one, so ids cannot be probed.
   */
  private async loadForReview(reviewer: User, requestId: string) {
    const scope = isPlatformContext(reviewer)
      ? null
      : assertBuildingContext(reviewer, [UserRole.BUILDING_ADMIN]);

    const request = isUuid(requestId)
      ? await this.requestRepository.findOne({
          where: { id: requestId },
          relations: ['user', 'tenant'],
        })
      : null;

    if (!request) {
      throw new NotFoundException('Request not found');
    }

    if (scope !== null && request.tenantId !== scope) {
      // Same answer as a missing row: do not confirm that the id exists.
      throw new NotFoundException('Request not found');
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new BadRequestException(`This request has already been ${request.status}.`);
    }

    return request;
  }

  private async notifyAdmins(tenantId: string, requester: User, request: BuildingJoinRequest) {
    // NotificationType has no join-request member and `type` is a real Postgres
    // enum, so adding one would need an ALTER TYPE that cannot be used in the
    // same transaction it is created in. INFO carries the same meaning here.
    //
    // Every interpolated value is attacker-controlled and lands in an HTML email
    // addressed to admins of a building the requester has no relationship with,
    // so all of it goes through plain().
    const who =
      plain(`${requester.firstName ?? ''} ${requester.lastName ?? ''}`) ||
      plain(requester.email) ||
      'Someone';
    const unit = plain(request.unit, 40);

    await this.notificationService.createForTenantRoles(tenantId, [UserRole.BUILDING_ADMIN], {
      type: NotificationType.INFO,
      priority: NotificationPriority.NORMAL,
      title: 'New resident request',
      message: `${who} asked to join your building${unit ? ` (unit ${unit})` : ''}.`,
      metadata: { joinRequestId: request.id, requesterId: requester.id },
      sendEmail: true,
    });
  }

  private async notifyRequester(
    request: BuildingJoinRequest,
    type: NotificationType,
    priority: NotificationPriority,
    title: string,
    message: string,
  ) {
    await this.notificationService
      .create({
        userId: request.userId,
        tenantId: request.status === JoinRequestStatus.APPROVED ? request.tenantId : undefined,
        type,
        priority,
        title,
        message,
        metadata: { joinRequestId: request.id },
        sendEmail: true,
      })
      .catch((err) =>
        this.logger.error(
          `Decision on join request ${request.id} saved but requester notification failed: ${err?.message}`,
        ),
      );
  }

  private toRequesterView(request: BuildingJoinRequest) {
    return {
      id: request.id,
      status: request.status,
      unit: request.unit ?? null,
      phone: request.phone ?? null,
      note: request.note,
      decisionNote: request.decisionNote,
      createdAt: request.createdAt,
      reviewedAt: request.reviewedAt,
      building: request.tenant
        ? {
            id: request.tenant.id,
            name: request.tenant.name,
            address: request.tenant.address ?? null,
          }
        : { id: request.tenantId, name: null, address: null },
    };
  }

  private toReviewerView(request: BuildingJoinRequest) {
    return {
      id: request.id,
      status: request.status,
      unit: request.unit ?? null,
      phone: request.phone ?? null,
      note: request.note,
      decisionNote: request.decisionNote,
      createdAt: request.createdAt,
      reviewedAt: request.reviewedAt,
      reviewedBy: request.reviewedBy,
      tenantId: request.tenantId,
      requester: request.user
        ? {
            id: request.user.id,
            firstName: request.user.firstName,
            lastName: request.user.lastName,
            email: request.user.email,
            phone: request.user.phone ?? null,
          }
        : null,
    };
  }
}
