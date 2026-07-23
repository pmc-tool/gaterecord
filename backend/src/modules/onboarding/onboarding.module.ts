import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { User } from '@database/entities/user.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';

/**
 * Self-contained: depends only on the three repositories it writes to. It
 * deliberately does NOT import AuthModule — onboarding issues no tokens and needs
 * nothing from AuthService. Authentication is handled by the global JwtAuthGuard.
 *
 * NOT YET REGISTERED: the wiring agent must add OnboardingModule to the imports
 * array in src/app.module.ts for these routes to exist.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Tenant, SubscriptionPlan])],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
