import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { VisitorPass } from '@database/entities/visitor-pass.entity';
import { Tenant } from '@database/entities/tenant.entity';
import { VisitorPassService } from './visitor-pass.service';
import { VisitorPassController } from './visitor-pass.controller';

@Module({
  imports: [TypeOrmModule.forFeature([VisitorPass, Tenant]), ConfigModule],
  controllers: [VisitorPassController],
  providers: [VisitorPassService],
  exports: [VisitorPassService],
})
export class VisitorPassModule {}
