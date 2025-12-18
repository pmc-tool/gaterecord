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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { VisitorPassService } from './visitor-pass.service';
import { CreateVisitorPassDto, UpdateVisitorPassDto, VisitorPassQueryDto } from './dto/visitor-pass.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { Public } from '@common/decorators/public.decorator';
import { User } from '@database/entities/user.entity';

interface RequestWithUser extends Request {
  user: User;
}

@ApiTags('Visitor Passes')
@Controller('visitor-passes')
export class VisitorPassController {
  constructor(
    private readonly visitorPassService: VisitorPassService,
  ) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a new visitor pass' })
  async create(@Body() createDto: CreateVisitorPassDto, @Req() req: RequestWithUser) {
    const pass = await this.visitorPassService.create(createDto, req.user);

    // TODO: Send notifications via notification service
    // if (createDto.sendEmail && createDto.visitorEmail) {
    //   await this.notificationService.sendVisitorPassEmail(pass, req.user);
    // }
    // if (createDto.sendWhatsApp && createDto.visitorPhone) {
    //   await this.notificationService.sendVisitorPassWhatsApp(pass, req.user);
    // }

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

    // Return limited info for public view
    return {
      visitorName: pass.visitorName,
      hostName: pass.createdBy ? `${pass.createdBy.firstName} ${pass.createdBy.lastName}` : 'Unknown',
      hostUnit: pass.hostUnit,
      buildingName: pass.tenant?.name || 'Unknown Building',
      buildingAddress: pass.tenant?.address || '',
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      status: pass.status,
      qrToken: pass.qrToken,
      purpose: pass.purpose,
      usesRemaining: Math.max(0, pass.maxUses - pass.useCount),
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

    // TODO: Implement notification resending
    // if (pass.visitorEmail) {
    //   await this.notificationService.sendVisitorPassEmail(pass, req.user);
    // }
    // if (pass.visitorPhone) {
    //   await this.notificationService.sendVisitorPassWhatsApp(pass, req.user);
    // }

    return { message: 'Notification resent successfully', pass };
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
