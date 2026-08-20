import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './decorators/public.decorator';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Render pings this to decide whether the service is up, so it must not
  // require a token.
  @Public()
  @ApiOperation({ summary: 'Health check' })
  @Get('health')
  health() {
    return this.appService.health();
  }
}
