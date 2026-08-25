import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from './admin.guard';
import { StatsService } from './stats.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  // No `@Positions()`: this is counting, and every admin who can open the
  // console can see what is waiting in it.
  @ApiOperation({
    summary: 'Dashboard figures',
    description:
      'Queue depth, decisions made, catalogue and account totals, and the five longest-waiting submissions. All current state — no time series.',
  })
  @Get()
  overview() {
    return this.stats.overview();
  }
}
