// ref:3687 mc/陳彥輔/米球®
/**
 * 組織時區的日期計算(前後端共用的唯一一份)。
 *
 * 為什麼要有這一份:
 *   系統設定有「時區」這一格,使用者選得到 13 個時區。在這支之前,全 repo 的
 *   日期計算是各自寫死的 UTC+8 常數(後端四份、前端五份),設定選什麼都沒有用。
 *   組織設在 America/New_York、伺服器跑 UTC 時,當地中午 12:00 系統就跳到隔天:
 *   早上排下午要去的拜訪一律被記成「錯過」、中午起拒絕「排今天」、下午送的日報
 *   算成隔天所以主管看到「今天沒交」,連存證照片的浮水印壓的都是台北時間。
 *
 * 為什麼用 Intl.DateTimeFormat 而不是固定 offset:
 *   固定 offset 只在沒有夏令時間的時區才成立。America/New_York 三月與十一月
 *   各切換一次,寫死 -5 會在半年裡整整差一小時,跨日的那一小時就會算錯日子。
 *   Intl 查的是執行環境的 IANA 時區資料庫,DST 由它負責。
 *
 * 名詞:
 *   dateKey  當地日曆日的 'YYYY-MM-DD'。資料庫的 @db.Date 欄位用同一天的 UTC 午夜表示。
 *   instant  真正的時間點(UTC),就是 JS 的 Date。
 */

/** 出廠預設時區。設定讀不到時的保底值,前後端共用同一個常數 */
export const DEFAULT_TIME_ZONE = 'Asia/Taipei';

/**
 * 出廠預設地區(BCP 47)。與 DEFAULT_TIME_ZONE 是同一組「地區與語系」設定的保底值,
 * 放在一起才不會有人在後端補一份、前端再補一份不一樣的。
 */
export const DEFAULT_LOCALE = 'zh-TW';

/** BCP 47 語言標籤的保守格式。設定值要進 HTTP 標頭,不合格式的一律不送 */
const LOCALE_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;

/** 收斂地區設定:格式不合(或空的)退回出廠預設,不把使用者輸入直接塞進標頭 */
export function resolveLocale(locale?: string | null): string {
  const v = typeof locale === 'string' ? locale.trim() : '';
  return v && v.length <= 35 && LOCALE_RE.test(v) ? v : DEFAULT_LOCALE;
}

/** 一天的毫秒數(純日曆計算用,不代表真實一天長度 —— DST 那天不是 24 小時) */
export const DAY_IN_MS = 86_400_000;

/** 已驗證過的時區字串;Intl 每次 new 都不便宜,快取一份 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const validityCache = new Map<string, boolean>();

/** 這個字串是不是執行環境認得的 IANA 時區 */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  const key = tz.trim();
  const cached = validityCache.get(key);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: key });
  } catch {
    ok = false;
  }
  validityCache.set(key, ok);
  return ok;
}

/**
 * 把設定值收斂成一個一定用得起來的時區字串。
 * 認不得的字串(手動改資料庫、舊資料、打錯字)退回出廠預設,而不是讓整條路徑丟例外 ——
 * 一格設定打錯不該讓打卡、日報、地圖同時停掉。
 */
