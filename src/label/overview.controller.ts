import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { OverviewService } from './overview.service';

@ApiTags('label')
@ApiBearerAuth()
@Controller('label/overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @ApiOperation({
    summary: 'The label dashboard',
    description:
      'Pipeline counts across the whole roster, the roster itself, and the releases still waiting on someone. One request, and the counts are real totals rather than a page of them.',
  })
  @Get()
  forLabel(@CurrentUser('sub') userId: string) {
    return this.overview.forLabel(userId);
  }
}
