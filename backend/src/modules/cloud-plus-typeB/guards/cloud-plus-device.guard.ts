import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { CloudPlusService } from '../cloud-plus.service';

/**
 * Optional guard for Cloud Plus device authentication
 *
 * If enabled, validates that the device provides a valid API key.
 * The API key can be sent via:
 * - X-Api-Key header
 * - apiKey query parameter
 *
 * Usage: Apply to routes that require device authentication
 * @UseGuards(CloudPlusDeviceGuard)
 */
@Injectable()
export class CloudPlusDeviceGuard implements CanActivate {
  private readonly logger = new Logger(CloudPlusDeviceGuard.name);

  constructor(private readonly cloudPlusService: CloudPlusService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Get device serial from request
    const serial = this.getSerial(request);
    if (!serial) {
      this.logger.warn('Missing device serial in request');
      throw new UnauthorizedException('Device serial required');
    }

    // Get API key from request
    const apiKey = this.getApiKey(request);
    if (!apiKey) {
      // If no API key provided, allow request (optional auth)
      // Change this to throw error if you want mandatory auth
      this.logger.debug(`No API key provided for device ${serial}, allowing request`);
      return true;
    }

    // Verify API key
    const isValid = await this.cloudPlusService.verifyDeviceApiKey(serial, apiKey);
    if (!isValid) {
      this.logger.warn(`Invalid API key for device ${serial}`);
      throw new UnauthorizedException('Invalid API key');
    }

    this.logger.debug(`Device ${serial} authenticated successfully`);
    return true;
  }

  private getSerial(request: Request): string | undefined {
    // Try query parameter first
    const query = request.query as Record<string, any>;
    if (query.Serial) {
      return String(query.Serial);
    }

    // Try body
    const body = request.body as Record<string, any>;
    if (body?.Serial) {
      return String(body.Serial);
    }

    // Try Key (for GetStatus requests)
    if (query.Key) {
      return String(query.Key);
    }
    if (body?.Key) {
      return String(body.Key);
    }

    return undefined;
  }

  private getApiKey(request: Request): string | undefined {
    // Try X-Api-Key header
    const headerKey = request.headers['x-api-key'];
    if (headerKey) {
      return Array.isArray(headerKey) ? headerKey[0] : headerKey;
    }

    // Try Authorization header (Bearer token)
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Try query parameter
    const query = request.query as Record<string, any>;
    if (query.apiKey) {
      return String(query.apiKey);
    }

    return undefined;
  }
}
