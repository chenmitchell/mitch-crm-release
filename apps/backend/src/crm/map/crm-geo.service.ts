/**
 * 拜訪地圖服務:地址地理編碼(OpenStreetMap Nominatim,免費無金鑰)、
 * 附近客戶查詢(haversine 距離排序)、最近鄰拜訪順序。
 *
 * - Nominatim 使用政策:必帶自訂 User-Agent、每秒最多 1 次;這裡用 promise 佇列序列化,
 *   兩次請求間隔 ≥ 1100ms,逾時 8 秒,失敗只記 warn 不丟例外。
 *   fetch 不跟隨轉址(redirect: 'error'),回應 Content-Length 超過 64KB 視為失敗不讀 body。
 * - NOMINATIM_EMAIL 沒設時 User-Agent 會帶 placeholder,服務建構時 warn 一次提醒。
 * - 地址優先序:actualAddress > registeredAddress > contactAddress。
 * - 成功才寫回 dev_customers.lat / lng / geocodedAt;失敗不碰 DB,失敗時間記在記憶體 Map(failedAt)
 *   做 24 小時退避,避免每次都重打外部服務。前提是後端單一實例:多實例各自有一份 Map,只會多重試幾次,
 *   不影響正確性;重啟後退避歸零也只是多打一輪。geocodedAt 因此只代表「最近一次成功編碼」。
 * - 可見範圍照 CRM 規則:業務只看自己的 ownerId,主管/admin 看全部;排除終止階段(dev_stages.is_terminal)。
 * - 「今日要拜訪」兩個來源取聯集:nextFollowUpAt 在今天結束前(含逾期),或 dev_visit_plans 有
 *   plannedDate = 今天(組織時區)且 status = planned 的紀錄。每列都帶 plannedToday 讓前端畫勾選狀態。
 * - 背景補座標:新增客戶或改了地圖用的地址後,crm.service 呼叫 scheduleGeocode(id) 把客戶排進記憶體佇列,
 *   由 setImmediate 啟動、逐筆走同一條 Nominatim 佇列(自然維持每秒一筆),失敗只記 warn,不影響主流程。
 * - 反查路名:reverseGeocode(lat, lng) 走同一條佇列打 Nominatim /reverse,結果以座標(四捨五入到小數 4 位)
 *   為 key 快取 10 分鐘;只回 road / district / city / display 四個欄位,不回外部原始錯誤。
 * - 系統設定的 geocodeProvider='none' 時,以上三條對外路徑(補齊座標、背景補座標、反查路名)
 *   一律不發出請求,座標改成全部人工填。
 * - 限制國家由系統設定的 geocodeCountryCodes 決定,空字串 = 不限制。不寫死任何一國。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ownerFilter, type ViewScope } from '../../scope/view-scope';
import { notDeletedWhere, relatedLiveCustomerWhere } from '../crm-scope-filters';
import {
  DEFAULT_LOCALE,
  dateKeyToUtcMidnight,
  orgDayRange,
  orgToday,
  resolveLocale,
  resolveTimeZone,
} from '@mitchcrm/shared';
import { normalizeGeocodeCountryCodes } from '../../app-settings/app-settings.view';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgTimeService } from '../../settings/org-time.service';
import { SettingsService } from '../../settings/settings.service';
import { StageCatalogService } from '../../app-settings/stage-catalog.service';
// 地球半徑只有一份(見 common/geo.ts)
import { EARTH_RADIUS_M } from '../../common/geo';
import { DEFAULT_DEV_STAGES } from '@mitchcrm/shared';

/**
 * 預設的公共 Nominatim。自架或改用相容服務時,把基底網址填進系統設定的
 * geocoderBaseUrl(GET/PUT /api/admin/app-settings),不必改 code、不必重新部署。
 */
const DEFAULT_GEOCODER_BASE = 'https://nominatim.openstreetmap.org';
/** User-Agent 的產品名預設值,同樣可由系統設定覆寫 */
const DEFAULT_GEOCODER_AGENT = 'MitchCRM';
/** 沒有任何聯絡信箱時送出去的 placeholder。Nominatim 使用政策要求帶得出聯絡方式 */
const PLACEHOLDER_CONTACT = 'contact@example.invalid';
/** 反查快取:座標四捨五入到小數 4 位(約 11 公尺)當 key,保留 10 分鐘,最多 500 筆 */
const REVERSE_CACHE_TTL_MS = 10 * 60 * 1000;
const REVERSE_CACHE_MAX = 500;
/** 背景補座標佇列上限,超過就丟掉最舊的(之後按「補齊地址座標」仍會補到) */
const BACKGROUND_QUEUE_MAX = 200;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const NOMINATIM_TIMEOUT_MS = 8_000;
/** Nominatim limit=1 的回應通常只有幾 KB;超過這個數就當異常,不讀 body */
const NOMINATIM_MAX_RESPONSE_BYTES = 64 * 1024;
const GEOCODE_RETRY_AFTER_MS = 24 * 3600 * 1000;
/**
 * 一次補座標最多處理幾筆。外掛的地理編碼服務(預設 Nominatim)有使用規範,
 * 這個數字不是效能取捨而是禮貌上限,不要為了「一次跑完」把它調大。
 *
 * 匯出是因為畫面要拿它算「還有 N 筆,大概還要按幾次」——
 * 兩千筆客戶配上這個上限與每人 30 秒的間隔,實際是兩百次、跨一百分鐘。
 * 使用者按了三次看到數字只少了 30 筆,如果畫面不說,他只會以為功能壞了。
 */
