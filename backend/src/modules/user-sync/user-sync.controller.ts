import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@common/decorators/public.decorator';
import { UserSyncService } from './user-sync.service';
import { SyncUsersDto, SyncUsersResult } from './dto/sync-users.dto';
import { ApiKeyGuard } from './guards/api-key.guard';

@ApiTags('User Sync')
@Controller('user-sync')
export class UserSyncController {
  constructor(private readonly userSyncService: UserSyncService) {}

  /**
   * Ingest endpoint for the upstream account service.
   *
   * `@Public()` exempts the route from the global JwtAuthGuard (APP_GUARD) -
   * this is a machine-to-machine call with no user JWT. Authentication is
   * handled instead by ApiKeyGuard, which fails closed.
   */
  @Post()
  @Public()
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-api-key', description: 'Shared user sync API key', required: true })
  @ApiOperation({ summary: 'Mirror account service users into the global users table' })
  @ApiResponse({ status: 200, description: 'Batch processed; returns per-batch counts' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  async syncUsers(@Body() dto: SyncUsersDto): Promise<SyncUsersResult> {
    return this.userSyncService.syncUsers(dto);
  }
}
