import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({ description: 'Receive email notifications' })
  @IsBoolean()
  @IsOptional()
  emailNotifications?: boolean;

  @ApiPropertyOptional({ description: 'Receive in-app (bell) notifications' })
  @IsBoolean()
  @IsOptional()
  inAppNotifications?: boolean;
}

export class NotificationSettingsResponseDto {
  emailNotifications: boolean;
  inAppNotifications: boolean;
}
