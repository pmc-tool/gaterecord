import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessEventsService } from './access-events.service';
import { AccessEventsController } from './access-events.controller';
import { AccessEventsRetentionCron } from './access-events-retention.cron';
import { AccessEvent } from '@database/entities/access-event.entity';
import { Tenant } from '@database/entities/tenant.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AccessEvent, Tenant])],
  controllers: [AccessEventsController],
  providers: [AccessEventsService, AccessEventsRetentionCron],
  exports: [AccessEventsService],
})
export class AccessEventsModule {}
