// ref:3687 mc/陳彥輔/米球®
/**
 * 登入 cookie 的單一定義,與「這次要不要續期」的判斷。
 *
 * 為什麼獨立成一支:cookie 的名字與屬性(httpOnly / secure / sameSite / maxAge / path)
 * 現在有三個寫入點 —— 登入、登出、滑動續期,加上 SSO 的三個交易 cookie。
 * **清除也算一個寫入點**:clearCookie 送的一樣是 Set-Cookie,屬性對不上就清不掉,
 * 所以這裡連 clearSessionCookieOptions / clearEntraTxCookieOptions 一起定義。屬性各寫一份的結果是續期時寫出一個
 * 屬性不同的 cookie,瀏覽器會把它當成另一個 cookie 存起來,症狀是
 * 「登入之後過一陣子突然被登出,而且清掉瀏覽器資料才會好」,從畫面上完全看不出原因。
 *
 * ★ 這套系統沒有更新權杖(refresh token),只有一個存取權杖加滑動續期。
 *   兩層權杖的價值在「存取權杖很短命、外洩的窗口很小」,但那要搭配一個能撤銷的
 *   更新權杖儲存區(伺服器端 session 表)才有意義。這裡沒有那張表,做兩層只會是
 *   一個名字比較好聽、實際上撤銷不了的第二把鑰匙。與其留一個文件上有、程式裡沒有的
 *   機制,不如把單一權杖的續期做對:業務在現場填一份表單、拍幾張照片、等地理編碼回來,
 *   十五分鐘的硬上限會讓他填到一半整頁被清掉。
 */
import type { CookieOptions } from 'express';
import { loadEnv, useSecureCookies, sessionCookieSameSite } from '../common/env';

/** 登入 cookie 的名字。前端不讀它(httpOnly),但 jwt.strategy 要從這裡取 token */
export const SESSION_COOKIE_NAME = 'mc_session';

/**
 * 把 JWT_ACCESS_TTL 字串(例 "8h" / "30m" / "1d")轉成毫秒,
 * 跟 jsonwebtoken 接受的格式對齊;格式不對時 fallback 到 8 小時
 * (與 JWT_ACCESS_TTL 的預設值一致 —— 兩個數字不一樣的話,
 * cookie 會比權杖先過期或後過期,症狀都是莫名其妙被登出)。
 */
export function parseTtlMs(ttl: string): number {
  const m = ttl.trim().match(/^(\d+)\s*(s|m|h|d)?$/i);
  if (!m || !m[1]) return 8 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 's').toLowerCase();
  const factor =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

/** cookie 的存活時間。與權杖效期同一個來源,不另外給一個數字 */
export function sessionCookieMaxAgeMs(): number {
  return parseTtlMs(loadEnv().JWT_ACCESS_TTL);
}

/**
 * 寫入登入 cookie 時的屬性。登入、續期共用這一份。
 */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: useSecureCookies(),
    // 跨網域部署要設成 none,否則登入 cookie 送不出去。見 common/env 的 COOKIE_SAMESITE
    sameSite: sessionCookieSameSite(),
    maxAge: sessionCookieMaxAgeMs(),
    path: '/',
  };
}

/**
 * 清除登入 cookie 時的屬性。
 *
 * ★ 這裡原本是 `res.clearCookie(SESSION_COOKIE_NAME, { path: '/' })` —— 少了
 *   `secure` 與 `sameSite`。這個檔頭花了整段在講「屬性各寫一份的結果是寫出一個
 *   瀏覽器當成另一個的 cookie」,而登出正是那個各寫一份的地方。
 *
 *   實際後果只在 `COOKIE_SAMESITE=none` 的跨網域部署上看得到,但很嚴重:
 *   clearCookie 送出的是一個 `Max-Age=0` 的 Set-Cookie,少了 `SameSite=None; Secure`
 *   的話,已經實施第三方 cookie 限制的瀏覽器會直接拒收這個回應的 cookie 指令。
 *   前端接著導到登入頁,畫面顯示「已登出」,但 cookie 還在;而這套系統沒有
 *   伺服器端 session 表,那份權杖在剩下的效期內完全有效。
 *   共用裝置上按登出不等於登出,而使用者沒有任何辦法察覺。
 *
 *   所以清除時沿用同一份屬性,只拿掉 maxAge(那一格由 clearCookie 自己覆寫成
 *   過期時間,留著會被 express 蓋掉,拿掉比較誠實)。
 */
export function clearSessionCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...rest } = sessionCookieOptions();
  return rest;
}

/**
 * Microsoft 登入流程用的三個短效交易 cookie(state / code_verifier / nonce)的路徑。
 * 寫入與清除共用,理由同上。
 */
export const ENTRA_TX_COOKIE_PATH = '/api/auth/entra';

/**
 * 交易 cookie 的屬性。
 *
 * sameSite 固定 `lax` 而不是跟著 COOKIE_SAMESITE 走:這三個 cookie 只需要在
 * 「Microsoft 導回本站」那一次頂層 GET 導航上被送出來,lax 剛好涵蓋這個情境,
 * 而且不必依賴第三方 cookie。這是刻意與登入 cookie 不同的一份設定,不是漏改。
 */
export function entraTxCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: useSecureCookies(),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000, // 授權流程 10 分鐘內要走完
    path: ENTRA_TX_COOKIE_PATH,
  };
}

/** 清除交易 cookie 時的屬性。與寫入同一份,少了它們一樣清不掉(理由見上面) */
export function clearEntraTxCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...rest } = entraTxCookieOptions();
  return rest;
}

/** 續期判斷只看得到權杖裡的這兩格時間(秒),其餘欄位原樣帶著重簽 */
export interface SessionTimestamps {
  /** 簽發時間(Unix 秒) */
  iat?: number;
  /** 到期時間(Unix 秒) */
  exp?: number;
}

/**
 * 這一次的請求要不要重新簽發權杖(滑動續期)。
 *
 * 規則:**效期過了一半才續**。
 *   每個請求都重簽的話,一個後台頁面開啟時會連打十幾支 API,等於十幾次
 *   argon2 之外的簽章與十幾個 Set-Cookie,而且每一個回應都在改瀏覽器的 cookie,
 *   併發回來的順序不保證,最後留下的可能是比較舊的那一個。
 *   過半才續,一段 8 小時的效期在連續使用下大約每 4 小時換一次。
 *
 * iat 或 exp 缺一不可判斷(理論上不會缺,但不能假設):讀不到就不續,
 * 使用者頂多在原本的效期到了之後重新登入,不會拿到一個效期算錯的權杖。
 */
export function shouldRenewSession(payload: SessionTimestamps, nowMs: number): boolean {
  const { iat, exp } = payload;
  if (typeof iat !== 'number' || typeof exp !== 'number') return false;
  if (exp <= iat) return false;
  const halfway = (iat + (exp - iat) / 2) * 1000;
  return nowMs >= halfway;
}
