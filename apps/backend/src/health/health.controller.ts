import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Healthz / Readyz — 反向代理、負載平衡器與容器平台的健康檢查會打。
 *
 * - /healthz:liveness,process 還活著就 200
 * - /readyz :readiness,DB 連得上回 200,連不上回 503
 *
 * 503 這件事是規格的一部分,不只是好看:orchestrator 的 readiness probe 只看狀態碼,
 * 不會去 parse body。原本 DB 掛掉照樣回 200(Nest 對回傳物件的預設狀態碼),
 * 於是 body 裡寫著 db:"down",而 Kubernetes / Compose 那側判定這台仍可服務,
 * 流量繼續進來。改狀態碼的話,body 仍然照舊回,想看細節的人 curl 得到。
 */
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('healthz')
  liveness(): { status: 'ok'; ts: string } {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Get('readyz')
  async readiness(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ok' | 'degraded'; db: 'up' | 'down'; ts: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      res.status(HttpStatus.OK);
      return { status: 'ok', db: 'up', ts: new Date().toISOString() };
    } catch {
      // 503 SERVICE_UNAVAILABLE:重試得起來的暫時性狀態,語意上正好是 readiness 要表達的
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', db: 'down', ts: new Date().toISOString() };
    }
  }
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
