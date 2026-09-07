// ref:3687 mc/陳彥輔/米球®
/**
 * 外部查詢帶入的純函式:網址樣板檢查、SSRF 判定、回應取值。
 *
 * 為什麼獨立成一支:這幾件事全部是「給一個輸入、判斷合不合法」,
 * 不需要 Nest、不需要網路、不需要資料庫,所以可以逐條寫測試。
 * 服務本體(lookup.service.ts)只負責把它們串起來加上逾時與大小上限。
 *
 * 這裡的判斷是安全邊界,不是格式美化:
 *   後台可以填任意一個網址,而這個網址是由**伺服器**去打的。
 *   沒有這一層,任何一位系統管理員(或拿到管理員權限的人)都能把
 *   查詢網址指向 http://127.0.0.1:8787 或雲端平台的 metadata 位址,
 *   再從查詢結果把內容讀回來 —— 這就是 SSRF(OWASP A10)。
 *   所以規則是白名單式的:只准 https、只准公開網際網路位址、不准轉址、
 *   不准帶帳號密碼、不准非標準連接埠以外的花樣。
 */

import { LOOKUP_TARGET_FIELDS, type LookupTargetField } from '@mitchcrm/shared';

/** 查詢字串在網址樣板裡的佔位符。後台的說明文字與這裡共用同一個常數 */
export const LOOKUP_PLACEHOLDER = '{q}';

/** 網址樣板長度上限(後台輸入框與 DTO 共用) */
export const LOOKUP_URL_TEMPLATE_MAX = 500;

/** 使用者輸入的識別碼長度上限。再長就不是識別碼了,是在試探上游 */
export const LOOKUP_QUERY_MAX = 64;

/**
 * 對應到客戶欄位的三個目標欄位。後台的欄位對應表只認這三個 key。
 *
 * 定義在 @mitchcrm/shared,前後端共用同一份;這裡只是 re-export,不要另外寫一份。
 * 這份清單原本在後端就有兩處(這裡與 app-settings/app-settings.view.ts),
 * 前端再一處,三邊各自維護,而走散時是靜默的:清洗那一側不認得的欄位直接丟掉。
 */
export { LOOKUP_TARGET_FIELDS };
export type { LookupTargetField };

/** 查詢結果。三個欄位都可能沒有(上游沒回、或後台沒對應) */
export type LookupResult = Partial<Record<LookupTargetField, string>>;

export type CheckResult = { ok: true } | { ok: false; message: string };

/**
 * 只准 https。
 *
 * http 會讓查詢字串與回應在網路上裸奔,而且大部分內網服務都是 http ——
 * 擋掉 http 本身就先擋掉一大半的 SSRF 目標。
 */
const ALLOWED_PROTOCOL = 'https:';

/**
 * 一定不能打的主機名(不分大小寫)。
 * 這一份是「連 DNS 都不用查就知道不行」的清單,DNS 解析後還會再檢查一次位址。
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
]);

/**
 * 一定不能打的主機名結尾。
 * .local / .internal / .localhost 是保留給內網與容器網路的名字空間。
 */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** 把 [::1] 這種 URL 主機表示法還原成純位址 */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** 純 IPv4 位址字串 → 四個位元組;不是的話回 null */
function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * 這個 IPv4 位址是不是「不該讓伺服器主動去打」的位址。
 *
 * 涵蓋:回送(127/8)、本網路(0/8)、私有網段(10/8、172.16/12、192.168/16)、
 * 電信級 NAT(100.64/10)、連結本地與雲端 metadata(169.254/16,含 169.254.169.254)、
 * 測試網段(192.0.0/24、192.0.2/24、198.51.100/24、203.0.113/24)、
 * 效能測試(198.18/15)、群播與保留(224/4、240/4)、廣播(255.255.255.255)。
 */
