import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ResidentsService } from './residents.service';
import {
  CreateResidentDto,
  UpdateResidentDto,
  ResidentQueryDto,
  ResidentTargetQueryDto,
} from './dto/resident.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User, UserRole } from '@database/entities/user.entity';

/**
 * Residents of the building the request acts in (their RESIDENT memberships).
 * `:id` is the person; a super admin names the building with ?tenantId= when
 * the person is a resident of several. Which building a building admin acts
 * in is decided by the service (assertBuildingContext), not here.
 */
@ApiTags('Residents')
@ApiBearerAuth()
@Controller('residents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ResidentsController {
  constructor(private readonly residentsService: ResidentsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Get all residents with optional filtering and pagination' })
  async findAll(@CurrentUser() user: User, @Query() query: ResidentQueryDto) {
    return this.residentsService.findAll(user, query);
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Get resident by ID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ResidentTargetQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.residentsService.findOne(id, user, { tenantId: query.tenantId });
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create new resident' })
  async create(@Body() createDto: CreateResidentDto, @CurrentUser() user: User) {
    return this.residentsService.create(createDto, user);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update resident' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateResidentDto,
    @Query() query: ResidentTargetQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.residentsService.update(id, updateDto, user, { tenantId: query.tenantId });
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Remove the resident from the building' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ResidentTargetQueryDto,
    @CurrentUser() user: User,
  ) {
    return this.residentsService.remove(id, user, { tenantId: query.tenantId });
  }
}
