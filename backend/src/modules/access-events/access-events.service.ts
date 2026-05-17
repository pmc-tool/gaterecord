import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual, SelectQueryBuilder } from 'typeorm';
import { AccessEvent, AccessResult } from '@database/entities/access-event.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { AccessEventQueryDto, AccessEventStatsDto } from './dto/access-event.dto';

@Injectable()
export class AccessEventsService {
  constructor(
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
  ) {}

  /**
   * Apply role-based access control filtering to access event queries
   * - SUPER_ADMIN: All events across all tenants
   * - BUILDING_ADMIN, SECURITY, STAFF: All events for their tenant
   * - RESIDENT: Only events where they are the subject (residentId = user.id)
   */
  private applyRbacFilter(
    qb: SelectQueryBuilder<AccessEvent>,
    currentUser: User,
    tenantIdFilter?: string,
  ): void {
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      // Super admin can see all, optionally filter by tenant
      if (tenantIdFilter) {
        qb.andWhere('event.tenant_id = :tenantId', { tenantId: tenantIdFilter });
      }
    } else if (currentUser.role === UserRole.RESIDENT) {
      // Residents can only see their own events
      qb.andWhere('event.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
      qb.andWhere('event.resident_id = :residentId', { residentId: currentUser.id });
    } else {
      // BUILDING_ADMIN, SECURITY, STAFF: All tenant events
      qb.andWhere('event.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }
  }

  /**
   * Get log retention days for user's tenant subscription plan
   */
  async getLogRetentionDays(currentUser: User): Promise<number> {
    // Super admin has unlimited access (return large number)
    if (currentUser.role === UserRole.SUPER_ADMIN) {
      return 9999;
    }

    if (!currentUser.tenantId) {
      return 30; // Default fallback
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: currentUser.tenantId },
      relations: ['subscriptionPlan'],
    });

    return tenant?.subscriptionPlan?.logRetentionDays || 30;
  }

  async findAll(
    query: AccessEventQueryDto,
    currentUser: User,
  ): Promise<{ events: AccessEvent[]; total: number; allowedCount: number; deniedCount: number; page: number; limit: number }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    
    const qb = this.accessEventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.gate', 'gate');

    

    // Apply role-based access control
    this.applyRbacFilter(qb, currentUser, query.tenantId);

    // Filters
    if (query.gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId: query.gateId });
    }

    if (query.method) {
      qb.andWhere('event.method = :method', { method: query.method });
    }

    if (query.subjectType) {
      qb.andWhere('event.subject_type = :subjectType', { subjectType: query.subjectType });
    }

    if (query.result) {
      qb.andWhere('event.result = :result', { result: query.result });
    }

    if (query.startDate) {
      qb.andWhere('event.created_at >= :startDate', { startDate: query.startDate });
    }

    if (query.endDate) {
      qb.andWhere('event.created_at <= :endDate', { endDate: query.endDate });
    }

    // Clone query builder for stats counts (before pagination)
    const statsQb = qb.clone();

    // Ordering and pagination
    qb.orderBy('event.createdAt', 'DESC').skip(skip).take(limit);

    const [events, total] = await qb.getManyAndCount();

    // Get allowed and denied counts for ALL matching records (without pagination)
    const allowedCount = await statsQb
      .clone()
      .andWhere('event.result = :allowedResult', { allowedResult: 'allowed' })
      .getCount();

    const deniedCount = await statsQb
      .clone()
      .andWhere('event.result = :deniedResult', { deniedResult: 'denied' })
      .getCount();

    console.log("Evnents:")

    return { events, total, allowedCount, deniedCount, page, limit };
  }

  async getStats(
    startDate: Date,
    endDate: Date,
    currentUser: User,
    gateId?: string,
  ): Promise<AccessEventStatsDto> {
    const qb = this.accessEventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.gate', 'gate');

    // Apply role-based access control
    this.applyRbacFilter(qb, currentUser);

    qb.andWhere('event.created_at BETWEEN :startDate AND :endDate', {
      startDate,
      endDate,
    });

    if (gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId });
    }

    const events = await qb.getMany();

    const stats: AccessEventStatsDto = {
      totalEvents: events.length,
      allowedCount: events.filter((e) => e.result === AccessResult.ALLOWED).length,
      deniedCount: events.filter((e) => e.result === AccessResult.DENIED).length,
      byMethod: {},
      byGate: {},
    };

    // Count by method
    for (const event of events) {
      stats.byMethod[event.method] = (stats.byMethod[event.method] || 0) + 1;

      if (event.gate) {
        if (!stats.byGate[event.gateId]) {
          stats.byGate[event.gateId] = { name: event.gate.name, count: 0 };
        }
        stats.byGate[event.gateId].count++;
      }
    }

    return stats;
  }

  async getLiveEvents(currentUser: User, gateId?: string, limit = 50): Promise<AccessEvent[]> {
    const qb = this.accessEventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.gate', 'gate');

    // Apply role-based access control
    this.applyRbacFilter(qb, currentUser);

    if (gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId });
    }

    return qb.orderBy('event.createdAt', 'DESC').take(limit).getMany();
  }

  async exportToCsv(query: AccessEventQueryDto, currentUser: User): Promise<string> {
    // Get retention days limit for non-super admin users
    const retentionDays = await this.getLogRetentionDays(currentUser);
    const retentionCutoff = new Date();
    retentionCutoff.setDate(retentionCutoff.getDate() - retentionDays);

    // Get all matching events (no pagination for export)
    const qb = this.accessEventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.gate', 'gate');

    // Apply role-based access control
    this.applyRbacFilter(qb, currentUser, query.tenantId);

    // Apply retention days limit for non-super admins
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      qb.andWhere('event.created_at >= :retentionCutoff', { retentionCutoff });
    }

    if (query.gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId: query.gateId });
    }

    if (query.method) {
      qb.andWhere('event.method = :method', { method: query.method });
    }

    if (query.subjectType) {
      qb.andWhere('event.subject_type = :subjectType', { subjectType: query.subjectType });
    }

    if (query.result) {
      qb.andWhere('event.result = :result', { result: query.result });
    }

    if (query.startDate) {
      qb.andWhere('event.created_at >= :startDate', { startDate: query.startDate });
    }

    if (query.endDate) {
      qb.andWhere('event.created_at <= :endDate', { endDate: query.endDate });
    }

    qb.orderBy('event.createdAt', 'DESC');

    const events = await qb.getMany();

    // Build CSV
    const headers = [
      'Timestamp',
      'Gate',
      'Method',
      'Subject Type',
      'Subject Name',
      'Subject ID',
      'Result',
      'Denial Reason',
      'Operator',
    ];

    const rows = events.map((e) => [
      e.timestamp.toISOString(),
      e.gate?.name || '',
      e.method,
      e.subjectType,
      e.subjectName || '',
      e.subjectIdentifier || '',
      e.result,
      e.denialReason || '',
      e.operatorName || '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    return csvContent;
  }
}