export function isBlockedIpv4(value: string): boolean {
  const b = parseIpv4(value);
  if (!b) return false;
  const [a, second, third] = b as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && second >= 64 && second <= 127) return true;
  if (a === 169 && second === 254) return true;
  if (a === 172 && second >= 16 && second <= 31) return true;
  if (a === 192 && second === 168) return true;
  if (a === 192 && second === 0 && (third === 0 || third === 2)) return true;
  if (a === 198 && (second === 18 || second === 19)) return true;
  if (a === 198 && second === 51 && third === 100) return true;
  if (a === 203 && second === 0 && third === 113) return true;
  if (a >= 224) return true; // 群播 224/4、保留 240/4、廣播 255.255.255.255
  return false;
}

/**
 * IPv6 版本。除了回送(::1)與未指定(::),還要擋:
 *   fc00::/7  唯一本地位址(等同 IPv4 的私有網段)
 *   fe80::/10 連結本地
 *   ::ffff:a.b.c.d 與 ::a.b.c.d 這種內嵌 IPv4 的寫法 —— 不還原的話,
 *              ::ffff:127.0.0.1 會整個繞過上面那支檢查。
 */
export function isBlockedIpv6(value: string): boolean {
  const v = stripBrackets(value).toLowerCase().split('%')[0] ?? '';
  if (!v.includes(':')) return false;
  if (v === '::1' || v === '::') return true;
  // 內嵌 IPv4:取最後一段還原成 IPv4 再判一次
  const embedded = v.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded?.[1] && isBlockedIpv4(embedded[1])) return true;
  const head = v.split(':')[0] ?? '';
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true; // fe80::/10
  return false;
}

/** 一個位址字串(IPv4 或 IPv6)該不該擋 */
export function isBlockedAddress(value: string): boolean {
  const v = stripBrackets(value.trim());
  if (v === '') return true;
  return isBlockedIpv4(v) || isBlockedIpv6(v);
}

/** 主機名本身就該擋(不用查 DNS 也知道) */
export function isBlockedHostname(hostname: string): boolean {
  const h = stripBrackets(hostname.trim().toLowerCase().replace(/\.$/, ''));
  if (h === '') return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // 單一標籤的主機名(沒有點)一定是內網名字,例如 http://intranet/
  if (!h.includes('.') && !h.includes(':')) return true;
  return isBlockedAddress(h);
}

/**
 * 檢查一個「已經把 {q} 換掉」的網址能不能打。
 *
 * 注意這一支不查 DNS:主機名可能解析到私有位址(DNS rebinding),
 * 那一層在 lookup.service.ts 送出請求前用 dns.lookup 再擋一次。
 * 兩層都要有 —— 這一支擋得掉直接寫死 IP 的情況,DNS 那層擋得掉用網域繞過的情況。
 */
export function checkLookupUrl(raw: string): CheckResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      message: '查詢網址格式不正確,請填完整的網址,例如 https://example.com/api?id={q}',
    };
  }
  if (url.protocol !== ALLOWED_PROTOCOL) {
    return { ok: false, message: '查詢網址只接受 https,請改用加密連線的網址' };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      message: '查詢網址不可以把帳號密碼寫在網址裡,請改用查詢字串或改由上游服務授權',
    };
  }
  if (isBlockedHostname(url.hostname)) {
    return {
      ok: false,
      message: '查詢網址不可以指向內部網路、本機或保留位址,請填一個對外的服務網址',
    };
  }
  return { ok: true };
}

/**
 * 檢查後台填的網址樣板。空字串代表「還沒設定」,由呼叫端決定要不要當成錯誤。
 *
 * 用一個不會出現在真實識別碼裡的樣本值代入 {q} 之後再檢查整個網址 ——
 * 樣板本身不是合法網址(帶著大括號),不代掉檢查不了。
 */
export function checkLookupUrlTemplate(template: string): CheckResult {
  const t = template.trim();
  if (t === '') return { ok: false, message: '請先填查詢網址樣板' };
  if (t.length > LOOKUP_URL_TEMPLATE_MAX) {
    return { ok: false, message: `查詢網址樣板最長 ${LOOKUP_URL_TEMPLATE_MAX} 個字` };
  }
  if (!t.includes(LOOKUP_PLACEHOLDER)) {
    return {
      ok: false,
      message: `查詢網址樣板要包含 ${LOOKUP_PLACEHOLDER},那是查詢字串會被代進去的位置`,
    };
  }
  return checkLookupUrl(t.split(LOOKUP_PLACEHOLDER).join('0'));
}

