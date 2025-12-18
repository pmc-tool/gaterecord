import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessEventsService } from './access-events.service';
import { AccessEventsController } from './access-events.controller';
import { AccessEvent } from '@database/entities/access-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AccessEvent])],
  controllers: [AccessEventsController],
  providers: [AccessEventsService],
  exports: [AccessEventsService],
})
export class AccessEventsModule {}
