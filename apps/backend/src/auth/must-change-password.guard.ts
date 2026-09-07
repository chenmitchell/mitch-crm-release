// ref:3687 mc/陳彥輔/米球®
/**
 * 「首次登入必須改密碼」的後端把關。
 *
 * ── 原本只有前端在擋 ──────────────────────────────────────────────
 * 唯一的把關點是登入頁那三行:登入成功後看 `data.user.mustChangePassword`,
 * 為真就 router.push 到改密碼頁。後端完全沒有任何一道守衛讀這一格 ——
 * jwt.strategy 只是把它從資料庫撈出來掛在 req.user 上,沒有人看它;
 * admin/layout.tsx 也只檢查 401。
 *
 * 兩種繞法都不需要任何技巧:
 *   1. 被推到改密碼頁之後,把網址列改成 /admin/crm,就進去了。
 *   2. 根本不開瀏覽器:`curl -X POST /api/auth/login` 拿到 cookie,
 *      直接打任何一支 API,每一支都會正常回應。
 *
 * 後果是臨時密碼實際上永久有效。而臨時密碼是這套系統裡最容易外洩的一組憑證 ——
 * 它由管理員用聊天軟體或口頭轉交,而且後台畫面與 API 回應都對管理員宣稱
 * 「對方第一次登入會被強制改密碼」。宣稱與事實不符,比沒有這個功能更糟。
 *
 * ── 這道守衛怎麼運作 ──────────────────────────────────────────────
 * 掛成全域守衛(APP_GUARD)。全域守衛跑在路由層的 AuthGuard('jwt') **之前**,
 * 所以這裡讀不到 req.user,必須自己驗一次 cookie 裡的權杖。
 * 那不是浪費:驗簽是純 CPU 的幾十微秒,回查帳號狀態走的是 SessionUserService
 * 同一份 10 秒快取(等一下 JwtStrategy 要查的就是這一份),等於沒有多一次查詢。
 * 換來的是「所有端點預設關上」——日後新增的模組不必記得掛什麼,自動被涵蓋。
 *
 * 放行的只有五類:
 *   1. 逃生路徑(見 ESCAPE_PATHS):自己是誰、登出、改密碼、登入方式查詢。
 *      少了它們,被擋住的人連改密碼都做不到,那是一個進不去也出不來的狀態。
 *   2. 公開端點(見 PUBLIC_PATHS / PUBLIC_PREFIXES):健康檢查、安裝精靈、
 *      公開設定、邀請連結、登入本身、SSO 流程。這些端點根本不需要登入,
 *      「這個人要改密碼」對它們沒有意義。
 *   3. 沒有 cookie 的請求:那是未登入,交給各端點自己的 AuthGuard 回 401。
 *   4. 權杖驗不過(過期、簽章不符、格式錯):同樣交給 AuthGuard 回 401。
 *      在這裡回 403 只會讓「權杖過期」看起來像「你要改密碼」。
 *   5. 查得到人而且 mustChangePassword 是 false 的正常使用者。
 *
 * ── 為什麼分岔是「這支端點要不要登入」而不是「有沒有帶 cookie」 ───────────
 * 第一版只有第 3 類,靠「沒帶 cookie」來保護公開端點。那個條件在瀏覽器裡不成立:
 * 前後端同源部署時(compose 的預設,Caddy 依路徑分流)fetch 的預設
 * credentials: 'same-origin' 就會把 session cookie 一起送出去,登入頁更是明寫
 * credentials: 'include'。於是一個「臨時密碼還沒換」的人:
 *   - 開首頁 → app-settings 的 /api/public/settings 403 → 重試兩次 → 紅字
 *     「設定讀取失敗,目前顯示預設值」,而系統其實好好的;
 *   - 隔天回來打帳號密碼 → POST /api/auth/login 403「請先變更密碼」,
 *     而登入頁沒有任何通往改密碼頁的入口,他再怎麼打都是同一句。
 * 公開端點是不是公開,是端點自己的性質,與請求有沒有夾帶 cookie 無關。
 *
 * 判斷用的是**資料庫**現在的值,不是權杖裡的快照:改完密碼之後那一格立刻是 false,
 * 而使用者手上那份權杖的 payload 還寫著 true。看權杖的話,人會在改完密碼之後
 * 繼續被擋住,直到重新登入。
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from './session-cookie';
import { SessionUserService } from './session-user.service';
import type { JwtPayload } from './auth.service';

/**
 * 即使 mustChangePassword 為真也放行的「逃生路徑」(含全域前綴 /api)。
 *
 * 只放「改密碼這件事本身需要用到的」。/auth/me 要放:前端的 MeProvider
 * 掛在 root layout,改密碼頁也在它底下,拿不到「你是誰」整頁會停在載入中。
 * 這份清單只比對路徑不比對動詞,所以 /api/auth/me 現在只剩 POST 一支也不必改。
 */
export const ESCAPE_PATHS: readonly string[] = [
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
  '/api/auth/providers',
];

/**
 * 不需要登入就能打的端點(完全比對)。
 *
 * /healthz 與 /readyz 沒有 /api 前綴 —— main.ts 的 setGlobalPrefix 把這兩支
 * exclude 掉了,探針打的就是根路徑。
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/healthz',
  '/readyz',
  '/api/auth/login',
  '/api/auth/providers',
];

/**
 * 不需要登入的整棵子樹(比對自己與 `<prefix>/...`)。
 *
 *   /api/public    公開設定(未登入的首頁就要讀,見 public-settings.controller.ts)
 *   /api/setup     安裝精靈:GET /api/setup/status 與 POST /api/setup 本身
 *   /api/invites   邀請連結的查驗與接受(後台管理那一支是 /api/admin/crm-invites,
 *                  不在這棵子樹裡,不會被順便放行)
 *   /api/auth/entra SSO 登入流程,本來就不該被「你要改密碼」擋住
 */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/api/public',
  '/api/setup',
  '/api/invites',
  '/api/auth/entra',
];

/** 去掉尾斜線:/api/auth/me/ 與 /api/auth/me 是同一支 */
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * 這支端點需不需要登入。
 * 子樹比對一律加 `/` 界線:`/api/setup` 與 `/api/setup/status` 算,
 * `/api/setupx` 不算 —— 否則等於開了一個誰都想得到的繞法。
 */
export function isPublicPath(path: string): boolean {
  const p = normalizePath(path);
  if (PUBLIC_PATHS.includes(p)) return true;
  return PUBLIC_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** 這個路徑是不是「不管 mustChangePassword 都放行」:逃生路徑或公開端點 */
export function isPathAllowed(path: string): boolean {
  const p = normalizePath(path);
  if (ESCAPE_PATHS.includes(p)) return true;
  return isPublicPath(p);
}

@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessionUsers: SessionUserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (isPathAllowed(req.path)) return true;

    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const token = cookies[SESSION_COOKIE_NAME];
    // 沒帶 cookie = 未登入。公開端點要放行,需要登入的端點由它自己的守衛回 401
    if (!token) return true;

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      // 驗不過的權杖不是這道守衛的事,交給 AuthGuard 回 401
      return true;
    }
    if (!payload?.sub) return true;

    const user = await this.sessionUsers.find(payload.sub);
    // 查不到人(帳號被刪)同樣交給 AuthGuard 處理,不在這裡改變錯誤的性質
    if (!user) return true;
    if (!user.mustChangePassword) return true;

    throw new ForbiddenException('請先變更密碼,才能使用系統其他功能');
  }
}
// ref:3687 mc/陳彥輔/米球®
