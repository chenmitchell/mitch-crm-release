// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 首次啟動精靈的端點。
 *
 * 這兩支刻意沒有登入守衛 —— 它們存在的前提就是「還沒有任何帳號可以登入」。
 * 已初始化之後 SetupService 一律拒絕,所以開著不會變成後門;
 * 但仍套上憑證類端點那組嚴格 rate limit,免得有人拿它當探測用的敲門磚。
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SetupService } from './setup.service';
import { SetupDto } from './dto/setup.dto';
import { loadEnv } from '../common/env';

const env = loadEnv();

const STRICT = {
  default: { limit: env.THROTTLE_LIMIT_STRICT, ttl: env.THROTTLE_TTL_SECONDS * 1000 },
};

@Controller('setup')
export class SetupController {
  constructor(private readonly svc: SetupService) {}

  @Throttle(STRICT)
  @Get('status')
  async status() {
    return this.svc.status();
  }

  @Throttle(STRICT)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async run(@Body() dto: SetupDto) {
    return this.svc.run(dto);
  }
}
