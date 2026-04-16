import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { User } from '@database/entities/user.entity';
import { LoginHistory } from '@database/entities/login-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, LoginHistory])],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
