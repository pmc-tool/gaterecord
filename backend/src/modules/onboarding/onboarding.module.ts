import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { BuildingJoinRequest } from '@database/entities/building-join-request.entity';

/**
 * Self-contained: depends only on the repositories it touches. It deliberately
 * does NOT import AuthModule — onboarding issues no tokens and needs nothing
 * from AuthService. Authentication is handled by the global JwtAuthGuard.
 *
 * BuildingJoinRequest is read-only here: GET /onboarding/status reports whether
 * the caller is waiting on a building admin. Writing requests belongs to
 * ResidentRequestsModule.
 *
 * Registered in src/app.module.ts (an older comment here claimed otherwise).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Tenant, SubscriptionPlan, BuildingJoinRequest])],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
