import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/** 作者署名 */
export const ATTRIBUTION_AUTHOR = 'Mitchell Chen (陳彥輔) aka 米球';
/** 版權宣告 */
export const ATTRIBUTION_COPYRIGHT = 'Copyright (c) 2026 Mitchell Chen. All rights reserved.';

/**
 * 把字串轉成 HTTP header value 放得下的形式。
 *
 * 為什麼需要這一步:Node 的 `setHeader()` 只接受 \t、\x20-\x7E、\x80-\xFF 的字元,
 * 傳入「陳彥輔」這種 U+0080 以上的字會直接丟 ERR_INVALID_CHAR,整個回應就爆了。
 * 而且 Node 是用 UTF-8 把 header 字串寫上線路的,所以也沒辦法靠 latin1 硬塞
 * (latin1 字元會被再 UTF-8 編一次,變成雙重編碼的亂碼)。
 *
 * 這裡採 RFC 2047 encoded-word:只把「連續的非 ASCII 片段」換成
 * `=?UTF-8?B?<base64>?=`,ASCII 部分原樣留著。這樣 `curl -I` 看到的是
 * `Mitchell Chen (=?UTF-8?B?6Zmz5b2l6LyU?=) aka =?UTF-8?B?57Gz55CD?=`,
 * 人還讀得出是誰,需要原文的工具也解得回來。
 * 純 ASCII 的字串(例如上面的版權宣告)則完全不動。
 */
export function toHeaderSafe(value: string): string {
  if (!/[^\x20-\x7E]/.test(value)) return value;

  return value.replace(/[^\x20-\x7E]+/g, (run) => {
    const b64 = Buffer.from(run, 'utf8').toString('base64');
    return `=?UTF-8?B?${b64}?=`;
  });
}

const AUTHOR_HEADER = toHeaderSafe(ATTRIBUTION_AUTHOR);
const COPYRIGHT_HEADER = toHeaderSafe(ATTRIBUTION_COPYRIGHT);

// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 在每個 API 回應掛上署名 / 版權標頭。
 *
 * 兩個實作細節,都是刻意的:
 * 1. 在 `next.handle()` 之前就把 header 設好,不放在 `tap()` 裡。
 *    因為像 `GET /api/admin/crm-checkin/photo/:photoId` 這種用 `@Res()` 自己
 *    `res.send()` 送二進位內容的端點,等 handler 跑完再設 header 會踩到
 *    ERR_HTTP_HEADERS_SENT。先設好也順便讓「handler 丟例外、由
 *    exception filter 回應」的情況一樣帶得到標頭。
 * 2. `headersSent` 先擋一次,純防呆:任何情況下都不該因為加署名而讓請求失敗。
 *
 * 已知範圍限制:guard 階段就被擋掉的請求(例如 throttler 回 429、JWT guard 回 401)
 * 不會經過 interceptor,那些回應不會有這兩個標頭。要 100% 覆蓋得改用 middleware,
 * 但那就不是「interceptor」了,這裡維持單一機制。
 */
@Injectable()
export class AttributionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const res = context.switchToHttp().getResponse<Response>();
      if (res && typeof res.setHeader === 'function' && !res.headersSent) {
        res.setHeader('X-Author', AUTHOR_HEADER);
        res.setHeader('X-Copyright', COPYRIGHT_HEADER);
      }
    }
    return next.handle();
  }
}
