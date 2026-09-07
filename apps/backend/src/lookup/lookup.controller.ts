// ref:3687 mc/陳彥輔/米球®
/**
 * 外部查詢帶入的端點。
 *
 *   GET /api/admin/lookup/business?q=<識別碼>
 *
 * 參數名刻意叫 q 而不是任何一種當地的號碼名稱:這支對「識別碼是什麼」完全無知,
 * 那件事由後台設定的 lookupLabel 決定,而且只影響畫面上的字。
 *
 * 權限只要登入:能開新增客戶頁的人就用得到,而回應內容本來就是公開登記資料。
 * 真正的守門在 service(沒啟用一律 404)與 rate limit。
 *
 * rate limit 收得比全域緊很多:這支會讓伺服器去打外部服務,
 * 不限流的話任何一個登入者都能拿它當轉發器連打上游,被封鎖的是我們的出口 IP。
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { LookupService } from './lookup.service';
import { LookupQueryDto } from './dto/lookup.dto';
import type { LookupResult } from './lookup-url';

/** 每分鐘 20 次。手動一筆一筆查遠遠用不到,自動化連打會撞到 */
export const LOOKUP_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@Controller('admin/lookup')
@UseGuards(AuthGuard('jwt'))
export class LookupController {
  constructor(private readonly svc: LookupService) {}

  @Throttle(LOOKUP_THROTTLE)
  @Get('business')
  async business(@Query() query: LookupQueryDto): Promise<LookupResult> {
    return this.svc.lookupBusiness(query.q);
  }
}
