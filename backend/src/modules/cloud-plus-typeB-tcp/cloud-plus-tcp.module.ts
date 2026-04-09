import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { CloudPlusTcpServer } from './cloud-plus-tcp.server';
import { CloudPlusTcpService } from './cloud-plus-tcp.service';
import { CloudPlusTcpController, TcpServerController } from './cloud-plus-tcp.controller';

import { GatewayModule } from '../gateway/gateway.module';
import { CloudPlusModule } from '../cloud-plus-typeB/cloud-plus.module';

// Entities
import { DeviceConfig } from '@database/entities/device-config.entity';
import { Gate } from '@database/entities/gate.entity';
import { AccessEvent } from '@database/entities/access-event.entity';

/**
 * Cloud Plus TypeB TCP Module
 *
 * Provides direct TCP communication with Cloud Plus gate controllers.
 * This enables push commands (Open Gate, Close Gate) without waiting
 * for controller-initiated requests.
 *
 * TCP Server:
 * - Listens on TCP_PORT (default: 8002)
 * - Maintains persistent connections with controllers
 * - Handles heartbeats and card swipe events
 *
 * API Endpoints:
 *
 * Gate Control (JWT required):
 * - POST /api/v1/gates/:gateId/tcp/open - Open gate
 * - POST /api/v1/gates/:gateId/tcp/close - Close gate
 * - POST /api/v1/gates/:gateId/tcp/control - Generic control
 * - POST /api/v1/gates/:gateId/tcp/open-with-info - Open with LCD display
 * - POST /api/v1/gates/:gateId/tcp/alarm - Set alarm state
 * - POST /api/v1/gates/:gateId/tcp/fire - Emergency fire mode
 * - POST /api/v1/gates/:gateId/tcp/sync-time - Sync controller time
 * - POST /api/v1/gates/:gateId/tcp/restart - Restart controller
 * - GET /api/v1/gates/:gateId/tcp/connected - Check connection status
 *
 * Server Status:
 * - GET /api/v1/tcp/status - TCP server status (Super Admin)
 * - GET /api/v1/tcp/controllers - Connected controllers
 *
 * Configuration:
 * 1. Set TCP_PORT environment variable (default: 8002)
 * 2. Configure Cloud Plus controller TCP settings:
 *    - Server IP: Your backend IP
 *    - Server Port: TCP_PORT (e.g., 8002)
 * 3. Register device via HTTP API first (to associate with tenant/gate)
 *
 * Event Flow:
 * 1. Controller connects via TCP
 * 2. Controller sends heartbeat (0x56) with serial number
 * 3. Server identifies controller and sends ack
 * 4. Admin clicks "Open Gate" in frontend
 * 5. API sends OpenDoor (0x2C) command via TCP
 * 6. Gate opens immediately
 *
 * Card Swipe Flow:
 * 1. User swipes card at reader
 * 2. Controller sends RequestEvent (0x53) via TCP
 * 3. Server validates card (reuses CloudPlusService)
 * 4. Server sends RequestEventAck (0x54) with allow/deny
 * 5. Gate opens/stays closed based on response
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([DeviceConfig, Gate, AccessEvent]),
    GatewayModule,
    forwardRef(() => CloudPlusModule),
  ],
  controllers: [CloudPlusTcpController, TcpServerController],
  providers: [CloudPlusTcpServer, CloudPlusTcpService],
  exports: [CloudPlusTcpService, CloudPlusTcpServer],
})
export class CloudPlusTcpModule {}