export const GEOCODE_BATCH_MAX = 10;
/** 地圖「今天」視角一次最多帶幾筆拜訪排程 */
const TODAY_PLAN_TAKE = 500;
/**
 * 地圖客戶清單一次最多帶幾筆。看得到全公司(admin)時沒有上限的話,
 * 一個請求就會把全公司客戶連同聯絡人姓名 / 電話 / 地址整包載進記憶體再吐出去。
 */
const LIST_TAKE = 2000;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface ReverseResult {
  road: string | null;
  district: string | null;
  city: string | null;
  display: string | null;
}

export interface RoutePoint {
  id: string;
  lat: number | null;
  lng: number | null;
}

export interface RouteStep {
  id: string;
  /** 從上一個點到這裡的距離(公尺);沒座標的點排最後,值為 null 且不計入 totalM。 */
  distanceFromPrevM: number | null;
}

/** 兩點大圓距離(公尺),haversine 公式。 */
export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 最近鄰啟發式:從起點開始,每次挑「還沒去過、離目前位置最近」的點。
 * 沒座標的點一律排在最後,distanceFromPrevM 為 null,不計入 totalM。
 */
export function nearestNeighborOrder(
  start: LatLng,
  points: RoutePoint[],
): { order: RouteStep[]; totalM: number } {
  const hasCoords = (p: RoutePoint): p is RoutePoint & LatLng =>
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng);
  const withCoords = points.filter(hasCoords);
  const withoutCoords = points.filter((p) => !hasCoords(p));

  const order: RouteStep[] = [];
  let totalM = 0;
  let cur: LatLng = start;
  const remaining = [...withCoords];
  while (remaining.length) {
    let bestIdx = 0;
    let bestD = Number.POSITIVE_INFINITY;
    remaining.forEach((p, i) => {
      const d = haversineM(cur, p);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    if (!next) break;
    const dist = Math.round(bestD);
    order.push({ id: next.id, distanceFromPrevM: dist });
    totalM += dist;
    cur = next;
  }
  for (const p of withoutCoords) order.push({ id: p.id, distanceFromPrevM: null });
  return { order, totalM };
}

/** 中日韓表意文字與日文假名(假名一起算,`丸の内` 這種混寫才不會被低估) */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;

/** 拉丁字母,含歐語的變音字母(ä ö ü ß é 等),不然德文地址會被少算一半 */
const LATIN_LETTER_RE = /[A-Za-z\u00c0-\u024f]/g;

/**
 * 這個地址是不是「以中日韓文字為主」。
 *
 * 判斷標準刻意不是「有沒有 CJK 字元」:一個字就算數的話,西文地址裡只要出現
 * 一個中文字就會被丟進去空白的那條路。實際遇到的是德國的中式餐廳客戶:
 *   `China-Restaurant 龍門, Hauptstraße 12, 10115 Berlin`
 * 兩個中文字讓整串地址的空白全被吃掉,變成
 *   `China-Restaurant龍門,Hauptstraße12,10115Berlin`
 * 送給地理編碼服務必然查不到,而畫面上只會顯示一句「查無此地址」,看不出原因。
 *
 * 改成比數量:CJK 字元不少於拉丁字母才算 CJK 為主。中文與日文地址裡的
 * 拉丁字母通常是零星的英文名,不會多過地址本體;西文地址裡的中文則相反。
 */
function isCjkDominant(s: string): boolean {
  const cjk = (s.match(CJK_CHAR_RE) ?? []).length;
  if (cjk === 0) return false;
  const latin = (s.match(LATIN_LETTER_RE) ?? []).length;
  return cjk >= latin;
}

/**
 * 地址正規化(送給地理編碼服務之前的清洗)。
 *
 * **適用範圍**:分成兩條路,依地址是不是**以中日韓文字為主**決定
 * (判斷方式與為什麼不是「有沒有 CJK 字元」,見 isCjkDominant)。
 *
 * 一、以 CJK 文字為主的地址(中文、日文地址):
 *     去掉所有空白(含全形)、全形數字轉半形、剝掉開頭的郵遞區號,
 *     再剝掉「台灣/臺灣(省)」這個國名前綴,最後截到第一個「號」為止
 *     (「號」之後是樓層與室別,Nominatim 對這些無感,留著反而查不到)。
 *     這一條裡的「台灣/臺灣」與「號」是**台灣地址專屬**的假設。
 *     日文地址不會被這兩條打到(沒有「號」也沒有「臺灣」),
 *     其餘的去空白與郵遞區號規則對它同樣成立。
 *     還沒處理的:中國大陸的「省/市」層級、香港的「樓/室」,那些會原樣送出去。
 *
 * 二、以拉丁字母為主的地址(英文、歐語,以及夾雜少量中文的西文地址,
 *     例如德國的中式餐廳「China-Restaurant 龍門, Hauptstraße 12, 10115 Berlin」):
 *     **只做保守處理** —— 空白收斂成單一半形空格並去頭尾,全形數字轉半形。
 *     不去空白、不剝開頭數字、不截尾。
 *     這條路是必要的:西文地址用空白斷詞,整串去空白會變成
 *     「1600AmphitheatreParkway」;而開頭的數字是門牌號不是郵遞區號,
 *     剝掉之後查到的會是另一個地方,或什麼都查不到。
 *     兩種壞法在畫面上都只顯示一句「查無此地址」,看不出原因。
 *
 * 空字串代表沒有可用地址。
 */
export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return '';
  // 全形數字轉半形對兩條路都成立(全形數字不是任何語系的正常門牌寫法)
  const halfWidthDigits = raw.replace(/[\uff10-\uff19]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
  );
  if (!isCjkDominant(halfWidthDigits)) {
    return halfWidthDigits.replace(/[\s\u3000]+/g, ' ').trim();
  }
  let s = halfWidthDigits.replace(/[\s\u3000]+/g, '');
  // 郵遞區號與「台灣」可能交錯出現(例:「台灣100台北市…」或「100 臺灣台北市…」),各剝兩輪
  for (let i = 0; i < 2; i += 1) {
    s = s.replace(/^\d{3,6}/, '');
    s = s.replace(/^(台灣|臺灣)(省)?/, '');
  }
  const idx = s.indexOf('號');
  if (idx >= 0) s = s.slice(0, idx + 1);
  return s;
}

