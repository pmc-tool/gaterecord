import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessEventsService } from './access-events.service';
import { AccessEventsController } from './access-events.controller';
import { AccessEvent } from '@database/entities/access-event.entity';
import { Tenant } from '@database/entities/tenant.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AccessEvent, Tenant])],
  controllers: [AccessEventsController],
  providers: [AccessEventsService],
  exports: [AccessEventsService],
})
export class AccessEventsModule {}
