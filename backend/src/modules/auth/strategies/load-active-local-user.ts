/**
 * The person lookup behind a locally-issued HS256 token, as a plain function.
 *
 * JwtStrategy.validate (./jwt.strategy.ts) does exactly this for HTTP requests;
 * SocketAuthService (../socket-auth.service.ts) needs the same rule for socket
 * handshakes, which never pass through passport. Keeping one copy means a status
 * rule added here (a platform ban, say) reaches both transports at once.
 */
import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User, UserStatus } from '@database/entities/user.entity';

/** gate_users.id is a uuid column; anything else would be a driver error, not a 401. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoadActiveLocalUserOptions {
  /**
   * Load the legacy `tenant` relation too (default true, what the socket path
   * expects). JwtStrategy passes false: MembershipContextService loads the
   * building the request acts in, in both modes.
   */
  withTenant?: boolean;
}

/**
 * Loads the gate_users row named by an HS256 token's `sub` (gate_users.id) and
 * refuses anyone who is missing or not ACTIVE — the same two 401s, with the same
 * messages, that JwtStrategy.validate has always thrown. A non-ACTIVE
 * gate_users.status is the platform-wide block (a ban, or until the status
 * split the dual-written status of a single-building person).
 */
export async function loadActiveLocalUser(
  userRepository: Repository<User>,
  sub: unknown,
  options: LoadActiveLocalUserOptions = {},
): Promise<User> {
  if (typeof sub !== 'string' || !UUID_PATTERN.test(sub)) {
    throw new UnauthorizedException('User not found');
  }

  const user = await userRepository.findOne({
    where: { id: sub },
    ...(options.withTenant === false ? {} : { relations: ['tenant'] }),
  });

  if (!user) {
    throw new UnauthorizedException('User not found');
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new UnauthorizedException('User is not active');
  }

  return user;
}
