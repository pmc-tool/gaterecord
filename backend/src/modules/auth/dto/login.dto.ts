import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  IsOptional,
  IsObject,
  IsBoolean,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}

export class LoginResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty()
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    tenantId: string | null;
    tenant: {
      id: string;
      name: string;
      slug: string;
    } | null;
  };
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class SignupDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ example: 'admin@mybuilding.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ example: '+1234567890' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ example: 'Sunrise Apartments' })
  @IsString()
  @IsNotEmpty()
  buildingName: string;

  @ApiPropertyOptional({ example: '123 Main St, City, State 12345' })
  @IsString()
  @IsOptional()
  buildingAddress?: string;

  @ApiProperty({
    example: 'starter',
    description: 'Plan name: starter, professional, or enterprise',
  })
  @IsString()
  @IsNotEmpty()
  planName: string;

  @ApiPropertyOptional({
    example: 'monthly',
    description: 'Billing interval: monthly or yearly',
  })
  @IsString()
  @IsIn(['monthly', 'yearly'])
  @IsOptional()
  billingInterval?: 'monthly' | 'yearly';

  @ApiPropertyOptional({
    description: 'Whether this signup requires payment (for paid plans)',
  })
  @IsBoolean()
  @IsOptional()
  requiresPayment?: boolean;

  @ApiPropertyOptional({
    description: 'Start a free trial without payment (for plans with trial days)',
  })
  @IsBoolean()
  @IsOptional()
  startTrial?: boolean;

  @ApiPropertyOptional({ description: 'Dummy payment info for now' })
  @IsObject()
  @IsOptional()
  paymentInfo?: {
    cardLast4?: string;
    cardBrand?: string;
    cardholderName?: string;
  };
}
