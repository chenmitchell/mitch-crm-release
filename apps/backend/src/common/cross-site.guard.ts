// ref:3687 mc/陳彥輔/米球®
/**
 * 跨站請求守衛(CSRF 的第一道,也是目前唯一一道)。
 *
 * ── 為什麼需要 ────────────────────────────────────────────────
 * 登入狀態存在 HttpOnly cookie 裡,而 cookie 是瀏覽器自動帶的:
 * 只要能讓已登入的人的瀏覽器發出一個請求,那個請求就是「他本人」發的。
 * `COOKIE_SAMESITE=lax`(出廠值)本身擋得住這件事,但 `.env.example` 教了
 * 前後端分屬兩個網域時要改成 `none` —— 改完之後 SameSite 這道就沒了,
 * 而整個 repo 沒有 CSRF token、沒有 double-submit cookie、也沒有自訂標頭要求。
 *
 * 剩下的屏障只有 Content-Type:`fetch` 送 `application/json` 會觸發預檢,
 * CORS 擋得掉。但**跨站的 HTML form POST 不會預檢**(它是 simple request),
 * 而 Nest 預設就掛著 urlencoded parser,所以表單送出來的欄位一樣解析得到。
 * 實際盤點過、body 可省又會改狀態的 POST 端點有這幾支:
 *   POST /api/auth/logout            把人登出
 *   POST /api/auth/me                重新簽一次權杖
 *   POST /api/users/:id/reset-password  重設別人的密碼
 *   POST /api/invites                產生一組邀請連結
 *   POST /api/admin/crm-map/geocode  觸發整批地理編碼(對外打第三方服務)
 *   POST /api/admin/entra/check      對外連一次 SSO 設定檢查
 * (PATCH 與 DELETE 不在名單上:HTML form 只送得出 GET 與 POST。)
 *
 * ── 這一支怎麼擋 ──────────────────────────────────────────────
 * 看 `Origin` 標頭,不是 `Referer`(Referer 會被 referrer policy 砍掉,
 * 而 Origin 在所有非 GET 的請求上一定會送,跨站 form POST 也會送)。
 *   1. GET / HEAD / OPTIONS 一律放行(這些不該改狀態;OPTIONS 是 CORS 預檢)
 *   2. 沒有 Origin → 放行。那是 curl、伺服器端呼叫、以及部分同源導覽,
 *      不是瀏覽器代替別人發的跨站請求。自架的人用腳本打 API 不該被這一支擋住
 *   3. 有 Origin,而且在 CORS_ORIGIN 允許清單裡 → 放行
 *   4. 其他一律 403
 *
 * 允許清單就是 CORS_ORIGIN,不另開一個環境變數:兩份清單遲早會不一致,
 * 而不一致的症狀是「有人偶爾被登出、log 上什麼都沒有」。
 *
 * 這不能取代真正的 CSRF token:同一個網域下的其他子路徑(例如同網域上另一個
 * 應用被入侵)送出的請求 Origin 是對的,這一支放行。要擋那種情境得做 token。
 * SECURITY.md 的「目前還沒有的防線」有寫。
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { loadEnv } from './env';

/** 這些方法不改狀態(OPTIONS 是 CORS 預檢,擋掉的話跨網域部署直接壞掉) */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CROSS_SITE_BLOCKED_MESSAGE = '請求來源不被允許';

/** 把 origin 正規化成可比對的形式(去尾斜線、轉小寫)。空字串代表沒有可比對的值 */
export function normalizeOrigin(v: string | undefined | null): string {
  return (v ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 純函式版本的判斷,方便單元測試不用組 ExecutionContext。
 * `origin` 傳 undefined 代表請求沒有帶 Origin 標頭。
 */
export function isCrossSiteBlocked(
  method: string,
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const o = normalizeOrigin(origin);
  if (!o) return false;
  return !allowed.map(normalizeOrigin).includes(o);
}

@Injectable()
export class CrossSiteGuard implements CanActivate {
  private readonly allowed: string[];

  constructor() {
    this.allowed = loadEnv()
      .CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;
    if (
      isCrossSiteBlocked(req.method, typeof origin === 'string' ? origin : undefined, this.allowed)
    ) {
      throw new ForbiddenException(CROSS_SITE_BLOCKED_MESSAGE);
    }
    return true;
  }
}
