import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateNotificationSettingsDto } from './dto/notification-settings.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { User } from '@database/entities/user.entity';
import { RolesGuard } from '@common/guards/roles.guard';

@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
@UseGuards(RolesGuard)
// Self-service account settings (change own password, notification prefs). These
// are personal account operations, not tenant business writes, so they stay
// available while suspended (err toward exemption for self-service).
@SubscriptionExempt()
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  // ==================== Security / Password ====================

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change current user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid password or passwords do not match' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @CurrentUser() user: User,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    return this.settingsService.changePassword(user.id, changePasswordDto);
  }

  // ==================== Notifications ====================

  @Get('notifications')
  @ApiOperation({ summary: 'Get notification settings' })
  @ApiResponse({ status: 200, description: 'Notification settings' })
  async getNotificationSettings(@CurrentUser() user: User) {
    return this.settingsService.getNotificationSettings(user.id);
  }

  @Patch('notifications')
  @ApiOperation({ summary: 'Update notification settings' })
  @ApiResponse({ status: 200, description: 'Notification settings updated' })
  async updateNotificationSettings(
    @CurrentUser() user: User,
    @Body() dto: UpdateNotificationSettingsDto,
  ) {
    return this.settingsService.updateNotificationSettings(user.id, dto);
  }

  // ==================== Login Activity ====================

  @Get('login-activity')
  @ApiOperation({ summary: 'Get login activity history' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Number of records to return' })
  @ApiResponse({ status: 200, description: 'Login activity history' })
  async getLoginActivity(
    @CurrentUser() user: User,
    @Query('limit') limit?: number,
  ) {
    return this.settingsService.getLoginHistory(user.id, limit || 20);
  }
}
