// 讀取後端 API 錯誤訊息的共用小工具(客戶卡、外勤打卡等頁面共用)。
// 規則:只有 4xx 且 body.message(字串,或字串陣列用半形逗號串起來)含中文時才回給使用者看;
// 5xx、body 解析不了、或框架預設的英文錯誤(像 Cannot GET /...)一律回 fallback,
// 避免把外部服務或框架的錯誤字串直接露給使用者。
//
// ── 401 是特例,而且以前是壞的 ────────────────────────────────────────
// 權杖過期時擋下請求的是 Passport,它回的是英文的 `Unauthorized`。上面那條「含中文才透出」
// 的規則會把它濾掉,於是每一頁都退成自己的 fallback:外勤打卡看到的是
// 「打卡失敗,請稍後再試」。那句話有兩個問題 —— 它沒說出真正的原因,而且它建議的動作
// (再試一次)永遠不會成功,使用者會在收訊不好的路邊一直按。
// 現在 401 一律講同一句「登入已過期,請重新登入」,並且把人送回登入頁,帶上 next
// 參數,登入完回到原來那一頁。
//
// ── 外勤頁面不自動導頁 ──────────────────────────────────────────────
// 打卡頁上可能已經有拍好的存證照片,那些照片只存在這個分頁的記憶體裡:直接導頁等於
// 把人剛剛在現場拍的東西丟掉,而且他人已經離開那個位置了。所以那幾頁傳
// { onUnauthorized: 'stay' },畫面留在原地、照片留著,訊息改成請他另開分頁登入,
// 回來再送一次。
//
// ── 但登入頁自己的 401 不是「過期」 ──────────────────────────────────
// 上面那條規則有一個反例:登入頁與改密碼頁。後端對「帳號或密碼錯誤」、
// 「帳號已暫時鎖定,請稍後再試」、「目前密碼錯誤」丟的都是 401,套上面那條規則的結果是
// 打錯密碼的人看到「登入已過期」;整頁重載把剛打的 Email 與錯誤訊息一起清掉,
// 看起來像按了登入什麼都沒發生;而且 next 每失敗一次往內巢一層。
// 連錯五次被鎖 30 分鐘的人更慘:唯一一句說得出原因的話被吃掉,他只看到頁面一直重整。
// 所以這兩頁傳 { onUnauthorized: 'credentials' },401 當成一般 4xx 處理,
// 後端的中文原樣透出,不導頁。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { safeNextPath } from './next-path';

/** 401 時給使用者看的唯一一句話。全站一致,不要各頁自己編 */
export const SESSION_EXPIRED_MESSAGE = '登入已過期,請重新登入';

/** 外勤頁面(留在原地)的版本:多說一句「東西還在」與該怎麼做 */
export const SESSION_EXPIRED_KEEP_MESSAGE =
  '登入已過期,請重新登入。這一頁的內容(包含已經拍好的照片)還留著,請另開分頁登入後回到這一頁再送出一次';

/**
 * 401 之後要怎麼處理:
 * - `redirect`(預設):導回登入頁,訊息固定是「登入已過期」。
 * - `stay`:留在原地(外勤頁面用,照片還在記憶體裡)。後端有講中文原因就照講,
 *   沒有就退到 SESSION_EXPIRED_KEEP_MESSAGE。
 * - `credentials`:這一頁的 401 本來就是「帳密不對」而不是「過期」(登入頁、改密碼頁)。
 *   後端的中文原樣透出,不導頁。但**後端說不出中文原因**時就不是帳密問題了:
 *   權杖過期時 Passport 回的是英文的 `Unauthorized`,那種情況退回 `redirect`
 *   的行為(登入頁自己有 isOnLoginPage() 守著,不會被導第二次)。
 */
export type UnauthorizedBehavior = 'redirect' | 'stay' | 'credentials';

/** 已經在導頁的路上就不要再導一次:一頁同時打好幾支 API 時每一支都會拿到 401 */
let redirecting = false;

