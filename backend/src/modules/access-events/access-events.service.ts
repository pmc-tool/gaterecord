import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { AccessEvent, AccessResult } from '@database/entities/access-event.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { AccessEventQueryDto, AccessEventStatsDto } from './dto/access-event.dto';

@Injectable()
export class AccessEventsService {
  constructor(
    @InjectRepository(AccessEvent)
    private accessEventRepository: Repository<AccessEvent>,
  ) {}

  async findAll(
    query: AccessEventQueryDto,
    currentUser: User,
  ): Promise<{ events: AccessEvent[]; total: number; page: number; limit: number }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const qb = this.accessEventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.gate', 'gate');

    // Tenant isolation
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      qb.where('event.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    // Filters
    if (query.gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId: query.gateId });
    }

    if (query.method) {
      qb.andWhere('event.method = :method', { method: query.method });
    }

    if (query.result) {
      qb.andWhere('event.result = :result', { result: query.result });
    }

    if (query.startDate) {
      qb.andWhere('event.timestamp >= :startDate', { startDate: query.startDate });
    }

    if (query.endDate) {
      qb.andWhere('event.timestamp <= :endDate', { endDate: query.endDate });
    }

    // Ordering and pagination
    qb.orderBy('event.timestamp', 'DESC').skip(skip).take(limit);

    const [events, total] = await qb.getManyAndCount();

    return { events, total, page, limit };
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

    // Tenant isolation
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      qb.where('event.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    qb.andWhere('event.timestamp BETWEEN :startDate AND :endDate', {
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

    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      qb.where('event.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    if (gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId });
    }

    return qb.orderBy('event.timestamp', 'DESC').take(limit).getMany();
  }

  async exportToCsv(query: AccessEventQueryDto, currentUser: User): Promise<string> {
    // Get all matching events (no pagination for export)
    const qb = this.accessEventRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.gate', 'gate');

    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      qb.where('event.tenant_id = :tenantId', { tenantId: currentUser.tenantId });
    }

    if (query.gateId) {
      qb.andWhere('event.gate_id = :gateId', { gateId: query.gateId });
    }

    if (query.method) {
      qb.andWhere('event.method = :method', { method: query.method });
    }

    if (query.result) {
      qb.andWhere('event.result = :result', { result: query.result });
    }

    if (query.startDate) {
      qb.andWhere('event.timestamp >= :startDate', { startDate: query.startDate });
    }

    if (query.endDate) {
      qb.andWhere('event.timestamp <= :endDate', { endDate: query.endDate });
    }

    qb.orderBy('event.timestamp', 'DESC');

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
