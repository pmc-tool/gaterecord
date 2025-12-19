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
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, UserResponseDto } from './dto/user.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User, UserRole } from '@database/entities/user.entity';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created', type: UserResponseDto })
  create(@Body() createUserDto: CreateUserDto, @CurrentUser() currentUser: User) {
    return this.usersService.create(createUserDto, currentUser);
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Get all users for current tenant' })
  @ApiResponse({ status: 200, description: 'List of users', type: [UserResponseDto] })
  findAll(@CurrentUser() currentUser: User) {
    // Non-super-admins always get their own tenant's users
    return this.usersService.findAll(null, currentUser);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'User details', type: UserResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() currentUser: User) {
    return this.usersService.findOne(id, currentUser);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Update user' })
  @ApiResponse({ status: 200, description: 'User updated', type: UserResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.usersService.update(id, updateUserDto, currentUser);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Delete user' })
  @ApiResponse({ status: 204, description: 'User deleted' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() currentUser: User) {
    return this.usersService.remove(id, currentUser);
  }
}
