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
  Req,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { VisitorPassService } from './visitor-pass.service';
import { CreateVisitorPassDto, UpdateVisitorPassDto, VisitorPassQueryDto } from './dto/visitor-pass.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { Public } from '@common/decorators/public.decorator';
import { User } from '@database/entities/user.entity';
import { EmailService } from '../notification/email.service';
import { VisitorPass } from '@database/entities/visitor-pass.entity';

interface RequestWithUser extends Request {
  user: User;
}

@ApiTags('Visitor Passes')
@Controller('visitor-passes')
export class VisitorPassController {
  private readonly logger = new Logger(VisitorPassController.name);

  constructor(
    private readonly visitorPassService: VisitorPassService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  private async sendPassNotification(pass: VisitorPass, currentUser: User, sendEmail: boolean): Promise<void> {
    if (!sendEmail || !pass.visitorEmail) return;

    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    const passUrl = `${frontendUrl}/visitor-pass/${pass.qrToken}`;

    // Determine host name
    let hostName = 'Staff';
    if (pass.resident) {
      hostName = `${pass.resident.firstName} ${pass.resident.lastName}`;
    } else if (currentUser) {
      hostName = `${currentUser.firstName} ${currentUser.lastName}`;
    }

    // Get building name
    const buildingName = pass.tenant?.name || 'the building';

    try {
      await this.emailService.sendVisitorPassEmail(
        pass.visitorEmail,
        pass.visitorName,
        hostName,
        buildingName,
        passUrl,
        pass.validFrom,
        pass.validUntil,
      );
      this.logger.log(`Email sent to ${pass.visitorEmail} for pass ${pass.id}`);
    } catch (error) {
      this.logger.error(`Failed to send email for pass ${pass.id}:`, error);
    }
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a new visitor pass' })
  async create(@Body() createDto: CreateVisitorPassDto, @Req() req: RequestWithUser) {
    const pass = await this.visitorPassService.create(createDto, req.user);

    // Fetch full pass with relations for email
    const fullPass = await this.visitorPassService.findOne(pass.id, req.user);

    // Send email notification if requested
    if (createDto.sendEmail && createDto.visitorEmail) {
      await this.sendPassNotification(fullPass, req.user, true);
    }

    // TODO: WhatsApp integration via Twilio
    if (createDto.sendWhatsApp && createDto.visitorPhone) {
      this.logger.log(`WhatsApp notification requested for ${createDto.visitorPhone} - not yet implemented`);
    }

    return pass;
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get all visitor passes for current user' })
  async findAll(@Query() query: VisitorPassQueryDto, @Req() req: RequestWithUser) {
    return this.visitorPassService.findAll(req.user, query);
  }

  @Get('stats')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get visitor pass statistics' })
  async getStats(@Req() req: RequestWithUser) {
    return this.visitorPassService.getStats(req.user);
  }

  @Get('public/:qrToken')
  @Public()
  @ApiOperation({ summary: 'Get visitor pass by QR token (public - no auth required)' })
  @ApiResponse({ status: 200, description: 'Visitor pass details for public display' })
  async findByToken(@Param('qrToken') qrToken: string) {
    const pass = await this.visitorPassService.findByToken(qrToken);

    // Determine host name based on registration type
    let hostName = 'Unknown';
    if (pass.registrationType === 'on_premise' && pass.resident) {
      hostName = `${pass.resident.firstName} ${pass.resident.lastName}`;
    } else if (pass.createdBy) {
      hostName = `${pass.createdBy.firstName} ${pass.createdBy.lastName}`;
    }

    // Return limited info for public view
    return {
      visitorName: pass.visitorName,
      hostName,
      hostUnit: pass.hostUnit,
      buildingName: pass.tenant?.name || 'Unknown Building',
      buildingAddress: pass.tenant?.address || '',
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      status: pass.status,
      qrToken: pass.qrToken,
      purpose: pass.purpose,
      usesRemaining: Math.max(0, pass.maxUses - pass.useCount),
      registrationType: pass.registrationType,
      residentConfirmed: pass.residentConfirmed,
    };
  }

  @Get('public/:qrToken/qr')
  @Public()
  @ApiOperation({ summary: 'Get QR code image by token (public)' })
  async getPublicQrCode(@Param('qrToken') qrToken: string) {
    const qrCodeDataUrl = await this.visitorPassService.getQrCodeByToken(qrToken);
    return { qrCode: qrCodeDataUrl };
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get visitor pass by ID' })
  async findOne(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.visitorPassService.findOne(id, req.user);
  }

  @Get(':id/qr')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get QR code for visitor pass' })
  async getQrCode(@Param('id') id: string, @Req() req: RequestWithUser) {
    const qrCodeDataUrl = await this.visitorPassService.getQrCode(id, req.user);
    return { qrCode: qrCodeDataUrl };
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update visitor pass' })
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateVisitorPassDto,
    @Req() req: RequestWithUser,
  ) {
    return this.visitorPassService.update(id, updateDto, req.user);
  }

  @Post(':id/cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Cancel visitor pass' })
  async cancel(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.visitorPassService.cancel(id, req.user);
  }

  @Post(':id/resend')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Resend notification for visitor pass' })
  async resend(@Param('id') id: string, @Req() req: RequestWithUser) {
    const pass = await this.visitorPassService.findOne(id, req.user);

    let emailSent = false;

    if (pass.visitorEmail) {
      await this.sendPassNotification(pass, req.user, true);
      emailSent = true;
    }

    // TODO: WhatsApp resend
    if (pass.visitorPhone) {
      this.logger.log(`WhatsApp resend requested for ${pass.visitorPhone} - not yet implemented`);
    }

    return {
      message: emailSent ? 'Notification resent successfully' : 'No email address available',
      emailSent,
      pass,
    };
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Delete visitor pass' })
  async remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    await this.visitorPassService.remove(id, req.user);
    return { message: 'Visitor pass deleted successfully' };
  }
}
