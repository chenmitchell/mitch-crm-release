import { Controller, Get, Query, Req, Res, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EntraService } from './entra.service';
import { EntraAuditService } from './entra-audit.service';
import type { EntraDenyReason } from './entra-domain';
import { getEnv } from '../common/env';
// cookie 的名字與屬性(含清除時的屬性)只有一份定義,見 session-cookie.ts
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  entraTxCookieOptions,
  clearEntraTxCookieOptions,
} from './session-cookie';

const env = getEnv();

/**
 * Microsoft Entra ID 登入的兩個端點
 *
 *   GET /api/auth/entra/start     → 302 導到 Microsoft
 *   GET /api/auth/entra/callback  → Microsoft 導回來,換 token、發 session cookie、再導回前端
 *
 * state / code_verifier / nonce 用三個短效 httpOnly cookie 帶著走,
 * 用完立刻清掉。不放 server 記憶體是因為後端可能有多個 instance,
 * 記憶體版會在「授權前後打到不同台」時隨機失敗 —— 那種 bug 很難查。
 *
 * 回呼會在「進到 EntraService 之前」就先失敗的幾種情況(使用者取消授權、
 * state 不符、cookie 過期),由這裡直接寫 audit_logs;進到 service 之後的
 * 失敗由 EntraService 記錄(那裡才拿得到 email 與 claims)。兩邊加起來
 * 才是完整的「這次登入到底卡在哪」。
 */
@Controller('auth/entra')
export class EntraController {
  private readonly logger = new Logger(EntraController.name);

  constructor(
    private readonly entra: EntraService,
    private readonly audit: EntraAuditService,
  ) {}

  /** 登入紀錄要記的來源資訊。req.ip 已由 main.ts 的 trust proxy 換算成真實客戶端 IP */
  private auditCtx(req: Request) {
    return {
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.get('user-agent') ?? null,
    };
  }

  /** 進到 EntraService 之前就失敗的情況,在這裡留一筆紀錄 */
  private async denyEarly(req: Request, reason: EntraDenyReason, detail?: Record<string, unknown>) {
    await this.audit.record({
      ...this.auditCtx(req),
      result: 'denied',
      reason,
      detail,
    });
  }

  /**
   * 交易 cookie 的屬性。定義在 session-cookie.ts,這裡不另抄一份 ——
   * 抄一份的下場就是這次審查抓到的那一條:清除時少了 secure 與 sameSite,
   * 在跨網域部署上清不掉,而畫面上完全看不出來。
   */
  private readonly txCookieOpts = entraTxCookieOptions();

  @Get('start')
  // 變成 async 是因為要向 Microsoft 要的 scope 取決於後台設定
  // (「同步主管」開了才要 User.Read.All),那要先讀一次資料庫
  async start(@Query('next') next: string | undefined, @Res() res: Response) {
    if (!this.entra.isEnabled()) {
      // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      return res.redirect(this.frontendUrl('/login?error=entra_disabled'));
    }
    const { authorizeUrl, state, codeVerifier, nonce } = await this.entra.buildAuthorizeUrl();
    res.cookie('mc_entra_state', state, this.txCookieOpts);
    res.cookie('mc_entra_verifier', codeVerifier, this.txCookieOpts);
    res.cookie('mc_entra_nonce', nonce, this.txCookieOpts);
    if (next && next.startsWith('/')) {
      res.cookie('mc_entra_next', next, this.txCookieOpts);
    }
    return res.redirect(authorizeUrl);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const next = cookies.mc_entra_next ?? '/admin';
    this.clearTxCookies(res);

    if (error) {
      this.logger.warn(
        `[entra] callback error=${error} desc=${(errorDescription ?? '').slice(0, 200)}`,
      );
      // Microsoft 端的錯誤碼(例 access_denied)照抄進紀錄,描述截短避免灌爆 JSONB
      await this.denyEarly(req, 'provider_error', {
        providerError: error.slice(0, 100),
        providerErrorDescription: (errorDescription ?? '').slice(0, 300),
      });
      return res.redirect(this.frontendUrl('/login?error=entra_denied'));
    }
    if (!code || !state) {
      await this.denyEarly(req, 'bad_request');
      return res.redirect(this.frontendUrl('/login?error=entra_bad_request'));
    }
    if (!cookies.mc_entra_state || cookies.mc_entra_state !== state) {
      // state 對不上 = CSRF 或使用者換了瀏覽器分頁,兩種都不該放行
      this.logger.warn('[entra] state 不符,拒絕');
      await this.denyEarly(req, 'state_mismatch', {
        hadStateCookie: Boolean(cookies.mc_entra_state),
      });
      return res.redirect(this.frontendUrl('/login?error=entra_state'));
    }
    if (!cookies.mc_entra_verifier || !cookies.mc_entra_nonce) {
      await this.denyEarly(req, 'tx_expired');
      return res.redirect(this.frontendUrl('/login?error=entra_expired'));
    }

    try {
      const result = await this.entra.completeLogin(
        code,
        cookies.mc_entra_verifier,
        cookies.mc_entra_nonce,
        this.auditCtx(req),
      );
      // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      res.cookie(SESSION_COOKIE_NAME, result.accessToken, sessionCookieOptions());
      return res.redirect(this.frontendUrl(next.startsWith('/') ? next : '/admin'));
    } catch (err) {
      // 原始訊息只進 logger,絕不進網址。
      //
      // 這裡原本把 `err.message` 用 encodeURIComponent 塞進 ?reason=,而前端的
      // 對照表沒有 entra_failed 這一項,`?? reason` 就把原文直接畫在登入頁上 ——
      // 一個**未登入**的人看得到的畫面。那個 message 是「任何例外」的訊息:
      // Prisma 連不上資料庫時的 P1001 帶著內部主機名與埠號,SSO 供應商的錯誤帶著
      // 租用戶識別。GlobalExceptionFilter 花了整段註解在防的就是這件事,
      // 而這條路徑自己 catch 掉,等於從旁邊繞過去。
      //
      // 所以網址上只放列舉碼(entra_failed),文案由前端決定。
      const message = (err as { message?: string }).message ?? 'Microsoft 登入失敗';
      this.logger.warn(`[entra] completeLogin 失敗:${message}`);
      return res.redirect(this.frontendUrl('/login?error=entra_failed'));
    }
  }

  private clearTxCookies(res: Response) {
    for (const name of ['mc_entra_state', 'mc_entra_verifier', 'mc_entra_nonce', 'mc_entra_next']) {
      res.clearCookie(name, clearEntraTxCookieOptions());
    }
  }

  /** 前端網址從 ENTRA_POST_LOGIN_URL 或 CORS_ORIGIN 的第一個 origin 推出來 */
  private frontendUrl(path: string): string {
    const base = env.ENTRA_POST_LOGIN_URL ?? env.CORS_ORIGIN.split(',')[0]?.trim() ?? '';
    return `${base.replace(/\/$/, '')}${path}`;
  }
}
