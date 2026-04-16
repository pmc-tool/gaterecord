import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@database/entities/user.entity';
import { NotificationService } from './notification.service';
import {
  NotificationQueryDto,
  NotificationResponseDto,
  NotificationCountDto,
  MarkAsReadDto,
} from './dto/notification.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'Get notifications for current user' })
  @ApiResponse({ status: 200, description: 'List of notifications' })
  async findAll(
    @CurrentUser() user: User,
    @Query() query: NotificationQueryDto,
  ): Promise<{ notifications: NotificationResponseDto[]; total: number; page: number; limit: number }> {
    const page = parseInt(query.page || '1', 10);
    const limit = parseInt(query.limit || '20', 10);
    const { notifications, total } = await this.notificationService.findForUser(user.id, query);
    return { notifications, total, page, limit };
  }

  @Get('counts')
  @ApiOperation({ summary: 'Get notification counts for current user' })
  @ApiResponse({ status: 200, type: NotificationCountDto })
  async getCounts(@CurrentUser() user: User): Promise<NotificationCountDto> {
    return this.notificationService.getCountsForUser(user.id);
  }

  @Get('unread')
  @ApiOperation({ summary: 'Get unread notifications for current user' })
  @ApiResponse({ status: 200, description: 'List of unread notifications' })
  async findUnread(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
  ): Promise<NotificationResponseDto[]> {
    const { notifications } = await this.notificationService.findForUser(user.id, {
      isRead: false,
      limit: limit || '10',
    });
    return notifications;
  }

  @Post('mark-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark specific notifications as read' })
  @ApiResponse({ status: 200, description: 'Notifications marked as read' })
  async markAsRead(
    @CurrentUser() user: User,
    @Body() dto: MarkAsReadDto,
  ): Promise<{ success: boolean }> {
    await this.notificationService.markAsRead(user.id, dto.notificationIds);
    return { success: true };
  }

  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  async markAllAsRead(@CurrentUser() user: User): Promise<{ success: boolean }> {
    await this.notificationService.markAllAsRead(user.id);
    return { success: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a notification' })
  @ApiResponse({ status: 204, description: 'Notification deleted' })
  async delete(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<void> {
    await this.notificationService.delete(user.id, id);
  }
}
