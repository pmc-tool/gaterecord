import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GatewayService } from './gateway.service';
import { EventsGateway } from './events.gateway';
import { SocketContextService } from './socket-context.service';
import { AuthModule } from '../auth/auth.module';
import { SocketAuthService } from '../auth/socket-auth.service';
import { Gate } from '@database/entities/gate.entity';
import { User } from '@database/entities/user.entity';

/**
 * Realtime (Socket.IO) module.
 *
 * AuthModule is imported for the two things socket authentication needs from it:
 * JwtService (HS256, JWT_SECRET — AuthModule exports JwtModule) and
 * IdentityProvisioningService (Keycloak RS256 → gate user). SocketAuthService is
 * provided and exported HERE so the /events gateway and the default-namespace
 * SimulatorGateway share one instance (and one JWKS cache).
 *
 * SocketContextService (GATE-11) resolves each socket's membership context on
 * top of SocketAuthService, with MembershipContextService from the global
 * MembershipsModule, and re-reads the person (User repository) on every join,
 * switch and trigger. Both gateways use it. It also listens (@OnEvent, via the
 * global EventEmitterModule) for 'membership.changed', which MembershipsModule
 * publishes after a membership write commits, and re-checks the sockets of the
 * people concerned; no import of MembershipsModule is needed for that.
 *
 * Acyclic today: AuthModule → StripeModule / ResidentsModule never reach back to
 * GatewayModule. Keep it that way (or use forwardRef) if AuthModule gains imports.
 */
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([Gate, User])],
  providers: [GatewayService, EventsGateway, SocketAuthService, SocketContextService],
  exports: [GatewayService, SocketAuthService, SocketContextService],
})
export class GatewayModule {}
