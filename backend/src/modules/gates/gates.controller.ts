import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { GatesService } from './gates.service';
import { CreateGateDto, UpdateGateDto, GateResponseDto, GateHealthDto } from './dto/gate.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User, UserRole } from '@database/entities/user.entity';

@ApiTags('Gates')
@ApiBearerAuth()
@Controller('gates')
@UseGuards(RolesGuard)
export class GatesController {
  private readonly logger = new Logger(GatesController.name);

  constructor(private readonly gatesService: GatesService) {}

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create a new gate' })
  @ApiResponse({ status: 201, description: 'Gate created', type: GateResponseDto })
  create(@Body() dto: CreateGateDto, @CurrentUser() user: User) {
    return this.gatesService.create(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Get all gates for tenant' })
  @ApiResponse({ status: 200, description: 'List of gates', type: [GateResponseDto] })
  findAll(@CurrentUser() user: User) {
    return this.gatesService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get gate by ID' })
  @ApiResponse({ status: 200, description: 'Gate details', type: GateResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.gatesService.findOne(id, user);
  }

  @Get(':id/health')
  @ApiOperation({ summary: 'Get gate health status' })
  @ApiResponse({ status: 200, description: 'Gate health', type: GateHealthDto })
  getHealth(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.gatesService.getHealth(id, user);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update gate' })
  @ApiResponse({ status: 200, description: 'Gate updated', type: GateResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGateDto,
    @CurrentUser() user: User,
  ) {
    return this.gatesService.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Delete gate' })
  @ApiResponse({ status: 204, description: 'Gate deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: User) {
    return this.gatesService.remove(id, user);
  }

  @Post(':id/control')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Control gate (open/close)' })
  @ApiResponse({ status: 200, description: 'Command sent' })
  async control(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { action: 'OPEN' | 'CLOSE' | 'STOP' },
    @CurrentUser() user: User,
  ) {
    const gate = await this.gatesService.findOne(id, user);

    if (!gate.hardwareId) {
      return { success: false, message: 'No hardware device linked to this gate' };
    }

    // Gate control is handled via Cloud Plus HTTP protocol
    const deviceId = gate.hardwareId.replace(/:/g, '');
    this.logger.log(
      `Gate control: ${dto.action} command for ${gate.name} (device: ${deviceId}) - via Cloud Plus HTTP`,
    );

    return { success: true, message: `${dto.action} command registered for ${gate.name}` };
  }
}