/**
 * 把查詢字串代進樣板。
 *
 * 一律做 encodeURIComponent:識別碼裡若含有 & 或 # 或 /,不編碼的話
 * 使用者就能自己改寫查詢字串、甚至改寫路徑,那是另一種注入。
 * 代完之後再檢查一次整個網址,不能只信樣板檢查的結果。
 */
export function buildLookupUrl(template: string, q: string): CheckResult & { url?: string } {
  const templateCheck = checkLookupUrlTemplate(template);
  if (!templateCheck.ok) return templateCheck;
  const url = template.trim().split(LOOKUP_PLACEHOLDER).join(encodeURIComponent(q));
  const urlCheck = checkLookupUrl(url);
  if (!urlCheck.ok) return urlCheck;
  return { ok: true, url };
}

/** 原型污染用的 key。取值時一律跳過,不然 fieldMap 可以拿來讀到不該讀的東西 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 依「點分隔路徑」從解析後的 JSON 取值,例如 data.company_name、items.0.name。
 *
 * 取不到、或取到的不是字串 / 數字,一律回 null ——
 * 上游回一個物件時,硬轉成字串會在畫面上出現 [object Object]。
 */
export function pickByPath(source: unknown, path: string): string | null {
  const segments = path
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length === 0) return null;
  let cur: unknown = source;
  for (const seg of segments) {
    if (FORBIDDEN_KEYS.has(seg)) return null;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return null;
      cur = cur[Number(seg)];
      continue;
    }
    if (typeof cur !== 'object' || cur === null) return null;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === 'string') return cur.trim() || null;
  if (typeof cur === 'number' && Number.isFinite(cur)) return String(cur);
  return null;
}

/**
 * 依後台設定的欄位對應表,把上游回應攤成 { name, address, phone }。
 * 對應不到的欄位整個不出現(不是空字串)—— 前端據此判斷「這一格不要蓋掉使用者已經填的值」。
 */
export function applyFieldMap(payload: unknown, fieldMap: Record<string, string>): LookupResult {
  const out: LookupResult = {};
  for (const field of LOOKUP_TARGET_FIELDS) {
    const path = (fieldMap[field] ?? '').trim();
    if (path === '') continue;
    const value = pickByPath(payload, path);
    if (value !== null) out[field] = value;
  }
  return out;
}

/** 識別碼格式的長度上限。真正的格式規則寫不到這麼長,寫得到就不是格式規則了 */
export const LOOKUP_PATTERN_MAX = 200;

/**
 * 這條正規表示式安不安全(ReDoS 靜態檢查)。
 *
 * 為什麼需要:這條式子是**後台填的**,然後拿去對**使用者輸入**執行。
 * JavaScript 的 RegExp 是回溯式的,`(a+)+$` 這種「量詞套量詞」對 64 個字的輸入
 * 就是天文數字級的回溯,一個請求可以把整條 Node 主執行緒卡死 —— 而且它是單執行緒,
 * 卡住的不是那一個請求,是整台後端。輸入長度上限(LOOKUP_QUERY_MAX)擋不住這件事,
 * 指數成長對 64 個字一樣爆炸。
 *
 * Node 沒有「跑 regex 但限制時間」的機制(RegExp 執行時不會讓出執行緒,
 * 逾時就攔不到),所以只能在編譯之前**靜態擋掉會爆炸的形狀**:
 *   1. 量詞直接套在「內含量詞或選擇分支的群組」上 —— (a+)+、(a|aa)* 這一類,
 *      這是指數回溯的標準來源
 *   2. 量詞疊量詞 —— a+*、a{2,}+
 *   3. 對反向參照下量詞 —— (\d)\1+
 * 誤擋的代價是「後台要把格式寫得直白一點」,漏擋的代價是整台服務停擺,
 * 所以這裡刻意從嚴。
 */
