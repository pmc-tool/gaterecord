import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { GatesModule } from './modules/gates/gates.module';
import { SimulatorModule } from './modules/simulator/simulator.module';
import { AccessEventsModule } from './modules/access-events/access-events.module';
import { ResidentsModule } from './modules/residents/residents.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { MqttModule } from './modules/mqtt/mqtt.module';
import { RfidModule } from './modules/rfid/rfid.module';
import { VisitorPassModule } from './modules/visitor-pass/visitor-pass.module';
import { NotificationModule } from './modules/notification/notification.module';
import { SecurityAlertModule } from './modules/security-alert/security-alert.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get<string>('DATABASE_URL'),
        ssl: configService.get<string>('DATABASE_SSL') === 'true'
          ? { rejectUnauthorized: false }
          : false,
        autoLoadEntities: true,
        synchronize: configService.get<string>('NODE_ENV') !== 'production',
        logging: configService.get<string>('NODE_ENV') === 'development',
      }),
      inject: [ConfigService],
    }),
    AuthModule,
    UsersModule,
    TenantsModule,
    GatesModule,
    SimulatorModule,
    AccessEventsModule,
    ResidentsModule,
    VehiclesModule,
    MqttModule,
    RfidModule,
    VisitorPassModule,
    NotificationModule,
    SecurityAlertModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
