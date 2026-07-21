import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
  Get,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, LoginResponseDto, RefreshTokenDto, SignupDto } from './dto/login.dto';
import {
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  VerifyOtpDto,
  VerifyOtpResponseDto,
  ResetPasswordDto,
  ResetPasswordResponseDto,
} from './dto/password-reset.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Public } from '@common/decorators/public.decorator';
import { SubscriptionExempt } from '@common/decorators/subscription-exempt.decorator';
import { User } from '@database/entities/user.entity';
import { StripeService } from '../stripe/stripe.service';
import { SignupCheckoutDto } from '../stripe/dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly stripeService: StripeService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful', type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;
    return this.authService.login(loginDto, userAgent, ipAddress);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed', type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request): Promise<LoginResponseDto> {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;
    return this.authService.refreshTokens(dto.refreshToken, userAgent, ipAddress);
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout and invalidate refresh token' })
  @ApiResponse({ status: 204, description: 'Logout successful' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  // Session/security operation (not a business write): a suspended user must
  // still be able to sign out everywhere.
  @SubscriptionExempt()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiResponse({ status: 204, description: 'Logged out from all devices' })
  async logoutAll(@CurrentUser() user: User): Promise<void> {
    await this.authService.logoutAll(user.id);
  }

  @Post('me')
  @UseGuards(JwtAuthGuard)
  // Reads the caller's own profile — a read that happens to use POST. Read-only
  // grace is intended to keep "log in and read your data" working while
  // suspended, so this must not 402 on the HTTP method.
  @SubscriptionExempt()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current user info' })
  @ApiResponse({ status: 200, description: 'Current user info' })
  async me(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      tenantId: user.tenantId,
      profileImageUrl: user.profileImageUrl,
      qrCode: user.qrCode,
      unit: user.unit,
      tenant: user.tenant
        ? {
            id: user.tenant.id,
            name: user.tenant.name,
            slug: user.tenant.slug,
          }
        : null,
    };
  }

  @Post('signup')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register new building and admin account' })
  @ApiResponse({ status: 201, description: 'Signup successful', type: LoginResponseDto })
  @ApiResponse({ status: 409, description: 'Email or building name already exists' })
  async signup(@Body() signupDto: SignupDto, @Req() req: Request): Promise<LoginResponseDto> {
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;
    return this.authService.signup(signupDto, userAgent, ipAddress);
  }

  @Post('signup-checkout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create Stripe checkout session for paid signup (payment-first flow)' })
  @ApiResponse({ status: 200, description: 'Checkout session created' })
  @ApiResponse({ status: 409, description: 'Email or building name already exists' })
  @ApiResponse({ status: 400, description: 'Plan not found or not active' })
  async signupCheckout(@Body() dto: SignupCheckoutDto) {
    return this.stripeService.createSignupCheckoutSession(dto);
  }

  @Post('verify-payment')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify payment and activate account after Stripe Checkout' })
  @ApiResponse({ status: 200, description: 'Payment verified, account activated' })
  @ApiResponse({ status: 400, description: 'Payment verification failed' })
  async verifyPayment(
    @Body() body: { sessionId: string },
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    if (!body.sessionId) {
      throw new BadRequestException('Session ID is required');
    }

    const result = await this.stripeService.verifyCheckoutSession(body.sessionId);

    if (!result.success || !result.tenantId) {
      throw new BadRequestException(result.message || 'Payment verification failed');
    }

    // Generate tokens for the user associated with this tenant
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip;

    return this.authService.loginByTenantId(result.tenantId, userAgent, ipAddress);
  }

  @Get('plans')
  @Public()
  @ApiOperation({ summary: 'Get available subscription plans' })
  @ApiResponse({ status: 200, description: 'List of subscription plans' })
  async getPlans() {
    return this.authService.getSubscriptionPlans();
  }

  // Password Reset Endpoints

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset OTP' })
  @ApiResponse({ status: 200, description: 'OTP sent if email exists', type: ForgotPasswordResponseDto })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    return this.authService.forgotPassword(dto);
  }

  @Post('verify-otp')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP for password reset' })
  @ApiResponse({ status: 200, description: 'OTP verified', type: VerifyOtpResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  async verifyOtp(@Body() dto: VerifyOtpDto): Promise<VerifyOtpResponseDto> {
    return this.authService.verifyOtp(dto);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with verified token' })
  @ApiResponse({ status: 200, description: 'Password reset successful', type: ResetPasswordResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    return this.authService.resetPassword(dto);
  }
}
