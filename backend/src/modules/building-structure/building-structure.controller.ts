import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BuildingStructureService } from './building-structure.service';
import {
  AddFlatsDto,
  CreateFloorDto,
  CreateFloorRangeDto,
  UpdateFlatDto,
  UpdateFloorDto,
} from './dto/building-structure.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User, UserRole } from '@database/entities/user.entity';

/**
 * Floors and flats of the building the request acts in (Building Settings).
 *
 * Authenticated by the global JwtAuthGuard. NOT @SubscriptionExempt: this is
 * ordinary tenant business data, so a suspended building keeps read access and
 * has writes refused with 402, like residents or gates.
 *
 * RolesGuard admits building admins and super admins; the service then pins
 * the building: the acting building_admin membership for every write, and a
 * Platform-context super admin only for reads with ?tenantId=.
 */
@ApiTags('Building Structure')
@ApiBearerAuth()
@Controller('building')
@UseGuards(RolesGuard)
@Roles(UserRole.BUILDING_ADMIN, UserRole.SUPER_ADMIN)
export class BuildingStructureController {
  constructor(private readonly buildingStructureService: BuildingStructureService) {}

  @Get('structure')
  @ApiOperation({ summary: 'List floors and flats of your building, with resident occupancy' })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    description: 'Super admin in the Platform context only: read that building. Ignored otherwise.',
  })
  @ApiResponse({ status: 409, description: 'No building chosen (MEMBERSHIP_REQUIRED)' })
  @ApiResponse({ status: 403, description: 'Not a building admin of the building acted in' })
  async getStructure(
    @CurrentUser() user: User,
    @Query('tenantId', new ParseUUIDPipe({ optional: true })) tenantId?: string,
  ) {
    return this.buildingStructureService.getStructure(user, tenantId);
  }

  @Post('floors')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a floor' })
  @ApiResponse({ status: 409, description: 'Floor number already exists' })
  async createFloor(@CurrentUser() user: User, @Body() dto: CreateFloorDto) {
    return this.buildingStructureService.createFloor(user, dto);
  }

  // Declared before the ':id' routes so 'range' is never read as an id.
  @Post('floors/range')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add every floor in a range, skipping ones that already exist' })
  async createFloorRange(@CurrentUser() user: User, @Body() dto: CreateFloorRangeDto) {
    return this.buildingStructureService.createFloorRange(user, dto);
  }

  @Patch('floors/:id')
  @ApiOperation({ summary: 'Change a floor number or name' })
  async updateFloor(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFloorDto,
  ) {
    return this.buildingStructureService.updateFloor(user, id, dto);
  }

  @Delete('floors/:id')
  @ApiOperation({ summary: 'Delete a floor and all of its flats' })
  async deleteFloor(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.buildingStructureService.deleteFloor(user, id);
  }

  @Post('floors/:id/flats')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add one or more flats to a floor' })
  @ApiResponse({ status: 409, description: 'A flat number already exists in this building' })
  async addFlats(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddFlatsDto,
  ) {
    return this.buildingStructureService.addFlats(user, id, dto);
  }

  @Patch('flats/:id')
  @ApiOperation({ summary: 'Rename a flat or move it to another floor' })
  async updateFlat(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFlatDto,
  ) {
    return this.buildingStructureService.updateFlat(user, id, dto);
  }

  @Delete('flats/:id')
  @ApiOperation({ summary: 'Delete a flat' })
  async deleteFlat(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.buildingStructureService.deleteFlat(user, id);
  }
}
