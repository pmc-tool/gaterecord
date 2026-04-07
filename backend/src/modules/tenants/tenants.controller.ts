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
import { TenantsService } from './tenants.service';
import {
  CreateTenantDto,
  UpdateTenantDto,
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
  TenantResponseDto,
} from './dto/tenant.dto';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { UserRole } from '@database/entities/user.entity';

@ApiTags('Super Admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  // Super Admin Dashboard
  @Get('dashboard')
  @ApiOperation({ summary: 'Get super admin dashboard with financial and platform metrics' })
  @ApiResponse({
    status: 200,
    description: 'Dashboard data including MRR, platform stats, and alerts',
  })
  getSuperAdminDashboard() {
    return this.tenantsService.getSuperAdminDashboard();
  }

  // Subscription Stats
  @Get('subscription-stats')
  @ApiOperation({ summary: 'Get subscription statistics and earnings' })
  @ApiResponse({ status: 200, description: 'Subscription stats including revenue' })
  getSubscriptionStats() {
    return this.tenantsService.getSubscriptionStats();
  }

  // Subscription Plans
  @Post('plans')
  @ApiOperation({ summary: 'Create subscription plan' })
  @ApiResponse({ status: 201, description: 'Plan created' })
  createPlan(@Body() dto: CreateSubscriptionPlanDto) {
    return this.tenantsService.createPlan(dto);
  }

  @Get('plans')
  @ApiOperation({ summary: 'Get all subscription plans (including inactive)' })
  @ApiResponse({ status: 200, description: 'List of plans' })
  findAllPlans() {
    return this.tenantsService.findAllPlans(true); // Include inactive for admin
  }

  @Get('plans/:id')
  @ApiOperation({ summary: 'Get subscription plan by ID' })
  @ApiResponse({ status: 200, description: 'Plan details' })
  findOnePlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.findOnePlan(id);
  }

  @Patch('plans/:id')
  @ApiOperation({ summary: 'Update subscription plan' })
  @ApiResponse({ status: 200, description: 'Plan updated' })
  updatePlan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSubscriptionPlanDto) {
    return this.tenantsService.updatePlan(id, dto);
  }

  @Delete('plans/:id')
  @ApiOperation({ summary: 'Delete subscription plan' })
  @ApiResponse({ status: 204, description: 'Plan deleted' })
  removePlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.removePlan(id);
  }

  // Tenants
  @Post('tenants')
  @ApiOperation({ summary: 'Create new tenant (building)' })
  @ApiResponse({ status: 201, description: 'Tenant created with admin credentials' })
  async createTenant(@Body() dto: CreateTenantDto) {
    const result = await this.tenantsService.createTenant(dto);
    return {
      tenant: result.tenant,
      adminCredentials: {
        email: dto.adminEmail,
        temporaryPassword: result.adminPassword,
        message: 'Admin must change password on first login',
      },
    };
  }

  @Get('tenants')
  @ApiOperation({ summary: 'Get all tenants' })
  @ApiResponse({ status: 200, description: 'List of tenants', type: [TenantResponseDto] })
  findAll() {
    return this.tenantsService.findAll();
  }

  @Get('tenants/:id')
  @ApiOperation({ summary: 'Get tenant by ID' })
  @ApiResponse({ status: 200, description: 'Tenant details', type: TenantResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.findOne(id);
  }

  @Get('tenants/:id/stats')
  @ApiOperation({ summary: 'Get tenant statistics' })
  @ApiResponse({ status: 200, description: 'Tenant stats' })
  getTenantStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.getTenantStats(id);
  }

  @Patch('tenants/:id')
  @ApiOperation({ summary: 'Update tenant' })
  @ApiResponse({ status: 200, description: 'Tenant updated', type: TenantResponseDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.update(id, dto);
  }

  @Delete('tenants/:id')
  @ApiOperation({ summary: 'Delete tenant' })
  @ApiResponse({ status: 204, description: 'Tenant deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantsService.remove(id);
  }
}