/** 依優先序挑出客戶可用的地址(正規化後)。 */
export function pickAddress(c: {
  actualAddress?: string | null;
  registeredAddress?: string | null;
  contactAddress?: string | null;
}): string {
  for (const v of [c.actualAddress, c.registeredAddress, c.contactAddress]) {
    const n = normalizeAddress(v);
    if (n) return n;
  }
  return '';
}

/** 組織時區「今天」的結束時刻(UTC 時間點,含最後一毫秒)。 */
export function endOfToday(now: Date, tz?: string | null): Date {
  return orgDayRange(now, tz).endInclusive;
}

/**
 * 組織時區「今天」對應 dev_visit_plans.planned_date(@db.Date)的值。
 * Prisma 對 DATE 欄位取 UTC 的年月日,所以這裡回 UTC 00:00 的那一天。
 */
export function todayPlanDate(now: Date, tz?: string | null): Date {
  return dateKeyToUtcMidnight(orgToday(now, tz));
}

/** 反查快取 key:座標四捨五入到小數 4 位 */
function reverseKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/** 從 Nominatim address 物件挑出路名 / 區 / 縣市;欄位名依 OSM 慣例有多種,依序找第一個有值的。 */
function pickAddressPart(addr: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = addr[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 100);
  }
  return null;
}

/**
 * 地理編碼失敗的原因分類。
 * 只分類,不把外部服務的原始訊息往外送 —— 使用者需要知道「該找誰處理」,
 * 不需要看到別人家的錯誤內文。
 *   network  連不到外部地圖服務(對外連線被擋、逾時)→ 要找維運調整
 *   rejected 服務回了非 2xx(常見是未設定聯絡信箱而被擋)→ 要補環境變數
 *   notFound 服務正常回應但查不到這個地址 → 要修客戶的地址
 */
export type GeocodeFailureKind = 'network' | 'rejected' | 'notFound';

/** 一次地理編碼嘗試的結果:成功就有座標,失敗帶原因分類 */
interface GeocodeAttempt {
  hit: LatLng | null;
  reason: GeocodeFailureKind | null;
}

/**
 * 地圖上「還在跑」的客戶:排除終止階段。
 *
 * 哪些算終止一律問 dev_stages 的 is_terminal(StageCatalogService),不寫死代碼 ——
 * 寫死 ['dropped', 'converted'] 的話,管理員新增一個「已簽約」終止階段之後,
 * 那些客戶會被地圖當成進行中繼續畫上去,業務照著地圖跑一趟才發現不用去。
 * 讀不到目錄(單元測試直接 new、或遷移還沒跑完)就退回出廠的終止階段。
 */
const FALLBACK_TERMINAL_STAGES: readonly string[] = DEFAULT_DEV_STAGES.filter(
  (s) => s.isTerminal,
).map((s) => s.key);

@Injectable()
export class CrmGeoService {
  private readonly logger = new Logger(CrmGeoService.name);
  /** Nominatim 請求佇列:序列化 + 最小間隔。chain 永遠 resolve,不會因單次失敗卡住。 */
  private chain: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  /**
   * 地理編碼失敗的客戶 id → { 失敗時間(ms)、當時的地址 }。同一地址 24 小時內不再重試;
   * 地址變了(pickAddress 結果不同)或成功後就不受退避限制。單實例前提見檔頭。
   */
  private readonly failedAt = new Map<string, { at: number; address: string }>();
  /** 反查路名快取:key → { 結果、寫入時間 } */
  private readonly reverseCache = new Map<string, { at: number; value: ReverseResult }>();
  /** 背景補座標佇列(客戶 id,先進先出,不重複)與是否正在消化 */
  private readonly backgroundQueue: string[] = [];
  private backgroundDraining = false;

  /**
   * SettingsService 用 @Optional:單元測試直接 new CrmGeoService(prisma) 不必帶,
   * 沒有就退回環境變數與預設值(行為與改成可設定之前完全一樣)。
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly stageCatalog?: StageCatalogService,
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /** 組織設定的時區;沒注入 OrgTimeService(單元測試)就退回出廠時區 */
  private async timeZone(): Promise<string> {
    return this.orgTime ? this.orgTime.timeZone() : resolveTimeZone(null);
  }

  /** 反查地址時要跟對方要哪一種語言;讀組織設定的地區,沒有就出廠預設 */
  private async acceptLanguage(): Promise<string> {
    if (this.orgTime) return this.orgTime.locale();
    if (this.settings) {
      try {
        const s = await this.settings.get();
        return resolveLocale(s.locale ?? s.defaultLanguage);
      } catch {
        // 讀不到設定就用出廠預設,不要讓反查整個停掉
      }
    }
    return DEFAULT_LOCALE;
  }

