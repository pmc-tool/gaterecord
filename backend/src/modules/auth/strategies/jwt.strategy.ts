import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { User } from '@database/entities/user.entity';
import { ActingUser, readMembershipHeader } from '@common/context/acting-user';
import { MembershipContextService } from '../../memberships/membership-context.service';
import { loadActiveLocalUser } from './load-active-local-user';

/**
 * Claims of a locally issued HS256 access token (AuthService.generateTokens).
 *
 * Only `sub` (gate_users.id) is used to authenticate. role and tenantId are
 * kept for the legacy SPA, which reads them from the token, and are purely
 * informational: they describe the session user at issue time (null when the
 * person has several buildings or none), and neither the strategy nor any guard
 * trusts them. The acting context always comes from the X-Gate-Membership header.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  /** @deprecated Informational only; never trusted. Use req.user.role. */
  role: string | null;
  /** @deprecated Informational only; never trusted. Use assertBuildingContext(req.user). */
  tenantId: string | null;
}

/**
 * 'jwt': locally issued HS256 tokens (JWT_SECRET), used by the legacy SPA.
 *
 * validate() loads the person (no relations: the context resolver loads the
 * building), keeps the platform-ban 401s ('User not found', 'User is not
 * active'), then resolves the acting context from the request's
 * X-Gate-Membership header. A 401 thrown here short-circuits passport, so the
 * 'keycloak' strategy is never tried for that request.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly membershipContextService: MembershipContextService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload): Promise<ActingUser> {
    const person = await loadActiveLocalUser(this.userRepository, payload?.sub, {
      withTenant: false,
    });

    return this.membershipContextService.resolve(person, readMembershipHeader(req));
  }
}
