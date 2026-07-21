import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Body of POST {ACCOUNT_API_URL}/internal/users. Snake_case is the account service's shape. */
export interface ProvisionIdentityInput {
  email: string;
  first_name: string;
  last_name: string;
  phone?: string;
  /** Optional. Omitted => the account service generates a strong password. */
  password?: string;
  /**
   * When false, the account service does NOT email the credentials - gaterecord
   * sends its own branded email (which knows the building, role and creator)
   * using the returned password. Defaults to true account-side.
   */
  sendEmail?: boolean;
}

/** `data` payload of the account response, unwrapped from the envelope. */
export interface ProvisionedIdentity {
  /** Keycloak `sub`. gaterecord stores this as gate_users.user_id. */
  id: string;
  email: string;
  /** false = the identity already existed (idempotent replay of a retry). */
  created: boolean;
  /** false when no credentials email was sent (replay, delivery failure, or sendEmail=false). */
  emailSent: boolean;
  /**
   * The password to sign in with - supplied or account-generated. Present when
   * created=true so gaterecord can email it; undefined on an idempotent replay.
   */
  password?: string;
}

/**
 * The account service wraps EVERY response in this envelope via its global
 * ResponseInterceptor - including errors, which come back as HTTP 200 with
 * `status: false`. Never branch on the HTTP status alone.
 */
interface AccountEnvelope<T> {
  status?: boolean;
  path?: string;
  statusCode?: number;
  message?: string;
  data?: T;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Thin client for the account service's internal provisioning surface.
 *
 * The account service is the platform's identity authority: it owns Keycloak,
 * password generation and credential delivery. gaterecord calls it so that a
 * person an admin adds here can sign in across the whole platform, not just in
 * gate management.
 *
 * Deliberately uses global `fetch` (Node 20) rather than adding axios or
 * @nestjs/axios - neither is a dependency of this backend and one POST does not
 * justify a new package.
 *
 * There is no retry. Provisioning is not free of side effects from our side (a
 * Keycloak user may exist even when we saw a timeout), and blind retries would
 * multiply credential emails. The account endpoint IS idempotent by email, so a
 * caller-driven retry - i.e. the admin resubmitting the form - resolves cleanly.
 */
@Injectable()
export class AccountIdentityClient {
  private readonly logger = new Logger(AccountIdentityClient.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Creates (or returns, if it already exists) the platform identity for this person.
   *
   * @throws ServiceUnavailableException when the account service is unreachable,
   *         times out, or is misconfigured on our side.
   * @throws InternalServerErrorException when it answers but refuses or misbehaves.
   */
  async provisionUser(
    input: ProvisionIdentityInput,
  ): Promise<ProvisionedIdentity> {
    const url = `${this.getBaseUrl()}/internal/users`;
    const serviceKey = this.getServiceKey();
    const timeoutMs = this.getTimeoutMs();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': serviceKey,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : (error as Error)?.message;
      // Never log the request body: it can carry a password.
      this.logger.error(
        `Account service provisioning request failed (${url}): ${reason}`,
      );
      throw new ServiceUnavailableException(
        'Could not reach the account service to create the platform login. No user was created. Please try again.',
      );
    } finally {
      clearTimeout(timer);
    }

    let body: AccountEnvelope<ProvisionedIdentity> | null = null;
    try {
      body = (await response.json()) as AccountEnvelope<ProvisionedIdentity>;
    } catch {
      body = null;
    }

    // Errors arrive as HTTP 200 + status:false (ResponseInterceptor), while guard
    // rejections bypass that interceptor and arrive as a real non-2xx. Handle both.
    if (!response.ok || body?.status === false) {
      const upstreamCode = body?.statusCode ?? response.status;
      const upstreamMessage = body?.message || response.statusText;
      this.logger.error(
        `Account service rejected provisioning (upstream status ${upstreamCode}): ${upstreamMessage}`,
      );
      throw new InternalServerErrorException(
        `The account service could not create the platform login: ${upstreamMessage}`,
      );
    }

    const data = body?.data;
    if (!data?.id) {
      this.logger.error(
        'Account service returned a success envelope with no user id; cannot link the gate user.',
      );
      throw new InternalServerErrorException(
        'The account service returned an unexpected response while creating the platform login.',
      );
    }

    return {
      id: data.id,
      email: data.email,
      created: data.created === true,
      emailSent: data.emailSent === true,
      password: data.password,
    };
  }

  /** Base URL including the account service's version prefix, e.g. http://localhost:4001/v1 */
  private getBaseUrl(): string {
    const raw = this.configService.get<string>('ACCOUNT_API_URL')?.trim();
    if (!raw) {
      this.logger.error(
        'ACCOUNT_API_URL is not configured; platform identities cannot be created.',
      );
      throw new ServiceUnavailableException(
        'User provisioning is not configured on this server. Please contact support.',
      );
    }
    return raw.replace(/\/+$/, '');
  }

  private getServiceKey(): string {
    const key = this.configService.get<string>('ACCOUNT_SERVICE_KEY')?.trim();
    if (!key) {
      // Fail closed and say what is missing - never what its value is.
      this.logger.error(
        'ACCOUNT_SERVICE_KEY is not configured; platform identities cannot be created.',
      );
      throw new ServiceUnavailableException(
        'User provisioning is not configured on this server. Please contact support.',
      );
    }
    return key;
  }

  private getTimeoutMs(): number {
    const configured = Number(
      this.configService.get<string>('ACCOUNT_API_TIMEOUT_MS'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_TIMEOUT_MS;
  }
}
