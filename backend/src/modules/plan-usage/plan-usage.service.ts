import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { Tenant } from '@database/entities/tenant.entity';
import { User, UserRole } from '@database/entities/user.entity';
import { Gate } from '@database/entities/gate.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { assertBuildingContext, isPlatformContext } from '@common/context/assert-building-context';
import { countSeats } from '../people/seat-limit';

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

/** Who sees a building's usage: its building admins, acting in it. */
const USAGE_ROLES: readonly UserRole[] = [UserRole.BUILDING_ADMIN];

/**
 * Reads live usage counts for a tenant against its plan's limits. Purely a read
 * — the authoritative create-time enforcement stays in each resource service.
 * The limits come from the plan row in the DB (no hardcoded numbers), matching
 * the settled "stored in the database" decision.
 *
 * The building is the one the request ACTS IN (assertBuildingContext): an admin
 * of Tower A and Tower D acting in D sees D's meters. The users meter is the
 * shared seat rule (people/seat-limit.ts countSeats: live memberships of the
 * building), the same number the add-person checks and the billing downgrade
 * check compare with maxUsers, so the meter never disagrees with a refusal.
 */
@Injectable()
export class PlanUsageService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Gate)
    private readonly gateRepository: Repository<Gate>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    @InjectRepository(VisitorPass)
    private readonly visitorPassRepository: Repository<VisitorPass>,
  ) {}

  async getUsage(currentUser: User): Promise<PlanUsage> {
    if (isPlatformContext(currentUser)) {
      // Super admin in the Platform context — nothing tenant-scoped to report.
      return {
        plan: null,
        users: { used: 0, limit: 0 },
        gates: { used: 0, limit: 0 },
        vehicles: { used: 0, limit: 0 },
        passesThisMonth: { used: 0, limit: 0 },
      };
    }

    // 409 MEMBERSHIP_REQUIRED without a building, 403 for a non-admin role
    // there: a null tenant never reaches the count queries below, where
    // TypeORM would drop the condition and count every building.
    const tenantId = assertBuildingContext(currentUser, USAGE_ROLES);

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
      countSeats(this.tenantRepository.manager, tenantId),
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
