import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, ILike } from 'typeorm';

import {
  BuildingJoinRequest,
  JoinRequestStatus,
} from '@database/entities/building-join-request.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole, UserStatus } from '@database/entities/user.entity';
import { NotificationPriority, NotificationType } from '@database/entities/notification.entity';
import { NotificationService } from '@modules/notification/notification.service';

import { CreateJoinRequestDto } from './dto/create-join-request.dto';
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

/** `%` and `_` are LIKE wildcards; a term of "%" would otherwise match everything. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Roles that may never be converted into a resident by an approval.
 *
 * SUPER_ADMIN is the dangerous one: platform super admins are tenant-less by
 * design (see database/seeds/seed.ts), so they satisfy every "has no building"
 * check and would otherwise be a valid requester. Approving one would rewrite
 * the platform owner's row to role=resident with no in-app way back, because
 * every super-admin surface and OnboardingService.updateBuilding would then be
 * closed to them.
 */
const ROLES_INELIGIBLE_TO_JOIN: UserRole[] = [UserRole.SUPER_ADMIN];

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
 * A signed-in user picks an existing building and asks to join it; that
 * building's admin approves or rejects. The requester's `gate_users` row is not
 * touched until approval — see BuildingJoinRequest for why a pending state on
 * the user row would strand them.
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
  ) {}

  // ============ Requester side ============

  /**
   * Building picker.
   *
   * Restricted to callers who have no building of their own. That restriction,
   * not a minimum term length, is what stops the endpoint being a directory:
   * every resident, guard and staff member already belongs somewhere and gets a
   * 403, so the only people who can read it are those who must find a building
   * to join. Within that audience a blank box listing the newest buildings is
   * the useful default, so no term is required.
   *
   * The projection is explicit because the Tenant row also carries
   * stripeCustomerId, contact details, subscription state and a `settings` jsonb
   * that onboarding writes payment information into.
   */
  async searchBuildings(user: User, dto: SearchBuildingsDto): Promise<BuildingSearchResult[]> {
    if (user.tenantId) {
      throw new ForbiddenException('You already belong to a building.');
    }

    const limit = Math.min(dto.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const term = dto.q?.trim() ?? '';
    const select = ['id', 'name', 'slug', 'address'] as const;

    const tenants = term
      ? await this.tenantRepository.find({
          where: [
            { name: ILike(`%${escapeLike(term)}%`) },
            { address: ILike(`%${escapeLike(term)}%`) },
          ],
          select: [...select],
          // Alphabetical once the user has narrowed it down: easier to scan.
          order: { name: 'ASC' },
          take: limit,
        })
      : await this.tenantRepository.find({
          // Nothing typed yet — show the newest buildings, which is what a
          // person who just signed up is most likely looking for.
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

    // An approval only means something while the user is still in that
    // building. After they leave or are removed it is history, and reporting it
    // would hold them on the "You're approved" screen instead of letting them
    // start over like a new user.
    if (request.status === JoinRequestStatus.APPROVED && request.tenantId !== user.tenantId) {
      return null;
    }

    return this.toRequesterView(request);
  }

  async createRequest(userId: string, dto: CreateJoinRequestDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Already in a building — either they onboarded as an admin or an earlier
    // request was approved. Either way this endpoint is not their path.
    if (user.tenantId) {
      throw new ConflictException('You already belong to a building.');
    }

    if (ROLES_INELIGIBLE_TO_JOIN.includes(user.role)) {
      throw new ForbiddenException('This account cannot join a building as a resident.');
    }

    const tenant = await this.tenantRepository.findOne({ where: { id: dto.tenantId } });
    if (!tenant) {
      throw new NotFoundException('Building not found');
    }

    const pending = await this.requestRepository.findOne({
      where: { userId, status: JoinRequestStatus.PENDING },
    });
    if (pending) {
      throw new ConflictException(
        'You already have a request awaiting review. Cancel it before requesting another building.',
      );
    }

    const request = this.requestRepository.create({
      userId,
      tenantId: tenant.id,
      status: JoinRequestStatus.PENDING,
      unit: dto.unit,
      phone: dto.phone,
      note: dto.note ?? null,
    });

    const saved = await this.requestRepository.save(request);

    // Never let a notification failure lose an accepted request.
    await this.notifyAdmins(tenant.id, user, saved).catch((err) =>
      this.logger.error(
        `Join request ${saved.id} saved but admin notification failed: ${err?.message}`,
      ),
    );

    saved.tenant = tenant;
    return this.toRequesterView(saved);
  }

  async cancelMyRequest(userId: string) {
    const request = await this.requestRepository.findOne({
      where: { userId, status: JoinRequestStatus.PENDING },
      relations: ['tenant'],
    });

    if (!request) {
      throw new NotFoundException('No request awaiting review');
    }

    request.status = JoinRequestStatus.CANCELLED;
    const saved = await this.requestRepository.save(request);
    return this.toRequesterView(saved);
  }

  // ============ Admin side ============

  /**
   * The review queue. A building admin sees only their own building's requests;
   * a super admin sees every building's.
   */
  async listForReviewer(reviewer: User, status?: JoinRequestStatus) {
    const isSuperAdmin = reviewer.role === UserRole.SUPER_ADMIN;

    if (!isSuperAdmin && !reviewer.tenantId) {
      // A building admin who has not created their building yet has no queue.
      return [];
    }

    const where: Record<string, unknown> = {};
    if (!isSuperAdmin) {
      where.tenantId = reviewer.tenantId;
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

  async approve(reviewer: User, requestId: string, dto: ReviewJoinRequestDto) {
    // Authorisation and a first look. The decisive status check happens again
    // under a row lock inside the transaction.
    const preview = await this.loadForReview(reviewer, requestId);

    const approved = await this.dataSource.transaction(async (manager) => {
      const request = await this.lockPending(manager, requestId);

      const requester = await manager.findOne(User, { where: { id: request.userId } });
      if (!requester) {
        throw new NotFoundException('Requester no longer exists');
      }

      // They may have onboarded as a building admin, or been approved elsewhere,
      // while this request sat in the queue.
      if (requester.tenantId) {
        throw new ConflictException(
          'This person already belongs to a building. The request can only be rejected.',
        );
      }

      // Re-checked here and not only at submit time: the role could have changed
      // while the request waited, and this is the write that would destroy it.
      if (ROLES_INELIGIBLE_TO_JOIN.includes(requester.role)) {
        throw new ForbiddenException(
          'This account cannot be converted into a resident. Decline the request instead.',
        );
      }

      // A building admin must not be able to undo a platform-level suspension by
      // approving a request the suspended user filed beforehand.
      if (requester.status === UserStatus.INACTIVE) {
        throw new ForbiddenException(
          'This account has been deactivated. Decline the request instead.',
        );
      }

      await this.assertPlanHasRoomForResident(manager, request.tenantId);

      // Update the EXISTING gate_users row. Inserting a second one would collide
      // with the unique indexes on email and user_id.
      requester.role = UserRole.RESIDENT;
      requester.tenantId = request.tenantId;
      if (requester.status === UserStatus.PENDING) {
        requester.status = UserStatus.ACTIVE;
      }
      if (request.unit) {
        requester.unit = request.unit;
      }
      if (request.phone && !requester.phone) {
        requester.phone = request.phone;
      }
      await manager.save(User, requester);

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

  private async loadForReview(reviewer: User, requestId: string) {
    const request = await this.requestRepository.findOne({
      where: { id: requestId },
      relations: ['user', 'tenant'],
    });

    if (!request) {
      throw new NotFoundException('Request not found');
    }

    const isSuperAdmin = reviewer.role === UserRole.SUPER_ADMIN;
    if (!isSuperAdmin && request.tenantId !== reviewer.tenantId) {
      // Same answer as a missing row: do not confirm that the id exists.
      throw new NotFoundException('Request not found');
    }

    if (request.status !== JoinRequestStatus.PENDING) {
      throw new BadRequestException(`This request has already been ${request.status}.`);
    }

    return request;
  }

  /**
   * Mirrors ResidentsService.create's limit check, including its wording, so an
   * approval cannot slip a tenant past the seat count that the admin-driven
   * resident creation path enforces.
   */
  private async assertPlanHasRoomForResident(
    manager: EntityManager,
    tenantId: string,
  ): Promise<void> {
    const tenant = await manager.findOne(Tenant, {
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (!tenant.subscriptionPlan) {
      throw new ForbiddenException('No subscription plan found. Please subscribe to a plan first.');
    }

    const residentCount = await manager.count(User, {
      where: { tenantId, role: UserRole.RESIDENT },
    });

    if (residentCount >= tenant.subscriptionPlan.maxUsers) {
      throw new ForbiddenException(
        `User limit reached. Your plan allows ${tenant.subscriptionPlan.maxUsers} users. Please upgrade your plan to add more users.`,
      );
    }
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
