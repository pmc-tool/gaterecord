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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, UserResponseDto, UpdateProfileDto, UserQueryDto } from './dto/user.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
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

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  getProfile(@CurrentUser() currentUser: User) {
    return this.usersService.getProfile(currentUser.id);
  }

  @Get('profile/qr')
  @ApiOperation({ summary: "Get the current user's personal access QR code" })
  @ApiResponse({ status: 200, description: 'QR code as a PNG data URL' })
  getProfileQrCode(@CurrentUser() currentUser: User) {
    return this.usersService.getProfileQrCode(currentUser.id);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  updateProfile(@CurrentUser() currentUser: User, @Body() updateProfileDto: UpdateProfileDto) {
    return this.usersService.updateProfile(currentUser.id, updateProfileDto);
  }

  @Post('profile/upload-image')
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
      throw new BadRequestException('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.');
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
  findAll(@Query() query: UserQueryDto, @CurrentUser() currentUser: User) {
    return this.usersService.findAll(query, currentUser);
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
