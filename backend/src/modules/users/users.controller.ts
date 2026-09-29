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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  CreateUserDto,
  UpdateUserDto,
  UserResponseDto,
  UpdateProfileDto,
  UserQueryDto,
  UserTargetQueryDto,
  UserEmailLookupQueryDto,
  UserEmailLookupResponseDto,
} from './dto/user.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { ContextOptional } from '@common/decorators/context-optional.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User, UserRole } from '@database/entities/user.entity';
import { S3Service } from '../upload/s3.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly s3Service: S3Service,
  ) {}

  // ================== Profile Endpoints (self-service) ==================
  // Person-level, so @ContextOptional: they work before a building is chosen.
  // The profile also reports what the request acts as (role, building), taken
  // from the overlaid req.user, so it passes the whole principal.

  @Get('profile')
  @ContextOptional()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  getProfile(@CurrentUser() currentUser: User) {
    return this.usersService.getProfile(currentUser);
  }

  @Get('profile/qr')
  @ContextOptional()
  @ApiOperation({ summary: "Get the current user's personal access QR code" })
  @ApiResponse({ status: 200, description: 'QR code as a PNG data URL' })
  getProfileQrCode(@CurrentUser() currentUser: User) {
    return this.usersService.getProfileQrCode(currentUser.id);
  }

  @Patch('profile')
  @ContextOptional()
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  updateProfile(@CurrentUser() currentUser: User, @Body() updateProfileDto: UpdateProfileDto) {
    return this.usersService.updateProfile(currentUser, updateProfileDto);
  }

  @Post('profile/upload-image')
  @ContextOptional()
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 5 * 1024 * 1024 } })) // 5MB limit
  @ApiOperation({ summary: 'Upload profile image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Image uploaded successfully' })
  async uploadProfileImage(
    @CurrentUser() currentUser: User,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No image file provided');
    }

    // Validate file type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.',
      );
    }

    // Upload to S3
    const imageUrl = await this.s3Service.uploadProfileImage(file.buffer, file.originalname);

    // Update user profile with new image URL
    const user = await this.usersService.updateProfileImage(currentUser.id, imageUrl);

    return {
      message: 'Profile image uploaded successfully',
      profileImageUrl: user.profileImageUrl,
    };
  }

  // ================== Admin User Management ==================
  // Rows are memberships: `id` is the person, and PATCH / DELETE / GET :id act
  // on that person's row in the building the request acts in. A super admin
  // names the building with ?tenantId= when the person has several, or the
  // person themselves (the platform row) with ?scope=platform.

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created', type: UserResponseDto })
  create(@Body() createUserDto: CreateUserDto, @CurrentUser() currentUser: User) {
    return this.usersService.create(createUserDto, currentUser);
  }

  // Declared before GET :id, which would otherwise capture 'lookup'.
  @Get('lookup')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({
    summary: 'Before adding: does this email already belong to a person, and under which name',
  })
  @ApiResponse({ status: 200, type: UserEmailLookupResponseDto })
  lookupByEmail(@Query() query: UserEmailLookupQueryDto): Promise<UserEmailLookupResponseDto> {
    return this.usersService.lookupByEmail(query.email);
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: 'Get all users for current tenant' })
  @ApiResponse({ status: 200, description: 'List of users', type: [UserResponseDto] })
  findAll(@Query() query: UserQueryDto, @CurrentUser() currentUser: User) {
    return this.usersService.findAll(query, currentUser);
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: "Get a person's row in the building, with their assets there" })
  @ApiResponse({ status: 200, description: 'User details', type: UserResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UserTargetQueryDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.usersService.findOne(id, currentUser, {
      tenantId: query.tenantId,
      scope: query.scope,
    });
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({ summary: "Update a person's role, status or unit in the building" })
  @ApiResponse({ status: 200, description: 'User updated', type: UserResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Query() query: UserTargetQueryDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.usersService.update(id, updateUserDto, currentUser, {
      tenantId: query.tenantId,
      scope: query.scope,
    });
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUILDING_ADMIN)
  @ApiOperation({
    summary: 'Remove a person from the building (scope=platform: from the whole platform)',
  })
  @ApiResponse({ status: 204, description: 'User removed' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UserTargetQueryDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.usersService.remove(id, currentUser, {
      tenantId: query.tenantId,
      scope: query.scope,
    });
  }
}
