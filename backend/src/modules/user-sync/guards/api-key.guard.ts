import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Named to match the sibling `ride` and `core` services, which already validate
 * their own `/user-sync` ingest against a comma-separated `VALID_API_KEYS` and
 * the same `x-api-key` header. One operator configures all three, so the name is
 * kept identical deliberately.
 */
export const VALID_API_KEYS_ENV = 'VALID_API_KEYS';

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison operands are always the same
 * length - `timingSafeEqual` throws on a length mismatch, and comparing raw
 * keys would leak the configured key length.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Authenticates machine-to-machine ingest calls with a shared `x-api-key`
 * header, validated against the comma-separated `VALID_API_KEYS` env var.
 *
 * Fails closed: a missing, empty or whitespace-only header is rejected, and so
 * is every request when no keys are configured. Key material is never logged.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    const presentedKey = this.extractApiKey(request?.headers?.['x-api-key']);
    if (!presentedKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    const configuredKeys = this.getConfiguredKeys();
    if (configuredKeys.length === 0) {
      this.logger.error(
        `${VALID_API_KEYS_ENV} is not configured - rejecting all user sync requests`,
      );
      throw new UnauthorizedException('Invalid API key');
    }

    // Reduce rather than `some` so every candidate is compared and the number
    // of comparisons does not depend on which key matched.
    const isValid = configuredKeys.reduce(
      (matched, candidate) => timingSafeEqualStrings(presentedKey, candidate) || matched,
      false,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }

  private extractApiKey(header: string | string[] | undefined): string | null {
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private getConfiguredKeys(): string[] {
    const configured = this.configService.get<string>(VALID_API_KEYS_ENV);
    if (typeof configured !== 'string') {
      return [];
    }
    return configured
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0);
  }
}
