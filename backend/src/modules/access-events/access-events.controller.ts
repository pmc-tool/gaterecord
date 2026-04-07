import { Controller, Get, Query, Res, UseGuards, ParseUUIDPipe, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { AccessEventsService } from './access-events.service';
import {
  AccessEventQueryDto,
  AccessEventResponseDto,
  AccessEventStatsDto,
} from './dto/access-event.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { RolesGuard } from '@common/guards/roles.guard';
import { User } from '@database/entities/user.entity';

@ApiTags('Access Events')
@ApiBearerAuth()
@Controller('events')
@UseGuards(RolesGuard)
export class AccessEventsController {
  constructor(private readonly accessEventsService: AccessEventsService) {}

  @Get()
  @ApiOperation({ summary: 'Get access events with filtering' })
  @ApiResponse({ status: 200, description: 'Paginated list of events' })
  findAll(@Query() query: AccessEventQueryDto, @CurrentUser() user: User) {
    return this.accessEventsService.findAll(query, user);
  }

  @Get('live')
  @ApiOperation({ summary: 'Get recent live events' })
  @ApiQuery({ name: 'gateId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Recent events', type: [AccessEventResponseDto] })
  getLiveEvents(
    @Query('gateId') gateId: string | undefined,
    @Query('limit') limit: number | undefined,
    @CurrentUser() user: User,
  ) {
    return this.accessEventsService.getLiveEvents(user, gateId, limit);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get event statistics' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiQuery({ name: 'gateId', required: false })
  @ApiResponse({ status: 200, description: 'Event statistics', type: AccessEventStatsDto })
  getStats(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('gateId') gateId: string | undefined,
    @CurrentUser() user: User,
  ) {
    return this.accessEventsService.getStats(new Date(startDate), new Date(endDate), user, gateId);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export events to CSV' })
  @ApiResponse({ status: 200, description: 'CSV file' })
  async exportToCsv(
    @Query() query: AccessEventQueryDto,
    @CurrentUser() user: User,
    @Res() res: Response,
  ) {
    const csv = await this.accessEventsService.exportToCsv(query, user);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=access-events-${new Date().toISOString().split('T')[0]}.csv`,
    );
    res.send(csv);
  }
}
