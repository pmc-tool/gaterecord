import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GlobalUser } from '@database/entities/global-user.entity';
import { UserSyncController } from './user-sync.controller';
import { UserSyncService } from './user-sync.service';
import { ApiKeyGuard } from './guards/api-key.guard';

@Module({
  imports: [TypeOrmModule.forFeature([GlobalUser])],
  controllers: [UserSyncController],
  providers: [UserSyncService, ApiKeyGuard],
  exports: [UserSyncService],
})
export class UserSyncModule {}
