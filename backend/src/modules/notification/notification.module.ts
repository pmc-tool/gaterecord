import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailService } from './email.service';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { Notification } from '@database/entities/notification.entity';
import { User } from '@database/entities/user.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Notification, User])],
  controllers: [NotificationController],
  providers: [EmailService, NotificationService],
  exports: [EmailService, NotificationService],
})
export class NotificationModule {}
