import {
  Controller,
  Post,
  Body,
  Param,
  Patch,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SimulatorService } from './simulator.service';
import {
  TriggerEventDto,
  SimulatorFeedbackDto,
  SetOnlineDto,
  UpdateSensorDto,
} from './dto/simulator.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User, UserRole } from '@database/entities/user.entity';

@ApiTags('Simulator')
@ApiBearerAuth()
@Controller('simulator')
@UseGuards(RolesGuard)
export class SimulatorController {
  constructor(private readonly simulatorService: SimulatorService) {}

  @Post(':gateId/trigger')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Trigger a simulated gate event' })
  @ApiResponse({ status: 200, description: 'Event processed', type: SimulatorFeedbackDto })
  trigger(
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() dto: TriggerEventDto,
    @CurrentUser() user: User,
  ): Promise<SimulatorFeedbackDto> {
    return this.simulatorService.triggerEvent(gateId, dto, user);
  }

  @Patch(':gateId/online')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Set gate online/offline status' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  setOnline(
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() dto: SetOnlineDto,
    @CurrentUser() user: User,
  ) {
    return this.simulatorService.setOnlineStatus(gateId, dto.isOnline, user);
  }

  @Patch(':gateId/sensor')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update sensor status' })
  @ApiResponse({ status: 200, description: 'Sensor updated' })
  updateSensor(
    @Param('gateId', ParseUUIDPipe) gateId: string,
    @Body() dto: UpdateSensorDto,
    @CurrentUser() user: User,
  ) {
    return this.simulatorService.updateSensor(gateId, dto, user);
  }
}
