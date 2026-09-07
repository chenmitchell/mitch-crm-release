// ref:3687 mc/陳彥輔/米球®
/**
 * 滑動續期(sliding session)。
 *
 * 為什麼要有這一支:登入權杖是一次簽死的,效期一到就是硬登出。對一套業務在現場
 * 填表、拍照、等地理編碼回來的產品,硬登出的症狀是「填到一半整頁被清掉」——
 * 前端收到 401 就 window.location 整頁導去登入頁,表單裡的東西全部沒了。
 * 「還在用就不要把人踢出去」這件事,要嘛靠更新權杖,要嘛靠續期。這套系統沒有
 * 可撤銷的伺服器端 session 表,兩層權杖只會是一把撤銷不了的第二把鑰匙,
 * 所以選續期(理由詳見 session-cookie.ts 檔頭)。
 *
 * 做法:已經通過 JWT 守衛的請求,如果權杖的效期已經過了一半,就用同樣的內容
 * 重簽一份、重設 cookie。過半才續,不是每個請求都續(理由見 shouldRenewSession)。
 *
 * ★ 兩件不可以做的事,這裡都擋掉了
 *   1. 登出之後又把人續回來。logout 清掉 cookie,如果這支接著寫一個新的 cookie,
 *      使用者按了登出但實際上還登著,而且畫面上看不出來。
 *   2. 登入回應被覆蓋成一個屬性不同的 cookie。
 *   兩者用同一個判斷解決:這次的回應**已經自己動過** mc_session 的話就完全不碰。
 *   路徑比對(/auth/logout)不夠可靠 —— 全域前綴、版本前綴改了就會漏掉,
 *   而漏掉的症狀是登出失效,那是安全問題。看 Set-Cookie 標頭則是看實際發生的事。
 *
 * 續期失敗不影響這次的回應:使用者頂多在原本的效期到了之後重新登入。
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { JwtPayload } from './auth.service';
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  shouldRenewSession,
  type SessionTimestamps,
} from './session-cookie';

type AuthedRequest = Request & { user?: (JwtPayload & SessionTimestamps) | undefined };

/** 這次的回應有沒有已經自己動過登入 cookie(登入寫、登出清) */
export function touchesSessionCookie(header: number | string | string[] | undefined): boolean {
  if (header === undefined) return false;
  const values = Array.isArray(header) ? header : [String(header)];
  return values.some((v) => v.startsWith(`${SESSION_COOKIE_NAME}=`));
}

@Injectable()
export class SessionRefreshInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SessionRefreshInterceptor.name);

  constructor(private readonly jwt: JwtService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // 只有成功的回應才續期:丟例外的那條路徑不重簽,401 之後不會莫名其妙拿到新 cookie
    return next.handle().pipe(tap(() => void this.renew(context)));
  }

  private async renew(context: ExecutionContext): Promise<void> {
    if (context.getType() !== 'http') return;
    try {
      const req = context.switchToHttp().getRequest<AuthedRequest>();
      const user = req.user;
      // 沒過守衛的請求沒有 user(公開端點、登入本身),不續
      if (!user?.sub) return;
      if (!shouldRenewSession(user, Date.now())) return;

      const res = context.switchToHttp().getResponse<Response>();
      if (res.headersSent) return;
      // 登入 / 登出已經自己決定了這個 cookie 的去留,不要蓋回去
      if (touchesSessionCookie(res.getHeader('Set-Cookie'))) return;

      // 重簽的內容取自 req.user,而 req.user 是 JwtStrategy 剛剛用**資料庫現在的值**
      // 組出來的(role、mustChangePassword 都已覆蓋成 DB 的值,停用 / 刪帳號 /
      // 密碼變更根本走不到這裡)。所以這一份新權杖帶的是新角色,不是登入當下那一個。
      //
      // 這一點以前不成立:當時 validate 只是 return payload,續期等於拿舊角色
      // 每四小時自動換一份新的八小時權杖,被降級的人權限永遠不會結束。
      // 改動 jwt.strategy.ts 的 validate 時要一起想到這裡。
      const payload: JwtPayload = {
        sub: user.sub,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      };
      const token = await this.jwt.signAsync(payload);
      res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    } catch (e) {
      // 續期失敗只是「這次沒續到」,不能反過來把已經成功的回應弄掛
      this.logger.warn(`[session] 續期失敗,這次沿用原本的權杖:${(e as Error).message}`);
    }
  }
}