/** 登入頁網址,帶上目前這一頁當 next(登入完回得來) */
export function loginHref(next?: string): string {
  const current =
    typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
  const target = safeNextPath(next ?? current);
  // 收不到合格的站內路徑就不帶 next。登入頁自己不能當 next(會一層層巢起來),
  // 外部網址更不能(那是通過驗證的開放重導,見 lib/next-path.ts)。
  //
  // 比對的是「路徑那一段」而不是整串:原本只擋 '/login' 與 '/login?' 開頭,
  // 於是 '/login#top' 被當成合法的 next —— 使用者登入成功之後會被送回登入頁一次,
  // 看起來像登入沒有生效。片段與 query 都要先切掉再比。
  if (!target || isLoginPath(target)) return '/login';
  return `/login?next=${encodeURIComponent(target)}`;
}

/** 這個站內路徑指的是不是登入頁本身(不管後面接 ?query 還是 #fragment) */
function isLoginPath(target: string): boolean {
  const path = target.split(/[?#]/, 1)[0];
  return path === '/login';
}

/**
 * 導回登入頁。用整頁導頁而不是 router.push:權杖已經失效,
 * 留在同一個 client 端 app 裡的其他狀態(快取到的清單、目前登入者)全部是舊的。
 */
export function redirectToLogin(): void {
  if (typeof window === 'undefined' || redirecting) return;
  // 已經在登入頁就不要再導一次。導了只會整頁重載,把使用者剛打的 Email 與畫面上的
  // 錯誤訊息一起清掉,而且 next 會一層一層往內巢(/login?next=/login?next=...)。
  if (isOnLoginPage()) return;
  redirecting = true;
  window.location.href = loginHref();
}

/** 目前這一頁是不是登入頁本身 */
export function isOnLoginPage(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname === '/login';
}

export interface ApiErrorOptions {
  /** 401 的處理方式。外勤頁面要保住已拍的照片,用 'stay' */
  onUnauthorized?: UnauthorizedBehavior;
}

export async function apiErrorMessage(
  res: Response,
  fallback: string,
  options?: ApiErrorOptions,
): Promise<string> {
  const behavior = res.status === 401 ? (options?.onUnauthorized ?? 'redirect') : 'redirect';

  // 導頁只在「這一頁不是登入頁」時發生。站在登入頁上再導一次的後果見 redirectToLogin()。
  if (res.status === 401 && behavior === 'redirect') {
    redirectToLogin();
    if (!isOnLoginPage()) return SESSION_EXPIRED_MESSAGE;
  }

  // 一般 4xx 規則:後端講得出中文原因就原樣透出。
  // 401 的 'stay' 與 'credentials' 都走這一條。「帳號已暫時鎖定」這種話被吃掉的話,
  // 使用者根本不知道自己被鎖了。
  if (res.status >= 400 && res.status < 500) {
    const text = await chineseMessage(res);
    if (text) return text;
  }

  // 後端沒給看得懂的原因時的退路
  if (res.status === 401 && behavior === 'stay') return SESSION_EXPIRED_KEEP_MESSAGE;
  // 'credentials' 到這裡等於「4xx 但後端說不出中文原因」。在這幾頁上那幾乎一定是
  // 權杖真的過期了:Passport 擋下來時回的是英文的 `Unauthorized`,chineseMessage()
  // 濾掉它之後就只剩呼叫端的 fallback。改密碼頁原本因此顯示「修改失敗」而且不導頁 ——
  // 使用者會一直重打正確的目前密碼,永遠得到同一句,也永遠不會成功。
  // 所以這種情況退回 redirect 的行為。登入頁本身有 isOnLoginPage() 守著,
  // 不會被導第二次,「帳號或密碼錯誤」那條路徑走的是上面那段中文原因,不受影響。
  if (res.status === 401 && behavior === 'credentials') {
    redirectToLogin();
    if (!isOnLoginPage()) return SESSION_EXPIRED_MESSAGE;
    return fallback;
  }
  if (res.status === 401 && behavior === 'redirect' && !isOnLoginPage()) {
    return SESSION_EXPIRED_MESSAGE;
  }
  return fallback;
}

/** 4xx body 裡「看得懂的中文原因」,沒有就回空字串 */
async function chineseMessage(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { message?: unknown } | null;
  const m = data?.message;
  const text =
    typeof m === 'string'
      ? m
      : Array.isArray(m)
        ? m.filter((x): x is string => typeof x === 'string').join(',')
        : '';
  if (text.trim() && /[一-鿿]/.test(text)) return text;
  return '';
}
