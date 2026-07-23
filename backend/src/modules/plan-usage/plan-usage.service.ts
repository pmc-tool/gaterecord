import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';

export interface UsageMeter {
  used: number;
  limit: number;
}

export interface PlanUsage {
  plan: { name: string; isDefault: boolean } | null;
  users: UsageMeter;
  gates: UsageMeter;
  vehicles: UsageMeter;
  passesThisMonth: UsageMeter;
}

/**
 * Reads live usage counts for a tenant against its plan's limits. Purely a read
 * — the authoritative create-time enforcement stays in each resource service.
 * The limits come from the plan row in the DB (no hardcoded numbers), matching
 * the settled "stored in the database" decision.
 */
@Injectable()
export class PlanUsageService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Gate)
    private readonly gateRepository: Repository<Gate>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(VisitorPass)
    private readonly visitorPassRepository: Repository<VisitorPass>,
  ) {}

  async getUsage(currentUser: User): Promise<PlanUsage> {
    const tenantId = currentUser.tenantId;
    if (!tenantId && currentUser.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('No building is associated with this account yet.');
    }
    if (!tenantId) {
      // Super admin with no tenant context — nothing tenant-scoped to report.
      return {
        plan: null,
        users: { used: 0, limit: 0 },
        gates: { used: 0, limit: 0 },
        vehicles: { used: 0, limit: 0 },
        passesThisMonth: { used: 0, limit: 0 },
      };
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
      relations: ['subscriptionPlan'],
    });
    const plan = tenant?.subscriptionPlan ?? null;

    // Month boundary matches visitor-pass.service's own per-month count.
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [users, gates, vehicles, passesThisMonth] = await Promise.all([
      this.userRepository.count({ where: { tenantId } }),
      this.gateRepository.count({ where: { tenantId } }),
      this.vehicleRepository.count({ where: { tenantId } }),
      this.visitorPassRepository.count({
        where: { tenantId, createdAt: MoreThan(startOfMonth) },
      }),
    ]);

    return {
      plan: plan ? { name: plan.name, isDefault: plan.isDefault } : null,
      users: { used: users, limit: plan?.maxUsers ?? 0 },
      gates: { used: gates, limit: plan?.maxGates ?? 0 },
      vehicles: { used: vehicles, limit: plan?.maxVehicles ?? 0 },
      passesThisMonth: {
        used: passesThisMonth,
        limit: plan?.maxVisitorPassesPerMonth ?? 0,
      },
    };
  }
}
