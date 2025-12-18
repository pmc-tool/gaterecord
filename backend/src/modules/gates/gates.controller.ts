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
}
