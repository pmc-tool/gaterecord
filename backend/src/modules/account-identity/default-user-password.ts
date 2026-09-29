import { ConfigService } from '@nestjs/config';

/**
 * The env var holding the password every NEW account an admin adds (Users and
 * Residents pages) starts with. Never hardcoded: it lives in configuration only.
 */
export const DEFAULT_USER_PASSWORD_ENV = 'GATE_DEFAULT_USER_PASSWORD';

/** The account service refuses shorter passwords (POST /v1/internal/users). */
const ACCOUNT_MIN_PASSWORD_LENGTH = 8;

export type DefaultUserPassword =
  | { password: string }
  | { password: undefined; reason: 'unset' | 'too_short' };

/**
 * The single source of truth for the starting password of an admin-created
 * account. Admins can no longer choose one: a password an admin typed was only
 * ever used for a brand-new identity and silently ignored for an existing one,
 * which is how a second building's admin "set" a password nobody could use.
 *
 * Unset, empty, or shorter than the account service accepts: no password, so
 * the account service generates one (the behaviour before this setting). The
 * caller logs why; the value itself is never logged.
 */
export function resolveDefaultUserPassword(config: ConfigService): DefaultUserPassword {
  const value = config.get<string>(DEFAULT_USER_PASSWORD_ENV)?.trim();
  if (!value) {
    return { password: undefined, reason: 'unset' };
  }
  if (value.length < ACCOUNT_MIN_PASSWORD_LENGTH) {
    return { password: undefined, reason: 'too_short' };
  }
  return { password: value };
}
