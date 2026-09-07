/**
 * URL 遮蔽工具
 *
 * 為什麼要這支:一次性連結的 token 本身就是「認證憑證」,
 * 拿到它等於拿到那條連結的權限。原本 global exception filter 直接把 `req.url` 整條
 * 寫進 `error_logs.path`,後台 /admin/errors 又會把它顯示出來,等於前台一出錯,
 * 一組還有效的存取憑證就落進 DB、落進後台畫面,也落進任何看得到 error log 的人手上
 * (OWASP A09 Security Logging Failures)。
 *
 * 這支只負責「遮蔽」,不改變 token 的傳遞方式(要不要改用 header 或 POST body
 * 是另一個獨立決定,不在這次範圍)。
 */

/**
 * 需要遮蔽的 query 參數名(一律小寫比對)。
 *
 * 為什麼是這幾個:
 * - t / token / access_token / refresh_token / id_token:本系統與一般 OAuth 的憑證參數
 * - code / state:OAuth authorization code 流程的參數。Entra ID callback
 *   (`/api/auth/entra/callback?code=...&state=...`)一旦拋錯就會整條進 log,
 *   code 可換 access token,state 是 CSRF 防護值,兩者都不該留下。
 * - secret / password / signature / sig:一般性的保險,避免日後有人加了新端點忘記回來改。
 *
 * 刻意「不」放進來的:id、email、page、status 這類非憑證欄位,遮掉它們會讓
 * error log 失去可用性,而它們本身不是可重放的憑證。
 */
const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  't',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'state',
  'secret',
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  'client_secret',
  'password',
  'signature',
  'sig',
]);

/** 遮蔽後填入的替代值 */
export const REDACTED = '***';

/**
 * 憑證放在**路徑**上的端點。
 *
 * 這一段補的是原本的漏洞:這支檔頭以前寫著「連結長這樣 `/invite?t=<token>`」,
 * 但實際的路由是 `GET /api/invites/:token` 與 `POST /api/invites/:token/accept` ——
 * token 在路徑裡,而 redactUrl 遇到沒有 `?` 的網址是直接原樣回傳的。
 * 結果是對 `/api/invites/<還沒用過的 token>/accept` 送一個會 500 的請求,
 * 完整 token 就落進 error_logs.path,也印進 stdout。那是一組在時效內
 * 可以直接開一個帳號的憑證,而後台的錯誤頁會把它顯示出來。
 *
 * 規則寫成「前綴 + 下一段」:比對到前綴時,緊接著的那一段換成 `***`,
 * 後面的路徑(例如 `/accept`)保留 —— 留著才看得出是哪一支端點出錯。
 * 全域前綴 `api/` 寫成可有可無,setGlobalPrefix 改了也不會整條漏掉。
 */
const TOKEN_PATH_RULES: ReadonlyArray<RegExp> = [
  // /api/invites/<token> 與 /api/invites/<token>/accept
  /^(\/(?:api\/)?invites\/)([^/]+)/i,
  // 前端那一側的連結形狀,萬一日後由後端轉發也一併遮
  /^(\/(?:api\/)?invite\/)([^/]+)/i,
];

/**
 * 把路徑裡的憑證段換成 `***`。
 *
 * 空的那一段(`/api/invites/`)不動:沒有東西可外洩,而留著才看得出
 * 「有人送了一個空 token」這個線索,與 query 那一側的取捨一致。
 */
export function redactPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return '';
  for (const rule of TOKEN_PATH_RULES) {
    const m = rule.exec(path);
    if (m && m[1] && m[2]) {
      return path.slice(0, m[1].length) + REDACTED + path.slice(m[1].length + m[2].length);
    }
  }
  return path;
}

/**
 * 把 URL query string 裡的敏感參數值換成 `***`,其餘原樣保留。
 *
 * 設計取捨:
 * 1. 不用 `URL` / `URLSearchParams` 重組,因為它們會把整條 query 重新 encode
 *    (空白變 `+`、中文重新 percent-encode),log 出來的字串就跟客戶實際打的
 *    請求對不起來,debug 時反而更難追。這裡改成純字串切割,只動到要遮的那一段。
 * 2. 只切第一個 `?`;後面即使又出現 `?` 也視為 query 內容(瀏覽器行為一致)。
 * 3. 值是空字串時(`?t=`)不遮。留著 `t=` 才看得出「客戶送了空 token」這個線索,
 *    而空字串本來就沒有東西可外洩。
 * 4. 沒有 `=` 的裸參數(`?token`)也不動,同理:沒有值可洩漏。
 *
 * @param url 原始 URL,通常是 Express 的 `req.url`(路徑 + query,無 host)
 * @returns 遮蔽後的 URL;傳入非字串時回空字串(防呆,filter 不該因為遮蔽而再爆一次)
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return '';

  const qIndex = url.indexOf('?');
  // 沒有 query 的網址以前直接原樣回傳,而 token 在路徑上的端點正是這一種
  if (qIndex === -1) return redactPath(url);

  const path = redactPath(url.slice(0, qIndex));
  const query = url.slice(qIndex + 1);
  if (query.length === 0) return `${path}?`;

  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair; // 裸參數,沒有值

      const rawKey = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value.length === 0) return pair; // 空值,留著當線索

      // key 可能被 percent-encode(例如 `%74` = `t`),decode 失敗就退回原字串比對
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        // 壞掉的 percent-encoding,用原字串比對就好
        // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      }

      return SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join('&');

  return `${path}?${redacted}`;
}
