import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { GatesModule } from './modules/gates/gates.module';
import { SimulatorModule } from './modules/simulator/simulator.module';
import { AccessEventsModule } from './modules/access-events/access-events.module';
import { ResidentsModule } from './modules/residents/residents.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { RfidModule } from './modules/rfid/rfid.module';
import { VisitorPassModule } from './modules/visitor-pass/visitor-pass.module';
import { NotificationModule } from './modules/notification/notification.module';
import { SecurityAlertModule } from './modules/security-alert/security-alert.module';
import { DevicesModule } from './modules/devices/devices.module';
import { CloudPlusModule } from './modules/cloud-plus-typeB/cloud-plus.module';
import { CloudPlusTcpModule } from './modules/cloud-plus-typeB-tcp/cloud-plus-tcp.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UserSyncModule } from './modules/user-sync/user-sync.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PlanUsageModule } from './modules/plan-usage/plan-usage.module';
import { ResidentRequestsModule } from './modules/resident-requests/resident-requests.module';
import { BuildingStructureModule } from './modules/building-structure/building-structure.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { PeopleModule } from './modules/people/people.module';
import { resolveSynchronize } from './database/database-host';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { SubscriptionGuard } from './common/guards/subscription.guard';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const url = configService.get<string>('DATABASE_URL');

        // synchronize stays a development convenience, but never against a
        // shared database: a developer running with NODE_ENV unset against the
        // staging URL would otherwise have TypeORM create tables without their
        // migration backfill and drop indexes only migrations declare.
        const { synchronize, refusedReason } = resolveSynchronize({
          wanted: configService.get<string>('NODE_ENV') !== 'production',
          url,
          allowRemoteSync: configService.get<string>('ALLOW_REMOTE_SYNC') === '1',
        });
        if (refusedReason) {
          new Logger('Database').warn(refusedReason);
        }

        return {
          type: 'postgres',
          url,
          ssl:
            configService.get<string>('DATABASE_SSL') === 'true'
              ? { rejectUnauthorized: false }
              : false,
          autoLoadEntities: true,
          synchronize,
          logging: configService.get<string>('TYPEORM_LOGGING') === 'true',
        };
      },
      inject: [ConfigService],
    }),
    MembershipsModule,
    PeopleModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    GatesModule,
    SimulatorModule,
    AccessEventsModule,
    ResidentsModule,
    VehiclesModule,
    RfidModule,
    VisitorPassModule,
    NotificationModule,
    SecurityAlertModule,
    DevicesModule,
    CloudPlusModule,
    CloudPlusTcpModule,
    StripeModule,
    SettingsModule,
    UserSyncModule,
    OnboardingModule,
    PlanUsageModule,
    ResidentRequestsModule,
    BuildingStructureModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Runs AFTER JwtAuthGuard (registration order = execution order for
    // APP_GUARDs). JwtAuthGuard authenticates and populates req.user with the
    // acting context first (the chosen membership's building, or the gate_users
    // row's tenant in legacy mode); SubscriptionGuard then reads
    // req.user.tenant.status to enforce read-only grace on the building the
    // request acts in. Fail-open for legacy principals; a membership context
    // without a building fails closed.
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard,
    },
  ],
})
export class AppModule {}