  /** 目前的終止階段代碼;沒有目錄服務(單元測試)就用出廠預設 */
  private async terminalStageKeys(): Promise<string[]> {
    if (!this.stageCatalog) return [...FALLBACK_TERMINAL_STAGES];
    return this.stageCatalog.terminalKeys();
  }

  /**
   * 地圖服務設定:先看資料庫(系統設定),沒有再看環境變數,再沒有才用預設。
   *
   * 為什麼不是只讀 env:自架的人改設定要能在後台改完就生效,不必進機器改檔重啟。
   * 為什麼還留 env:容器化部署習慣把這種值放環境變數,拿掉會讓既有部署突然改用 placeholder,
   * 而 Nominatim 對 placeholder 的 User-Agent 是會擋的 —— 那會變成「地圖突然查不到地址」。
   * 讀設定失敗不能讓地理編碼整個停擺,所以包 try/catch 退回 env。
   */
  /**
   * 地理編碼服務開著沒有(系統設定的 geocodeProvider)。
   *
   * 'none' 的意思是「不啟用,座標全部人工填」。這一格以前設得下去卻沒有任何讀取端 ——
   * 設成不啟用之後,背景補座標、「補齊地址座標」按鈕與反查路名照樣打外部服務。
   * 對「不想把客戶地址送出去」的部署來說,那正好是它想擋掉的那件事。
   *
   * 讀不到設定時回 true(照舊做):地理編碼失敗只是少了座標,
   * 而讀一次設定失敗就把地圖功能整組關掉,症狀更難查。
   */
  private async geocodingEnabled(): Promise<boolean> {
    if (!this.settings) return true;
    try {
      const s = await this.settings.get();
      return s.geocodeProvider !== 'none';
    } catch {
      return true;
    }
  }

  private async geocoderConfig(): Promise<{
    base: string;
    agent: string;
    email: string;
    language: string;
    countryCodes: string;
  }> {
    // 直接讀 process.env 是 common/env.ts 檔頭寫明的兩個例外之一:
    // 這一支的單元測試直接 new CrmGeoService(prisma),走 getEnv() 會逼整組測試
    // 先湊齊 DATABASE_URL / JWT_ACCESS_SECRET。變數本身仍然列在 envSchema 裡驗格式。
    let email = (process.env.NOMINATIM_EMAIL ?? '').trim();
    let base = '';
    let agent = '';
    let countryCodes = '';
    if (this.settings) {
      try {
        const s = await this.settings.get();
        email = (s.nominatimEmail ?? '').trim() || email;
        base = (s.geocoderBaseUrl ?? '').trim();
        agent = (s.geocoderUserAgent ?? '').trim();
        // 讀出來再洗一次:這一格會直接變成對外請求的查詢參數,
        // 而資料庫那一列是有可能被手改的(見 normalizeGeocodeCountryCodes)
        countryCodes = normalizeGeocodeCountryCodes(s.geocodeCountryCodes);
      } catch {
        // 讀不到設定就用環境變數,不要讓地圖整個停掉
      }
    }
    if (!email) {
      this.logger.warn(
        '[geocode] 沒有設定地圖服務聯絡信箱(系統設定的 nominatimEmail 或環境變數 NOMINATIM_EMAIL),將使用 placeholder',
      );
      email = PLACEHOLDER_CONTACT;
    }
    return {
      base: (base || DEFAULT_GEOCODER_BASE).replace(/\/+$/, ''),
      agent: agent || DEFAULT_GEOCODER_AGENT,
      email,
      // 空字串 = 不限制國家。這裡沒有出廠的國碼可退回 —— 產品不預設任何一國
      countryCodes,
      // 送出去的語言偏好照組織設定的地區走,不寫死 zh-TW ——
      // 寫死的話,設在別的地區的組織拿回來的路名還是中文的。
      language: await this.acceptLanguage(),
    };
  }

  private async visibleWhere(view: ViewScope) {
    return {
      stage: { notIn: await this.terminalStageKeys() },
      // 已刪除的客戶不上地圖,也不進待編碼佇列(對著一筆刪掉的資料一直呼叫地理編碼服務沒有意義)
      ...notDeletedWhere(),
      ...ownerFilter(view),
    };
  }

  /**
   * 「還沒有座標、而且至少有一個地址欄位」的 where 片段。
   * 三個地址全空的客戶永遠編碼不出來,不下推這個條件的話它們會一直被算進 remaining,
   * 前端的待編碼數字就永遠不歸零。
   */
  private async pendingGeocodeWhere(view: ViewScope) {
    return {
      ...(await this.visibleWhere(view)),
      lat: null,
      OR: [
        { actualAddress: { not: null } },
        { registeredAddress: { not: null } },
        { contactAddress: { not: null } },
      ],
    };
  }

  /** 是否待編碼:有地址、lat 為 null、且最近 24 小時內沒有失敗紀錄(記憶體 Map)。 */
  private isPendingGeocode(
    c: {
      id: string;
      lat: number | null;
      actualAddress: string | null;
      registeredAddress: string | null;
      contactAddress: string | null;
    },
    now: number,
  ): boolean {
    if (c.lat !== null) return false;
    const address = pickAddress(c);
    if (!address) return false;
    const failed = this.failedAt.get(c.id);
    if (failed !== undefined) {
      if (failed.address === address && now - failed.at < GEOCODE_RETRY_AFTER_MS) return false;
      this.failedAt.delete(c.id);
    }
    return true;
  }

