import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CloudPlusController } from './cloud-plus.controller';
import { CloudPlusService } from './cloud-plus.service';
import { CloudPlusDeviceGuard } from './guards/cloud-plus-device.guard';
import { GatewayModule } from '../gateway/gateway.module';

// Entities
import { DeviceConfig } from '@database/entities/device-config.entity';
import { Gate } from '@database/entities/gate.entity';
import { Vehicle } from '@database/entities/vehicle.entity';
import { RfidCard } from '@database/entities/rfid-card.entity';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { AccessEvent } from '@database/entities/access-event.entity';
import { User } from '@database/entities/user.entity';

/**
 * Cloud Plus TypeB Module
 *
 * Handles HTTP communication with Cloud Plus gate controllers.
 *
 * Public endpoints (no auth required):
 * - GET/POST /SearchCardAcs - Card/credential validation
 * - GET/POST /GetStatus - Device heartbeat
 *
 * Protected endpoints (JWT auth required):
 * - POST /cloud-plus/devices - Register new controller
 * - GET /cloud-plus/devices - List registered controllers
 *
 * Features:
 * - Multi-tenant support via device serial → tenant mapping
 * - RFID card validation (vehicles & pedestrian cards)
 * - QR code / visitor pass validation
 * - Access event logging
 * - Real-time WebSocket notifications
 *
 * Configuration:
 * 1. Register Cloud Plus controller via admin API
 * 2. Configure controller to point to your server:
 *    - Server IP: Your backend IP
 *    - Server Port: Your backend port (e.g., 3001)
 *    - Card URL: /SearchCardAcs?
 *    - Heartbeat URL: /GetStatus?
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceConfig, Gate, Vehicle, RfidCard, VisitorPass, AccessEvent, User]),
    GatewayModule,
  ],
  controllers: [CloudPlusController],
  providers: [CloudPlusService, CloudPlusDeviceGuard],
  exports: [CloudPlusService],
})
export class CloudPlusModule {}