export function resolveTimeZone(tz?: string | null): string {
  const t = typeof tz === 'string' ? tz.trim() : '';
  if (t && isValidTimeZone(t)) return t;
  return isValidTimeZone(DEFAULT_TIME_ZONE) ? DEFAULT_TIME_ZONE : 'UTC';
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface OrgDateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** 某個時間點在指定時區的年月日時分秒 */
export function orgDateParts(instant: Date, tz?: string | null): OrgDateParts {
  const zone = resolveTimeZone(tz);
  const parts = partsFormatter(zone).formatToParts(instant);
  const get = (type: string): number => {
    const v = parts.find((p) => p.type === type)?.value ?? '0';
    return Number.parseInt(v, 10);
  };
  // 'en-CA' + hourCycle h23 的午夜是 00,不會出現 24;真出現就折回 0 保險
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 某個時間點在指定時區屬於哪個日曆日('YYYY-MM-DD') */
export function orgDateKey(instant: Date, tz?: string | null): string {
  const p = orgDateParts(instant, tz);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 指定時區的「今天」('YYYY-MM-DD') */
export function orgToday(now: Date = new Date(), tz?: string | null): string {
  return orgDateKey(now, tz);
}

/**
 * 當地牆上時間 → UTC 時間點。
 *
 * 先用「當成 UTC」估一次偏移,扣掉之後再用估出來的時間點量一次偏移;
 * 兩次不同就用第二次的(這是 DST 切換前後才會發生的事)。
 *
 * 春季往前跳的那一小時當地並不存在(例如 America/New_York 的 02:30)。
 * 這種輸入不會丟例外,而是落到**切換之前**的時刻:02:30 會算成當地 01:30
 * (還是 GMT-5),不是切換後的 03:30。呼叫端要的是一個能用的時間點,
 * 不是要驗證使用者輸入。
 *
 * 這個「落在切換之前」的性質對大多數呼叫端沒差,但對「當地那一天的起點」
 * 有差:切換點剛好在午夜的時區(America/Santiago、America/Havana),
 * 當地 00:00 本身就是不存在的牆上時間,算出來會退到**前一天的 23:00**。
 * 所以要「某個日曆日的第一個時間點」請一律用 firstInstantOfLocalDay(),
 * 不要直接拿這一支配 0 時 0 分 0 秒。
 */
export function orgZonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz?: string | null,
): Date {
  const zone = resolveTimeZone(tz);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = offsetAt(new Date(wall), zone);
  let ts = wall - offset1;
  const offset2 = offsetAt(new Date(ts), zone);
  if (offset2 !== offset1) ts = wall - offset2;
  return new Date(ts);
}

/** 某個時間點的時區偏移(毫秒);內部用,已確定 tz 合法 */
function offsetAt(instant: Date, tz: string): number {
  const p = orgDateParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const floorSec = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - floorSec;
}

/**
 * DST 往前跳最多可能跳幾分鐘。Lord Howe 島跳 30 分鐘,多數地區跳 60 分鐘,
 * 少數歷史紀錄(例如 1940 年代的雙夏令時間)跳 120 分鐘。取 180 分鐘當上限,
 * 有餘裕但不會在找不到的情況下掃太久。
 */
const MAX_DST_GAP_MINUTES = 180;

/**
 * 某個當地日曆日的**第一個真實存在的時間點**。
 *
 * 為什麼不能直接用 orgZonedTimeToUtc(y, m, d, 0, 0, 0):
 *   多數時區的 DST 切換點在凌晨兩三點,當地 00:00 是存在的,兩者同義。
 *   但有一批時區把切換點放在午夜:America/Santiago 的春季切換是 24:00 → 01:00,
 *   America/Havana 也一樣。那一天當地根本沒有 00:00 這個牆上時間,
 *   而 orgZonedTimeToUtc 對不存在的牆上時間會落到切換之前(見那一支的說明),
 *   結果是「當天的起點」退到前一天 23:00,整個區間多含前一天最後一小時。
 *   當地 23:00 到 23:59 送出的日報、打卡就會被算進隔天,一年一到兩次,
 *   而且沒有任何錯誤訊息。
 *
 * 做法:先照舊估一次,然後檢查估出來的時間點在當地是不是同一個日曆日。
 * 是就直接用(絕大多數情況,零額外成本);不是就以一分鐘為步長往後掃,
 * 掃到第一個落在目標日曆日的時間點為止。掃不到(理論上不會發生)退回原估值,
 * 寧可維持舊行為也不要丟例外 —— 這條路徑上有打卡與日報。
 */
export function firstInstantOfLocalDay(
  year: number,
  month: number,
  day: number,
  tz?: string | null,
): Date {
  const zone = resolveTimeZone(tz);
  const target = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  const est = orgZonedTimeToUtc(year, month, day, 0, 0, 0, zone);
  if (orgDateKey(est, zone) === target) return est;
  for (let i = 1; i <= MAX_DST_GAP_MINUTES; i += 1) {
    const probe = new Date(est.getTime() + i * 60_000);
    if (orgDateKey(probe, zone) === target) return probe;
  }
  return est;
}

/**
 * 'YYYY-MM-DD' → @db.Date 欄位存的 UTC 午夜 Date。
 * 這是資料庫表示法,不是時間點:Prisma 對 DATE 欄位取 UTC 的年月日。
 */
export function dateKeyToUtcMidnight(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

/**
 * 'YYYY-MM-DD' 加減天數,純日曆運算(以 UTC 午夜推,不受時區與 DST 影響)。
 * DST 切換那天當地只有 23 或 25 小時,但「隔天」還是隔天,日曆日加一就對。
 */
export function addCalendarDays(dateKey: string, days: number): string {
  return new Date(dateKeyToUtcMidnight(dateKey).getTime() + days * DAY_IN_MS)
    .toISOString()
    .slice(0, 10);
}

export interface OrgDayRange {
  /** 當地日曆日 'YYYY-MM-DD' */
  dateKey: string;
  /** 當地 00:00:00.000 對應的 UTC 時間點(含) */
  start: Date;
  /** 隔天當地 00:00:00.000 對應的 UTC 時間點(不含) */
  endExclusive: Date;
  /** 當地當天最後一毫秒的 UTC 時間點(含);查詢用 lte 時用這個 */
  endInclusive: Date;
}

/**
 * 某個日曆日在指定時區的起訖時間點。
 * DST 那天長度不是 24 小時,所以起點與終點各自算,不用「起點 + 86400000」。
 * 起點與終點都走 firstInstantOfLocalDay():切換點落在午夜的時區,
 * 當地 00:00 是不存在的牆上時間,直接算會退到前一天(理由見那一支)。
 */
export function orgDayRangeOf(dateKey: string, tz?: string | null): OrgDayRange {
  const zone = resolveTimeZone(tz);
  const [y, m, d] = dateKey.split('-').map((v) => Number.parseInt(v, 10)) as [
    number,
    number,
    number,
  ];
  const start = firstInstantOfLocalDay(y, m, d, zone);
  const next = addCalendarDays(dateKey, 1);
  const [ny, nm, nd] = next.split('-').map((v) => Number.parseInt(v, 10)) as [
    number,
    number,
    number,
  ];
  const endExclusive = firstInstantOfLocalDay(ny, nm, nd, zone);
  return { dateKey, start, endExclusive, endInclusive: new Date(endExclusive.getTime() - 1) };
}

/** 某個時間點所在的當地一天的起訖 */
export function orgDayRange(now: Date = new Date(), tz?: string | null): OrgDayRange {
  return orgDayRangeOf(orgDateKey(now, tz), tz);
}

/**
 * 統計期間:週 / 月 / 季。
 *
 * 「一週從週一開始」是寫死的(ISO 8601 的算法)。設在以週日或週六為一週之始的
 * 地區時,週報表的起訖會跟當地習慣差一天。要改成可設定的話,起始星期得變成
 * 一格系統設定,而且戰情圖表、本週工作報告、日報三處要一起吃同一格。
 */
export type OrgPeriod = 'week' | 'month' | 'quarter';

/** 期間起點(UTC 時間點),以指定時區的週一 / 月初 / 季初 00:00 為準 */
export function orgPeriodStart(period: OrgPeriod, now: Date, tz?: string | null): Date {
  const zone = resolveTimeZone(tz);
  const key = orgDateKey(now, zone);
  const p = orgDateParts(now, zone);
  // 月初 / 季初一樣要走 firstInstantOfLocalDay():那一天剛好是午夜切換的話,
  // 當地 00:00 不存在,直接算會把期間起點提早到上個月的最後一小時
  if (period === 'month') return firstInstantOfLocalDay(p.year, p.month, 1, zone);
  if (period === 'quarter') {
    const firstMonth = p.month - ((p.month - 1) % 3);
    return firstInstantOfLocalDay(p.year, firstMonth, 1, zone);
  }
  // 週:以當地日曆日推回到週一。用 UTC 午夜算星期幾是安全的 ——
  // 它問的是「這個日曆日是星期幾」,與時區偏移無關。
  const dow = (dateKeyToUtcMidnight(key).getUTCDay() + 6) % 7; // 週一 = 0
  const monday = addCalendarDays(key, -dow);
  return orgDayRangeOf(monday, zone).start;
}

export interface FormatOrgTimeOptions {
  /** 要不要秒(預設要) */
  seconds?: boolean;
  /** 日期與時間之間的分隔字元,預設空白 */
  separator?: string;
}

/** 時間點 → 當地「YYYY-MM-DD HH:mm:ss」 */
export function formatOrgDateTime(
  instant: Date,
  tz?: string | null,
  opts: FormatOrgTimeOptions = {},
): string {
  const p = orgDateParts(instant, tz);
  const hm = `${pad2(p.hour)}:${pad2(p.minute)}`;
  const time = opts.seconds === false ? hm : `${hm}:${pad2(p.second)}`;
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}${opts.separator ?? ' '}${time}`;
}

/**
 * 時區標示,例如 GMT+8、GMT-4、GMT+5:30。
 * 存證照片的浮水印一定要帶這個:跨時區的證據上只寫「14:30」沒有意義,
 * 對造可以主張那是別的時區的 14:30。偏移隨 DST 變,所以要看時間點。
 */
export function orgTimeZoneLabel(instant: Date, tz?: string | null): string {
  const zone = resolveTimeZone(tz);
  const offset = offsetAt(instant, zone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.round((abs % 3_600_000) / 60_000);
  return m === 0 ? `GMT${sign}${h}` : `GMT${sign}${h}:${pad2(m)}`;
}

/** 「YYYY-MM-DD HH:mm:ss (GMT+8)」,浮水印與存證用 */
export function formatOrgStamp(
  instant: Date,
  tz?: string | null,
  opts: FormatOrgTimeOptions = {},
): string {
  return `${formatOrgDateTime(instant, tz, opts)} (${orgTimeZoneLabel(instant, tz)})`;
}