  /**
   * 「還沒有座標、而且正在退避中」有幾筆。
   *
   * 退避是記憶體裡的 Map(failedAt),不在資料庫裡,所以這個數字沒辦法只靠 SQL 算。
   * 但也不需要把全部待編碼的客戶撈回來比對:退避中的一定在那個 Map 的鍵裡面,
   * 所以只問這一小撮人「你們現在還算不算待編碼」就夠了。
   * Map 沒東西時連查都不用查。
   */
  private async countRetryingLater(
    pendingWhere: Record<string, unknown>,
    nowMs: number,
  ): Promise<number> {
    const ids = [...this.failedAt.keys()];
    if (ids.length === 0) return 0;
    const rows = await this.prisma.devCustomer.findMany({
      where: { ...pendingWhere, id: { in: ids } },
      select: {
        id: true,
        lat: true,
        actualAddress: true,
        registeredAddress: true,
        contactAddress: true,
      },
      take: ids.length,
    });
    return rows.filter((c) => !this.isPendingGeocode(c, nowMs)).length;
  }

  async customers(
    userId: string,
    view: ViewScope,
    opts: { lat?: number; lng?: number; scope?: 'today' | 'all' },
  ) {
    const now = new Date();
    const tz = await this.timeZone();
    // 今天(組織時區)已排進拜訪計畫、還沒完成的客戶 id;不管 scope 都查,每列要帶 plannedToday
    // 只查可見範圍內的排程(業務看自己的客戶),而且以客戶目前的 ownerId 為準;
    // 沒有 owner 條件的話,全公司今天的排程都會被撈回來(量大又外洩別人的客戶 id)
    // 這裡是全 repo 第三處(也是最後一處)用裸 relatedOwnerFilter 的地方。
    // 結果目前不會外洩:plannedIds 只拿去跟下面那句 findMany 的 where 取交集,
    // 而那句吃 visibleWhere(),裡面有 notDeletedWhere()。但那是一個要往下讀十幾行
    // 才推得出來的保證,而且它成立與否取決於呼叫端 —— 換一個用法就不成立了。
    // 條件直接寫在這一支自己身上,不必再靠別人:排程掛在已刪除客戶身上是常態
    // (客戶刪了排程還留著),多撈回來的那些只是白花往返。
    const plans = await this.prisma.devVisitPlan.findMany({
      where: {
        plannedDate: todayPlanDate(now, tz),
        status: 'planned',
        ...relatedLiveCustomerWhere(view),
      },
      select: { customerId: true },
      take: TODAY_PLAN_TAKE,
    });
    const plannedIds = new Set(plans.map((p) => p.customerId));
    const where: Record<string, unknown> = await this.visibleWhere(view);
    if (opts.scope === 'today') {
      // 今天要跟進的 + 逾期還沒跟進的,或今天排了拜訪計畫的
      where.OR = [
        { nextFollowUpAt: { not: null, lte: endOfToday(now, tz) } },
        { id: { in: [...plannedIds] } },
      ];
    }
    const rows = await this.prisma.devCustomer.findMany({
      where,
      take: LIST_TAKE,
      // orderBy 不是裝飾。這一句有 take,而客戶數量早就超過那個上限 ——
      // 沒有排序的話「是哪 2000 筆」由資料庫當下的掃描順序決定,同一個人重整兩次
      // 會看到不同的點,而畫面上沒有任何地方看得出來為什麼。同一個 repo 的
      // crm-deletion.service.ts(整批還原那一支)註解自己就講過這個道理。
      //
      // 排序鍵選「下次跟進日由近到遠」:被截掉的那些應該是最不急的,不是隨機的。
      // NULL(沒排跟進日)照 PostgreSQL 的預設排在最後,正好也是該被截掉的那些。
      // 第二鍵用 id:第一鍵有大量重複值(整批都是 null),少了它排序仍然不唯一。
      orderBy: [{ nextFollowUpAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        companyName: true,
        taxId: true,
        stage: true,
        actualAddress: true,
        registeredAddress: true,
        contactAddress: true,
        lat: true,
        lng: true,
        nextFollowUpAt: true,
        contactPhone: true,
        contactName: true,
        owner: { select: { id: true, name: true } },
      },
    });

    const origin: LatLng | null =
      typeof opts.lat === 'number' && typeof opts.lng === 'number'
        ? { lat: opts.lat, lng: opts.lng }
        : null;

    const list = rows.map((r) => {
      const hasCoords = r.lat !== null && r.lng !== null;
      const distanceM =
        origin && hasCoords
          ? Math.round(haversineM(origin, { lat: r.lat as number, lng: r.lng as number }))
          : null;
      return {
        id: r.id,
        companyName: r.companyName,
        taxId: r.taxId,
        stage: r.stage,
        address: r.actualAddress ?? r.registeredAddress ?? r.contactAddress ?? null,
        lat: r.lat,
        lng: r.lng,
        distanceM,
        nextFollowUpAt: r.nextFollowUpAt,
        plannedToday: plannedIds.has(r.id),
        contactPhone: r.contactPhone,
        contactName: r.contactName,
        owner: r.owner ? { id: r.owner.id, name: r.owner.name } : null,
      };
    });

    if (origin) {
      // 有距離的由近到遠;沒座標的排最後
      list.sort((a, b) => {
        if (a.distanceM === null && b.distanceM === null) return 0;
        if (a.distanceM === null) return 1;
        if (b.distanceM === null) return -1;
        return a.distanceM - b.distanceM;
      });
    } else {
      list.sort((a, b) => {
        const ta = a.nextFollowUpAt ? a.nextFollowUpAt.getTime() : Number.POSITIVE_INFINITY;
        const tb = b.nextFollowUpAt ? b.nextFollowUpAt.getTime() : Number.POSITIVE_INFINITY;
        return ta - tb;
      });
    }

    // pendingGeocode 以「全部可見客戶」計,不受 scope 影響,而且在資料庫裡算。
    //
    // 原本這裡是:scope=today 時再撈一次 take 2000 的完整列(含三個地址欄位)只為了
    // 數兩個數字,scope=all 時拿上面那批 rows 來數。兩種算法都不對 ——
    // 前者是白花一次往返把兩千列地址載進記憶體再丟掉,後者更麻煩:rows 自己就有
    // 2000 筆的上限,五萬筆的部署永遠只數得到前 2000 筆裡的待編碼數,
    // 而畫面拿這個數字去算「還要按幾次補齊座標」。
    //
    // 改成 count():跟 geocodePending 的 remaining 走同一個 where(pendingGeocodeWhere,
    // 同檔 :695 也是這樣做的),兩個數字從此對得起來,而且不受任何清單上限影響。
    const pendingWhere = await this.pendingGeocodeWhere(view);
    const pendingGeocode = await this.prisma.devCustomer.count({ where: pendingWhere });
    const retryingLater = await this.countRetryingLater(pendingWhere, now.getTime());

    // batchMax 一起回:畫面要靠它算出「還要按幾次」,不能在前端寫死一個 10
    return { rows: list, pendingGeocode, retryingLater, batchMax: GEOCODE_BATCH_MAX };
  }

  /** 對可見且待編碼的客戶做地理編碼,一次最多 10 筆。 */
  /**
   * 補齊座標。
   *
   * force=true 會清掉這一批的失敗退避、立刻重試。
   * 為什麼需要:退避是為了不要一直打外部服務,但如果外部服務暫時不通(或部署環境的
   * 對外連線被擋),所有客戶都會落進退避,使用者按按鈕會得到「沒事可做」——
   * 失敗被藏起來,看起來像功能沒做。給一個明確的重試出口,問題才看得見也解得掉。
   */
  async geocodePending(
    userId: string,
    view: ViewScope,
    force = false,
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    remaining: number;
    retryingLater: number;
    failureKinds: GeocodeFailureKind[];
    batchMax: number;
  }> {
    const now = Date.now();
    // 「沒座標 + 至少有一個地址」下推到 SQL:候選與 remaining 用同一個條件,兩個數字才對得起來
    const pendingWhere = await this.pendingGeocodeWhere(view);
    // 設定成不啟用時什麼都不打:remaining 仍照實回答還有幾筆沒座標,
    // processed / succeeded / failed 都是 0,前端就不會把它顯示成一次失敗的嘗試
    if (!(await this.geocodingEnabled())) {
      return {
        processed: 0,
        succeeded: 0,
        failed: 0,
        remaining: await this.prisma.devCustomer.count({ where: pendingWhere }),
        retryingLater: 0,
        failureKinds: [],
        batchMax: GEOCODE_BATCH_MAX,
      };
    }
    // 這一輪只會處理 GEOCODE_BATCH_MAX 筆,候選撈幾倍就夠(退避中的會被 isPendingGeocode 濾掉);
    // 撈全部只是為了算 remaining,那個改用 count() 在 DB 算,不用把整批客戶載進來
    const candidates = await this.prisma.devCustomer.findMany({
      where: pendingWhere,
      select: {
        id: true,
        lat: true,
        actualAddress: true,
        registeredAddress: true,
        contactAddress: true,
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: GEOCODE_BATCH_MAX * 5,
    });
    if (force) {
      // 使用者明確要求重試:先清掉這一批的退避紀錄,讓它們重新成為候選
      for (const c of candidates) this.failedAt.delete(c.id);
    }
    const pending = candidates.filter((c) => this.isPendingGeocode(c, now));
    const batch = pending.slice(0, GEOCODE_BATCH_MAX);

    let succeeded = 0;
    let failed = 0;
    // 這一輪出現過哪些失敗原因。多筆同因只回一次,前端用它給出「該找誰處理」的提示。
    const failureKinds = new Set<GeocodeFailureKind>();
    for (const c of batch) {
      const addr = pickAddress(c);
      const attempt = await this.geocodeAddress(addr, c.id);
      if (!attempt.hit) {
        // 失敗不寫 DB(geocodedAt 只記成功),用記憶體 Map 做 24 小時退避
        this.failedAt.set(c.id, { at: Date.now(), address: addr });
        failed += 1;
        if (attempt.reason) failureKinds.add(attempt.reason);
        continue;
      }
      const hit = attempt.hit;
      // 只在 lat 仍為 null 時寫入,不覆蓋別處已寫好的座標
      await this.prisma.devCustomer.updateMany({
        where: { id: c.id, lat: null },
        data: { lat: hit.lat, lng: hit.lng, geocodedAt: new Date() },
      });
      this.failedAt.delete(c.id);
      succeeded += 1;
    }
    // remaining 在迴圈跑完之後用 count() 算:成功的幾筆此時已經寫進 lat,自然不會被算到。
    //
    // ★ 這裡刻意不扣掉退避中的筆數。之前扣了,結果外部服務一失敗,所有客戶落進 24 小時退避,
    //   remaining 變 0,畫面說「沒事可做」,失敗被完全藏起來 —— 使用者只看到地址一直沒有座標。
    //   remaining 要誠實回答「還有幾筆沒有座標」,退避另外用 retryingLater 講清楚。
    const remaining = await this.prisma.devCustomer.count({ where: pendingWhere });
    const retryingLater = candidates.filter(
      (c) => c.lat === null && this.failedAt.has(c.id) && !this.isPendingGeocode(c, Date.now()),
    ).length;
    return {
      processed: batch.length,
      succeeded,
      failed,
      remaining,
      retryingLater,
      failureKinds: [...failureKinds],
      batchMax: GEOCODE_BATCH_MAX,
    };
  }

  /** 最近鄰拜訪順序。只計算呼叫者可見的客戶;不在可見範圍的 id 直接略過。 */
  async route(userId: string, view: ViewScope, start: LatLng, ids: string[]) {
    const uniq = [...new Set(ids)];
    const rows = await this.prisma.devCustomer.findMany({
      where: { ...(await this.visibleWhere(view)), id: { in: uniq } },
      select: { id: true, lat: true, lng: true },
    });
    return nearestNeighborOrder(start, rows);
  }

  /**
   * 背景補座標:把客戶排進記憶體佇列,setImmediate 後逐筆處理;呼叫端不用 await,任何失敗都不會往外丟。
   * 每筆都重新讀 DB 確認 lat 仍為 null 且地址可用,所以重複排程、期間被別處補好座標都沒關係。
   */
  scheduleGeocode(customerId: string): void {
    if (!customerId) return;
    if (this.backgroundQueue.includes(customerId)) return;
    if (this.backgroundQueue.length >= BACKGROUND_QUEUE_MAX) {
      this.backgroundQueue.shift();
      this.logger.warn('[geocode] 背景補座標佇列已滿,丟掉最舊的一筆');
    }
    this.backgroundQueue.push(customerId);
    if (this.backgroundDraining) return;
    this.backgroundDraining = true;
    setImmediate(() => {
      void this.drainBackgroundQueue();
    });
  }

  private async drainBackgroundQueue(): Promise<void> {
    try {
      while (this.backgroundQueue.length > 0) {
        const id = this.backgroundQueue.shift();
        if (!id) continue;
        try {
          await this.geocodeOne(id);
        } catch (err) {
          const name = err instanceof Error ? err.name : 'UnknownError';
          this.logger.warn(`[geocode] 背景補座標客戶 ${id} 失敗(${name})`);
        }
      }
    } finally {
      this.backgroundDraining = false;
      // 消化期間又有新項目進來(理論上 while 會吃掉,保險再檢查一次)
      if (this.backgroundQueue.length > 0) {
        this.backgroundDraining = true;
        setImmediate(() => {
          void this.drainBackgroundQueue();
        });
      }
    }
  }

  /**
   * 對單一客戶做一次地理編碼(背景佇列用)。
   * lat 已有值、沒地址、已合併、已刪除、或在退避期內都直接略過。
   *
   * 已刪除的一定要在這裡再問一次,不能只靠進佇列時的條件:排進背景佇列與真的輪到它
   * 之間隔著整個佇列,那段時間裡客戶可能已經被刪進回收桶。漏掉的話,系統會為一筆
   * 使用者已經刪掉的客戶對外呼叫一次地理編碼服務(把它的地址送出去),再把座標寫回
   * 一筆已刪除的列 —— 兩件事都違反同一檔 customers() 那段註解自己寫的原則。
   */
  private async geocodeOne(customerId: string): Promise<void> {
    if (!(await this.geocodingEnabled())) return;
    const c = await this.prisma.devCustomer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        lat: true,
        actualAddress: true,
        registeredAddress: true,
        contactAddress: true,
        mergedIntoId: true,
        deletedAt: true,
      },
    });
    if (!c || c.mergedIntoId || c.deletedAt) return;
    if (!this.isPendingGeocode(c, Date.now())) return;
    const addr = pickAddress(c);
    const { hit } = await this.geocodeAddress(addr, c.id);
    if (!hit) {
      this.failedAt.set(c.id, { at: Date.now(), address: addr });
      return;
    }
    // 寫回也帶 deletedAt: null:讀到現在之間隔著一次對外請求(還有速率限制的等待),
    // 那段時間足夠讓使用者按下刪除
    await this.prisma.devCustomer.updateMany({
      where: { id: c.id, lat: null, deletedAt: null },
      data: { lat: hit.lat, lng: hit.lng, geocodedAt: new Date() },
    });
    this.failedAt.delete(c.id);
  }

  /**
   * 反查路名。走同一條 Nominatim 佇列(每秒一次),結果快取 10 分鐘。
   * 查不到或失敗時四個欄位都是 null,不丟例外、不回外部錯誤字串。
   */
  async reverseGeocode(lat: number, lng: number): Promise<ReverseResult> {
    const empty: ReverseResult = { road: null, district: null, city: null, display: null };
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return empty;
    // 反查路名同樣走外部服務,設定成不啟用就不打
    if (!(await this.geocodingEnabled())) return empty;
    const key = reverseKey(lat, lng);
    const now = Date.now();
    const cached = this.reverseCache.get(key);
    if (cached && now - cached.at < REVERSE_CACHE_TTL_MS) return cached.value;

    const run = async (): Promise<ReverseResult> => {
      const wait = this.lastRequestAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      try {
        return (await this.fetchReverse(lat, lng)) ?? empty;
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        this.logger.warn(`[reverse] 反查路名失敗(${name})`);
        return empty;
      } finally {
        this.lastRequestAt = Date.now();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    const value = await result;
    // 查到才進快取;失敗的不快取,讓下一次還有機會
    if (value.display) {
      if (this.reverseCache.size >= REVERSE_CACHE_MAX) {
        for (const [k, v] of this.reverseCache) {
          if (now - v.at >= REVERSE_CACHE_TTL_MS) this.reverseCache.delete(k);
        }
        if (this.reverseCache.size >= REVERSE_CACHE_MAX) {
          const oldest = this.reverseCache.keys().next().value;
          if (oldest !== undefined) this.reverseCache.delete(oldest);
        }
      }
      this.reverseCache.set(key, { at: now, value });
    }
    return value;
  }

  private async fetchReverse(lat: number, lng: number): Promise<ReverseResult | null> {
    const { base, agent, email, language } = await this.geocoderConfig();
    const url = new URL(`${base}/reverse`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('zoom', '17');
    url.searchParams.set('addressdetails', '1');
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': `${agent}/1.0 (${email})`,
        'Accept-Language': language,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) {
      this.logger.warn(`[reverse] Nominatim 回應 status=${res.status}`);
      return null;
    }
    const lenHeader = res.headers.get('content-length');
    const len = lenHeader === null ? null : Number.parseInt(lenHeader, 10);
    if (len !== null && (!Number.isFinite(len) || len > NOMINATIM_MAX_RESPONSE_BYTES)) {
      this.logger.warn('[reverse] Nominatim 回應過大,略過');
      return null;
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const obj = body as { address?: unknown; display_name?: unknown; error?: unknown };
    if (obj.error !== undefined) return null;
    const addr =
      obj.address && typeof obj.address === 'object'
        ? (obj.address as Record<string, unknown>)
        : {};
    const road = pickAddressPart(addr, [
      'road',
      'pedestrian',
      'footway',
      'residential',
      'path',
      'neighbourhood',
    ]);
    const city = pickAddressPart(addr, ['city', 'county', 'state']);
    const districtRaw = pickAddressPart(addr, [
      'suburb',
      'city_district',
      'district',
      'town',
      'village',
    ]);
    const district = districtRaw === city ? null : districtRaw;
    const parts = [city, district, road].filter((x): x is string => x !== null);
    const display = parts.length
      ? parts.join('')
      : typeof obj.display_name === 'string' && obj.display_name.trim()
        ? obj.display_name.trim().slice(0, 120)
        : null;
    if (!display) return null;
    return { road, district, city, display };
  }

  /**
   * 呼叫 Nominatim。透過佇列序列化並保證兩次請求間隔 ≥ 1100ms。
   * 任何失敗(逾時、非 2xx、格式不對、查無結果)都回 null,只記 warn,不把外部錯誤字串往外傳。
   */
  private geocodeAddress(address: string, customerId: string): Promise<GeocodeAttempt> {
    const run = async (): Promise<GeocodeAttempt> => {
      const wait = this.lastRequestAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      try {
        return await this.fetchNominatim(address);
      } catch (err) {
        // 只記錄錯誤類型,不記地址、不記回應內文
        const name = err instanceof Error ? err.name : 'UnknownError';
        this.logger.warn(`[geocode] 客戶 ${customerId} 地理編碼失敗(${name})`);
        return { hit: null, reason: 'network' };
      } finally {
        this.lastRequestAt = Date.now();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async fetchNominatim(address: string): Promise<GeocodeAttempt> {
    const { base, agent, email, language, countryCodes } = await this.geocoderConfig();
    const url = new URL(`${base}/search`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    // 沒設定就整個不帶 countrycodes,也就是全世界都查。
    // 這裡以前寫死 'tw',結果是裝在台灣以外的組織一筆地址都編碼不出來,
    // 而畫面上只會顯示「查無此地址」,看不出真正的原因。
    if (countryCodes) url.searchParams.set('countrycodes', countryCodes);
    url.searchParams.set('q', address);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': `${agent}/1.0 (${email})`,
        'Accept-Language': language,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      // 不跟隨轉址:避免被導去別的主機把 User-Agent / 查詢字串送出去
      redirect: 'error',
    });
    if (!res.ok) {
      this.logger.warn(`[geocode] Nominatim 回應 status=${res.status}`);
      return { hit: null, reason: 'rejected' };
    }
    // 讀 body 之前先看 Content-Length,超過上限視為失敗(沒有 Content-Length 就照讀,逾時仍由 signal 控制)
    const lenHeader = res.headers.get('content-length');
    const len = lenHeader === null ? null : Number.parseInt(lenHeader, 10);
    if (len !== null && (!Number.isFinite(len) || len > NOMINATIM_MAX_RESPONSE_BYTES)) {
      this.logger.warn('[geocode] Nominatim 回應過大,略過');
      return { hit: null, reason: 'rejected' };
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body) || body.length === 0) return { hit: null, reason: 'notFound' };
    const first = body[0] as { lat?: unknown; lon?: unknown };
    const lat = Number(first?.lat);
    const lng = Number(first?.lon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return { hit: null, reason: 'notFound' };
    }
    return { hit: { lat, lng }, reason: null };
  }
}
