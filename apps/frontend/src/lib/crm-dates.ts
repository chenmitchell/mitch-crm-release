// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * CRM 畫面上的日期換算(全部以**組織設定的時區**為準)。
 *
 * ── 為什麼要單獨一支 ────────────────────────────────────────────────
 * 這些換算原本散在客戶卡(/admin/crm/[id])與 lib/crm-shared.ts 裡,而且用的是
 * `getFullYear()` / `getMonth()` / `getDate()` / `getHours()` —— 那是**瀏覽器所在
 * 時區**的年月日時分。但後端的逾期判斷、拜訪地圖的「今天要拜訪」、日報與戰情圖表
 * 全部走組織設定的時區(OrgTimeService → @mitchcrm/shared 的 org-time)。
 * 兩邊口徑不一致的後果有兩個,而且都沒有錯誤訊息:
 *
 *   (a) 裝置時區 ≠ 組織時區時,顯示與寫入的跟進日會差一天。
 *   (b) 日期輸入框轉回時間點時原本寫的是 `new Date(\`${key}T00:00:00\`)` ——
 *       沒有時區後綴,由瀏覽器解讀。於是「使用者選的那一天」在組織的日曆上
 *       可能落到前一天或後一天。
 *
 * 收成一支之後,畫面只要傳 `useAppSettings().timezone` 進來就好,
 * 而且這一支是純函式,測得到(見 tests/org-time.spec.ts)。
 *
 * 顯示用的格式沿用畫面原本的樣子(年/月/日),不改成 ISO 的橫線 ——
 * 這次要修的是時區,不是版面。
 */
import {
  firstInstantOfLocalDay,
  formatOrgDateTime,
  orgDateKey,
  orgDateParts,
} from '@mitchcrm/shared';

/** 沒有值時畫面上顯示的那一格 */
const EMPTY = '—';

/** 字串 → Date,解析不出來回 null(呼叫端自己決定顯示什麼) */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 月/日(看板卡片那種很窄的地方用) */
export function fmtOrgShortDate(iso: string | null, timeZone: string): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  const p = orgDateParts(d, timeZone);
  return `${p.month}/${p.day}`;
}

/** 年/月/日 */
export function fmtOrgDate(iso: string | null, timeZone: string): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  const p = orgDateParts(d, timeZone);
  return `${p.year}/${String(p.month).padStart(2, '0')}/${String(p.day).padStart(2, '0')}`;
}

/** 年/月/日 時:分 */
export function fmtOrgDateTime(iso: string | null, timeZone: string): string {
  const d = parse(iso);
  if (!d) return EMPTY;
  return formatOrgDateTime(d, timeZone, { seconds: false }).replace(/-/g, '/');
}

/**
 * 時間點 → `yyyy-mm-dd`(給 `<input type="date">` 用),以組織時區計。
 * 與 toInstantFromDateInput() 是一來一回:同一個時區進去、同一個時區出來,
 * 「打開客戶卡什麼都不改就存檔」才不會把日期挪一天。
 */
export function toDateInput(iso: string | null, timeZone: string): string {
  const d = parse(iso);
  return d ? orgDateKey(d, timeZone) : '';
}

/**
 * `yyyy-mm-dd` → 那一天在組織時區的**第一個真實存在的時間點**(ISO)。
 *
 * 用 firstInstantOfLocalDay 而不是「配 0 時 0 分」:切換點落在午夜的時區
 * (America/Santiago、America/Havana)當地根本沒有 00:00 這個牆上時間,
 * 直接算會退到前一天 23:00(理由見 @mitchcrm/shared 那一支的說明)。
 * 收不到合法的日期字串就回空字串,由呼叫端當成「沒有值」。
 */
export function toInstantFromDateInput(dateKey: string, timeZone: string): string {
  const [y, m, d] = dateKey.split('-').map((v) => Number.parseInt(v, 10));
  if (!y || !m || !d) return '';
  return firstInstantOfLocalDay(y, m, d, timeZone).toISOString();
}

/**
 * 客戶卡存檔時要不要送出 `nextFollowUpAt`。
 *
 * 畫面上那一格是 `<input type="date">`,只有日期沒有時間,所以送出去一定會把
 * 時間壓成當天的第一個時間點。原本每次存檔都無條件送,後果是:打卡流程設定的
 * 「9/10 14:30」跟進時間,只要有人在客戶卡上改了**其他任何欄位**再存檔,
 * 就會被靜默改寫成 9/10 00:00 —— 使用者沒有碰過那一格,畫面上也沒有任何提示。
 *
 * 所以這裡先比對「同一個時區換算出來的日期字串」:一樣就回 `{}`(欄位不送,
 * 後端的 PATCH 對 undefined 是不動那一格),不一樣才送新值或 null。
 *
 * @param editValue  表單目前那一格的值(`yyyy-mm-dd`,清空時是空字串)
 * @param originalIso 這張客戶卡原本的 nextFollowUpAt(ISO,沒有就是 null)
 */
export function followUpPatch(
  editValue: string,
  originalIso: string | null,
  timeZone: string,
): { nextFollowUpAt?: string | null } {
  const original = toDateInput(originalIso, timeZone);
  if (editValue === original) return {};
  if (!editValue) return { nextFollowUpAt: null };
  return { nextFollowUpAt: toInstantFromDateInput(editValue, timeZone) };
}
