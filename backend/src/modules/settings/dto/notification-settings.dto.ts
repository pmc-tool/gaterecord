import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({ description: 'Enable push notifications' })
  @IsBoolean()
  @IsOptional()
  pushNotifications?: boolean;

  @ApiPropertyOptional({ description: 'Enable email alerts' })
  @IsBoolean()
  @IsOptional()
  emailAlerts?: boolean;

  @ApiPropertyOptional({ description: 'Enable security alerts' })
  @IsBoolean()
  @IsOptional()
  securityAlerts?: boolean;

  @ApiPropertyOptional({ description: 'Enable visitor notifications' })
  @IsBoolean()
  @IsOptional()
  visitorNotifications?: boolean;
}

export class NotificationSettingsResponseDto {
  pushNotifications: boolean;
  emailAlerts: boolean;
  securityAlerts: boolean;
  visitorNotifications: boolean;
}
