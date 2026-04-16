import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com', description: 'Email address to send OTP' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'user@example.com', description: 'Email address' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: '123456', description: '6-digit OTP code' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(6)
  @Matches(/^\d{6}$/, { message: 'OTP must be a 6-digit number' })
  otp: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'user@example.com', description: 'Email address' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Reset token received after OTP verification' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'NewPassword123!', description: 'New password (min 8 characters, with uppercase, lowercase, number, and special character)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
  @Matches(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain at least one number' })
  @Matches(/[@$!%*?&]/, { message: 'Password must contain at least one special character (@$!%*?&)' })
  newPassword: string;
}

export class ForgotPasswordResponseDto {
  @ApiProperty()
  message: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ description: 'OTP expiration time in seconds' })
  expiresIn: number;
}

export class VerifyOtpResponseDto {
  @ApiProperty()
  message: string;

  @ApiProperty()
  token: string;

  @ApiProperty()
  email: string;
}

export class ResetPasswordResponseDto {
  @ApiProperty()
  message: string;

  @ApiProperty()
  success: boolean;
}