export function checkLookupPatternSafety(pattern: string): CheckResult {
  const p = pattern.trim();
  if (p.length > LOOKUP_PATTERN_MAX) {
    return { ok: false, message: `識別碼格式最長 ${LOOKUP_PATTERN_MAX} 個字` };
  }

  // 群組的起訖位置。逐字掃,跳過跳脫字元與字元類別內的括號
  const openStack: number[] = [];
  let inClass = false;

  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') {
      // 跳脫:連同下一個字一起跳過
      const next = p[i + 1];
      // 對反向參照下量詞同樣會回溯爆炸
      if (next !== undefined && /\d/.test(next) && isQuantifierAt(p, i + 2)) {
        return { ok: false, message: '識別碼格式不能對反向參照加上重複次數' };
      }
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      openStack.push(i);
      continue;
    }
    if (ch === ')') {
      const start = openStack.pop();
      if (start === undefined) continue; // 括號不成對,交給 RegExp 自己報錯
      if (isQuantifierAt(p, i + 1) && bodyCanBacktrack(p.slice(start + 1, i))) {
        return {
          ok: false,
          message:
            '識別碼格式裡有「重複次數套在還會重複的括號上」的寫法,那會讓查詢卡住整台服務,請改寫得直白一些(例如八位數字直接寫 \\d{8})',
        };
      }
      continue;
    }
    // 量詞疊量詞
    if (isQuantifierAt(p, i) && isQuantifierAt(p, i + quantifierLength(p, i))) {
      return { ok: false, message: '識別碼格式裡有連續兩個重複次數,請改寫' };
    }
  }

  return { ok: true };
}

/** 位置 i 是不是一個量詞的開頭(* + ? 或 {n,m}) */
function isQuantifierAt(p: string, i: number): boolean {
  const ch = p[i];
  if (ch === '*' || ch === '+') return true;
  // 單獨的 ? 是「可有可無」,本身不會製造指數回溯,但接在量詞後面的 ? 是懶惰修飾,
  // 那不算「疊一層量詞」,所以 ? 只在群組後面才視為量詞
  if (ch === '?') return true;
  if (ch === '{') return /^\{\d+(,\d*)?\}/.test(p.slice(i));
  return false;
}

/** 量詞本身的長度(給「量詞疊量詞」的判斷往後跳用) */
function quantifierLength(p: string, i: number): number {
  if (p[i] === '{') {
    const m = /^\{\d+(,\d*)?\}/.exec(p.slice(i));
    return m ? m[0].length : 1;
  }
  return 1;
}

/**
 * 這一段群組內容有沒有「可以用不同方式配同一段字」的能力。
 * 有量詞或有選擇分支就算有 —— 那正是外層再套一個量詞會爆炸的條件。
 * 字元類別裡的 | 與 * 是字面值,不算。
 */
function bodyCanBacktrack(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '|') return true;
    if (ch === '*' || ch === '+') return true;
    if (ch === '{' && /^\{\d+(,\d*)?\}/.test(body.slice(i))) return true;
  }
  return false;
}

/**
 * 把後台填的識別碼格式(正規表示式字串)編成 RegExp。
 *
 * 空字串 = 不限制格式,回 null。編不起來也回 null 並讓呼叫端記一筆警告 ——
 * 後台填錯一個括號不該讓整支查詢變成 500,那樣使用者只會看到「查詢失敗」。
 * 一律加上 ^...$ 錨點:沒有錨點的話 `\d{8}` 會讓 `abc12345678xyz` 通過。
 *
 * 靜態安全檢查沒過的也回 null(理由見 checkLookupPatternSafety)。存檔那一側會
 * 先擋下來並顯示原因,這裡是第二道:資料庫裡若已經躺著一條舊的危險式子,
 * 升級之後它會被當成「編不起來」略過,而不是照樣拿去跑。
 */
export function compileLookupPattern(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (p === '') return null;
  if (!checkLookupPatternSafety(p).ok) return null;
  const anchored = `^(?:${p})$`;
  try {
    return new RegExp(anchored);
  } catch {
    return null;
  }
}
