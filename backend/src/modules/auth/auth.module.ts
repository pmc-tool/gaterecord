import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { KeycloakStrategy } from './strategies/keycloak.strategy';
import { IdentityProvisioningService } from './identity-provisioning.service';
import { User } from '@database/entities/user.entity';
import { GlobalUser } from '@database/entities/global-user.entity';
import { RefreshToken } from '@database/entities/refresh-token.entity';
import { PasswordResetToken } from '@database/entities/password-reset-token.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { SubscriptionPlan } from '@database/entities/subscription-plan.entity';
import { LoginHistory } from '@database/entities/login-history.entity';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [
    // GlobalUser is the platform-wide `users` mirror written by
    // IdentityProvisioningService on every Keycloak-authenticated request.
    TypeOrmModule.forFeature([User, RefreshToken, PasswordResetToken, Tenant, SubscriptionPlan, LoginHistory, GlobalUser]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    StripeModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_ACCESS_EXPIRATION', '7d'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  // DUAL-ACCEPT PHASE. JwtStrategy ('jwt', HS256/JWT_SECRET) is untouched and
  // remains the defaultStrategy; KeycloakStrategy ('keycloak', RS256/JWKS) is
  // registered ALONGSIDE it so JwtAuthGuard can accept either. Registration is
  // unconditional on purpose: an unregistered strategy named in the guard makes
  // passport raise 'Unknown authentication strategy', which the guard only
  // downgrades to a logged 401 as a safety net.
  providers: [AuthService, JwtStrategy, KeycloakStrategy, IdentityProvisioningService],
  exports: [AuthService, JwtModule, IdentityProvisioningService],
})
export class AuthModule {}
