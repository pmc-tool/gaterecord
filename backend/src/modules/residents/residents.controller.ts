import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ResidentsService } from './residents.service';
import { CreateResidentDto, UpdateResidentDto } from './dto/resident.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User, UserRole } from '@database/entities/user.entity';

@ApiTags('Residents')
@ApiBearerAuth()
@Controller('residents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ResidentsController {
  constructor(private readonly residentsService: ResidentsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN, UserRole.SECURITY)
  @ApiOperation({ summary: 'Get all residents for current tenant' })
  async findAll(@CurrentUser() user: User, @Query('tenantId') tenantId?: string) {
    return this.residentsService.findAll(user, tenantId);
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Get resident by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.residentsService.findOne(id, user);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create new resident' })
  async create(@Body() createDto: CreateResidentDto, @CurrentUser() user: User) {
    // Building admin can only create residents for their own tenant
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.tenantId) {
        throw new ForbiddenException('User must belong to a tenant');
      }
      createDto.tenantId = user.tenantId;
    }
    return this.residentsService.create(createDto, user);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update resident' })
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateResidentDto,
    @CurrentUser() user: User,
  ) {
    return this.residentsService.update(id, updateDto, user);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Delete resident' })
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.residentsService.remove(id, user);
  }
}
