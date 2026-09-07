// ref:3687 mc/陳彥輔/米球®
'use client';

// 全站設定的單一供應點。
//
// 為什麼要有這一支:這套系統要能被任何一間公司拿去裝,所以「客戶階段有哪些」
// 「照片存證要拍什麼」「功能區用什麼色」「產品叫什麼名字」都不可以寫死在畫面裡,
// 一律由後台決定、由這裡供應給整個前端。
//
// 兩層來源:
//   1. GET /api/public/settings — 免登入,任何頁面都拿得到的展示用設定(白名單)。
//   2. GET /api/admin/app-settings — 後台設定頁編輯用的完整設定(需要 admin)。
// 這一支只負責第 1 層。後台頁面自己打第 2 層,存檔後呼叫 refresh() 讓全站跟著更新。
//
// 拿不到設定時用 DEFAULT_APP_SETTINGS,理由是「畫面要能用」比「畫面完全正確」重要:
// 設定 API 掛掉時業務仍然要能看客戶卡。但預設值只是保底,不是第二份設定來源,
// 任何人要改階段清單都只能去後台改,不准在畫面檔案裡再寫一份。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_DEV_STAGES,
  DEFAULT_INTERACTION_CHANNELS,
  DEFAULT_CATEGORIES,
  DEFAULT_PREMISES_TYPES,
  DEFAULT_VISIT_PHOTO_KINDS,
  LOOKUP_DEFAULT_LABEL,
  LOOKUP_TARGET_FIELDS,
  LOST_STAGE_KEY,
  RESERVED_STAGE_KEYS,
  STAGE_COLOR_NAMES,
  VISIT_CHANNEL_KEY,
  WON_STAGE_KEY,
  ZONE_NAMES,
  type LookupTargetField,
  type StageColorName,
  type ZoneName,
} from '@mitchcrm/shared/vocab';
// 時區與地區的出廠預設同樣共用 shared 那一份:後端 settings.service 與前端保底值
// 各寫一個字串的話,兩邊走散時畫面上看不出來
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE, formatOrgDateTime } from '@mitchcrm/shared/time';
import { getApiBase } from './env';

/** 客戶階段一格的定義。key 進資料庫,label 給人看,color 是 globals.css 的 --st-* 色組名 */
export interface StageDef {
  key: string;
  label: string;
  /** 狀態色組名(見 globals.css --st-<color>-bg / -fg / -bar) */
  color: StageColorName;
  /** 要不要出現在看板欄位 */
  board: boolean;
  /** 要不要出現在新增/編輯表單的下拉 */
  form: boolean;
  /**
   * 終止階段(成交或放棄):不再算「進行中」。
   * 對應後端 dev_stages.is_terminal。待辦、KPI 的「開發中」都以這個旗標為準,
   * 不是靠一份寫死的階段代碼清單 —— 後台新增一個階段時,寫死的清單不會跟著長。
   */
  terminal: boolean;
}

/**
 * 保留代碼。這兩個代碼在後端是有語意的:標記成交寫的是 converted,
 * 查重合併把被併掉的那筆標成 dropped(見後端 crm.service 與 stage-catalog.service)。
 * 前端只在「成交轉換率」這一種數字上引用它們,其餘一律走設定裡的階段清單。
 *
 * 定義在 @mitchcrm/shared,前後端共用同一份;這裡只是 re-export,不要另外寫一份。
 */
export { LOST_STAGE_KEY, RESERVED_STAGE_KEYS, WON_STAGE_KEY };

/** 進行中的階段代碼(沒有標記為終止的那些)。給待辦與 KPI 用 */
export function inProgressStageKeys(stages: readonly StageDef[]): Set<string> {
  return new Set(stages.filter((s) => !s.terminal).map((s) => s.key));
}

/** 「快到手」的階段數:清單最後面的幾個進行中階段 */
export const HOT_STAGE_COUNT = 2;

/**
 * 快到手的階段代碼。
 *
 * 定義是「進行中階段裡排最後面的那幾個」,不是寫死的兩個代碼:
 * 階段清單的順序就是流程順序,排越後面越接近成交,久沒聯絡的代價越大。
 * 後台把流程改成五段或十段,這個判斷都跟著走。
 */
export function hotStageKeys(stages: readonly StageDef[]): Set<string> {
  const inProgress = stages.filter((s) => !s.terminal).map((s) => s.key);
  return new Set(inProgress.slice(-HOT_STAGE_COUNT));
}

/** 色組名同樣共用 @mitchcrm/shared 那一份(後端 app-settings.view 也認同一組) */
export { STAGE_COLOR_NAMES };
export type { StageColorName };

export const STAGE_COLOR_LABEL: Record<StageColorName, string> = {
  purple: '紫',
  info: '藍',
  teal: '青',
  amber: '琥珀',
  pink: '桃紅',
  green: '綠',
  neutral: '灰',
  danger: '紅',
};

/**
 * 互動管道與場所類型的一項。代碼進資料庫,名稱給人看,排序就是陣列順序。
 *
 * 這兩份清單原本寫死在客戶卡與新增客戶頁裡(一份 ChannelKey 型別加一張中文對照表、
 * 一份 PremisesType 加另一張)。後果是設備維修公司想把管道換成「工單、現場、電話」
 * 怎麼點都改不了,而照片存證檢查表按場所類型分組,連「加一種新的現場」都做不到。
 * 兩份現在都是後台可增減的主檔(dev_interaction_channels / dev_premises_types),
 * 跟其餘設定走同一個 /api/public/settings,所以就住在同一份 AppSettings 裡。
 */
export interface VocabItem {
  key: string;
  label: string;
}

/** 代碼的合法字元。與後端 SETTINGS_KEY_PATTERN、下面的 STAGE_KEY_PATTERN 同一條規則 */
export const VOCAB_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;

/**
 * 到訪打卡那個管道的代碼。定義在 @mitchcrm/shared,前後端共用同一份,
 * 這裡只是 re-export,不要另外寫一份。
 */
export { VISIT_CHANNEL_KEY };

/** 照片存證檢查表的一項 */
export interface PhotoCheckItem {
  key: string;
  label: string;
  /** 必拍(缺了會在客戶卡上顯示缺件提示) */
  required: boolean;
  /** 只在特定場所類型要求;空陣列 = 所有場所都要 */
  placeTypes: string[];
}

/** 功能區。key 對應 admin/layout.tsx 放在外框上的 data-area */
export type AreaKey = 'crm' | 'field' | 'team' | 'system';

/**
 * 功能區識別色只能從這五組「已驗過對比」的色盤挑,不開放自由填色值。
 *
 * 理由:每一組在 globals.css 都備齊了 accent / tint / tint-fg,而且淺色、深色、
 * 配色方案 A、B 四種組合各自量過(白字對 accent >= 7:1、tint-fg 對 tint >= 7:1)。
 * 讓人自由填一個色碼,只要填得亮一點,整個功能區的字就會掉出 AAA,
 * 而使用者在設定頁上看不出來。能挑的只有這五組,是刻意的限制。
 *
 * 定義在 @mitchcrm/shared,前後端共用同一份(後端 app-settings.view 也認同一組);
 * 這裡只是 re-export,不要另外寫一份 —— 兩邊走散時的症狀是後端把畫面選的色
 * 當成不認得的值退回預設,而設定頁上完全看不出來。
 */
export { ZONE_NAMES };
export type { ZoneName };

export const ZONE_LABEL: Record<ZoneName, string> = {
  dev: '藍綠',
  app: '藍',
  rev: '紫',
  dash: '靛藍',
  sys: '灰藍',
};

export const AREA_LABEL: Record<AreaKey, string> = {
  crm: '客戶管理',
  field: '外勤拜訪',
  team: '團隊管理',
  system: '系統設定',
};

/**
 * 外部查詢識別碼的預設名稱,以及欄位對應表認得的三個目標欄位。
 *
 * 兩者都定義在 @mitchcrm/shared,前後端共用同一份;這裡只是 re-export。
 * 之前是前端一份、後端 app-settings.view.ts 一份,而且註解就寫著「兩邊都要改」——
 * 靠註解維持的一致性遲早會斷,斷掉時畫面上不會有任何徵兆。
 */
export { LOOKUP_DEFAULT_LABEL, LOOKUP_TARGET_FIELDS };
export type { LookupTargetField };

export interface AppSettings {
  /** 產品名(瀏覽器標題、頁尾、PWA 名稱)。預設 Mitch CRM */
  productName: string;
  /** 站頭商標文字。留空 = 用 productName */
  logoText: string;
  /** 使用這套系統的組織全名(頁尾版權列) */
  organizationName: string;
  /** 組織對外顯示名(較短,站頭副標) */
  organizationDisplayName: string;
  /** 對外聯絡電話 */
  phone: string;
  /** 郵寄收件地址 */
  mailingAddress: string;
  /** 時區(IANA) */
  timezone: string;
  /** 地區/語系 */
  locale: string;
  /** 配色方案 */
  themeScheme: 'A' | 'B';
  /** 側欄底色 */
  themeSidebar: 'dark' | 'light';
  /** 預設日夜模式。system = 跟隨作業系統 */
  themeDefaultMode: 'light' | 'dark' | 'system';
  /** 客戶階段清單(順序就是看板由左到右) */
  stages: StageDef[];
  /** 照片存證檢查表 */
  photoChecklist: PhotoCheckItem[];
  /** 互動管道清單(順序就是下拉的順序) */
  channels: VocabItem[];
  /** 場所類型清單(照片存證檢查表按它分組) */
  premisesTypes: VocabItem[];
  /**
   * 明確設定為「不需照片存證」的場所類型代碼。
   *
   * 這一份的存在是為了分辨「這個場所不用拍」與「這個場所還沒設定必拍項目」——
   * 兩者在檢查表裡看起來都是一份空的必拍清單。在這裡面 = 成交守衛放行。
   */
  photoExemptPremises: string[];
  /** 商業分類清單(客戶卡與新增客戶頁的「分類」下拉) */
  categories: VocabItem[];
  /** 功能區識別色(從 ZONE_NAMES 挑一組) */
  areaColors: Record<AreaKey, ZoneName>;
  /** 地圖預設中心與縮放 */
  mapDefaultLat: number;
  mapDefaultLng: number;
  mapDefaultZoom: number;
  /**
   * 拜訪地圖圖磚網址樣板({z}/{x}/{y})。圖磚由瀏覽器直接請求,會把 IP 與
   * 檢視座標範圍送給該服務,所以做成可設定(比照地理編碼),預設是公共 OSM 圖磚。
   */
  mapTileUrl: string;
  /** 地理編碼服務 */
  geocodeProvider: 'nominatim' | 'none';
  /**
   * 地理編碼要不要限制國家:逗號分隔的兩碼國碼(例:tw 或 jp,kr),空字串 = 不限制。
   * 只有 /admin/settings 拿得到(公開設定端點不給這一格,前端不做地理編碼)。
   */
  geocodeCountryCodes: string;
  /**
   * 外部查詢帶入。整組由後台決定,前端不知道那個識別碼在當地叫什麼。
   *
   * lookupUrlTemplate 與 lookupFieldMap 只有 /admin/settings 那一頁拿得到
   * (它打的是需要 admin 的 /api/admin/app-settings);免登入的公開設定只給
   * enabled / label / pattern 三個,因為網址樣板可能帶著金鑰或內部服務位址。
   * 所以其餘頁面看到的這兩格永遠是空的,不要在別的地方讀它們。
   */
  lookupEnabled: boolean;
  /** 這個識別碼在當地叫什麼(標籤、提示、錯誤訊息共用這一個字) */
  lookupLabel: string;
  /** 查詢網址樣板,{q} 是查詢字串的位置。只有後台設定頁讀得到 */
  lookupUrlTemplate: string;
  /** 上游回應欄位對應到 name / address / phone。只有後台設定頁讀得到 */
  lookupFieldMap: Record<string, string>;
  /** 識別碼格式的正規表示式字串。空字串 = 不限制格式 */
  lookupPattern: string;
}

/** 保底預設值。唯一一份,不准在別的檔案再寫一份階段清單 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  productName: 'Mitch CRM',
  logoText: '',
  organizationName: '',
  organizationDisplayName: '',
  phone: '',
  mailingAddress: '',
  timezone: DEFAULT_TIME_ZONE,
  locale: DEFAULT_LOCALE,
  themeScheme: 'A',
  themeSidebar: 'dark',
  themeDefaultMode: 'system',
  // 階段與照片種類的保底值來自 @mitchcrm/shared,與後端第一次啟動 seed 進資料庫的
  // 完全是同一份。這裡再抄一份的話,全新安裝或設定 API 一時失敗時,看板的欄位數量、
  // 標籤與顏色會先畫成另一套再跳掉,而畫面上看不出原因。
  stages: DEFAULT_DEV_STAGES.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    board: s.showOnBoard,
    form: s.showInForm,
    terminal: s.isTerminal,
  })),
  photoChecklist: DEFAULT_VISIT_PHOTO_KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    required: k.required,
    placeTypes: [...k.placeTypes],
  })),
  channels: DEFAULT_INTERACTION_CHANNELS.map((c) => ({ key: c.key, label: c.label })),
  premisesTypes: DEFAULT_PREMISES_TYPES.map((p) => ({ key: p.key, label: p.label })),
  // 出廠沒有任何場所被豁免:照片存證是這套系統的核心,要豁免得由管理員明講
  photoExemptPremises: [],
  categories: DEFAULT_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
  areaColors: { crm: 'dev', field: 'app', team: 'rev', system: 'sys' },
  mapDefaultLat: 25.0478,
  mapDefaultLng: 121.5319,
  mapDefaultZoom: 12,
  mapTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  geocodeProvider: 'nominatim',
  // 出廠不限制國家:這套系統會裝在哪一國由使用單位決定
  geocodeCountryCodes: '',
  // 預設關閉:這套系統不預設任何一個國家的登記資料服務。
  // 標籤用一個通用到有點笨的說法,裝好之後由後台改成當地的正式名稱。
  lookupEnabled: false,
  lookupLabel: LOOKUP_DEFAULT_LABEL,
  lookupUrlTemplate: '',
  lookupFieldMap: {},
  lookupPattern: '',
};

// ── 解析(伺服器回什麼都不能讓畫面炸掉)────────────────────────────────

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 階段 key 的合法字元:英數與底線、減號。後端也用同一條規則 */
export const STAGE_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;

export function parseStages(raw: unknown): StageDef[] {
  if (!Array.isArray(raw)) return DEFAULT_APP_SETTINGS.stages;
  const out: StageDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!STAGE_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: str(o.label, key),
      color: oneOf(o.color, STAGE_COLOR_NAMES, 'neutral'),
      board: bool(o.board, true),
      form: bool(o.form, true),
      terminal: bool(o.terminal, false),
    });
  }
  return out.length > 0 ? out : DEFAULT_APP_SETTINGS.stages;
}

export function parsePhotoChecklist(raw: unknown): PhotoCheckItem[] {
  if (!Array.isArray(raw)) return DEFAULT_APP_SETTINGS.photoChecklist;
  const out: PhotoCheckItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!STAGE_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: str(o.label, key),
      required: bool(o.required, false),
      placeTypes: Array.isArray(o.placeTypes)
        ? o.placeTypes.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }
  return out.length > 0 ? out : DEFAULT_APP_SETTINGS.photoChecklist;
}

/**
 * 伺服器回什麼都不能讓畫面炸掉:只留代碼格式正確、沒重複的那些。
 * 整份都不能用(空陣列、不是陣列)才退回保底清單 —— 一個空下拉比一份舊清單更難用。
 */
export function parseVocabList(raw: unknown, fallback: readonly VocabItem[]): VocabItem[] {
  if (!Array.isArray(raw)) return fallback.map((f) => ({ ...f }));
  const out: VocabItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!VOCAB_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: str(o.label, key) });
  }
  return out.length > 0 ? out : fallback.map((f) => ({ ...f }));
}

/**
 * 代碼字串清單(例如 photoExemptPremises)。
 * 只留代碼格式正確、沒重複的那些;不是陣列就回空陣列。
 * 這裡不退回任何保底清單 —— 空的意思本來就是「沒有任何場所被豁免」。
 */
export function parseKeyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const key = v.trim();
    if (!VOCAB_KEY_PATTERN.test(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

export function parseAppSettings(raw: unknown): AppSettings {
  const d = DEFAULT_APP_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const o = raw as Record<string, unknown>;
  const areaRaw =
    typeof o.areaColors === 'object' && o.areaColors !== null
      ? (o.areaColors as Record<string, unknown>)
      : {};
  return {
    productName: str(o.productName, d.productName),
    logoText: str(o.logoText, d.logoText),
    organizationName: str(o.organizationName, str(o.companyName, d.organizationName)),
    organizationDisplayName: str(o.organizationDisplayName, d.organizationDisplayName),
    phone: str(o.phone, d.phone),
    mailingAddress: str(o.mailingAddress, d.mailingAddress),
    timezone: str(o.timezone, d.timezone),
    locale: str(o.locale, d.locale),
    themeScheme: oneOf(o.themeScheme, ['A', 'B'] as const, d.themeScheme),
    themeSidebar: oneOf(o.themeSidebar, ['dark', 'light'] as const, d.themeSidebar),
    themeDefaultMode: oneOf(
      o.themeDefaultMode,
      ['light', 'dark', 'system'] as const,
      d.themeDefaultMode,
    ),
    stages: parseStages(o.stages),
    photoChecklist: parsePhotoChecklist(o.photoChecklist),
    channels: parseVocabList(o.channels, d.channels),
    premisesTypes: parseVocabList(o.premisesTypes, d.premisesTypes),
    photoExemptPremises: parseKeyList(o.photoExemptPremises),
    categories: parseVocabList(o.categories, d.categories),
    areaColors: {
      crm: oneOf(areaRaw.crm, ZONE_NAMES, d.areaColors.crm),
      field: oneOf(areaRaw.field, ZONE_NAMES, d.areaColors.field),
      team: oneOf(areaRaw.team, ZONE_NAMES, d.areaColors.team),
      system: oneOf(areaRaw.system, ZONE_NAMES, d.areaColors.system),
    },
    mapDefaultLat: num(o.mapDefaultLat, d.mapDefaultLat),
    mapDefaultLng: num(o.mapDefaultLng, d.mapDefaultLng),
    mapDefaultZoom: num(o.mapDefaultZoom, d.mapDefaultZoom),
    mapTileUrl: str(o.mapTileUrl, d.mapTileUrl),
    geocodeProvider: oneOf(o.geocodeProvider, ['nominatim', 'none'] as const, d.geocodeProvider),
    geocodeCountryCodes: typeof o.geocodeCountryCodes === 'string' ? o.geocodeCountryCodes : '',
    lookupEnabled: bool(o.lookupEnabled, d.lookupEnabled),
    lookupLabel: str(o.lookupLabel, d.lookupLabel),
    lookupUrlTemplate: str(o.lookupUrlTemplate, d.lookupUrlTemplate),
    lookupFieldMap: parseLookupFieldMap(o.lookupFieldMap),
    lookupPattern: typeof o.lookupPattern === 'string' ? o.lookupPattern : d.lookupPattern,
  };
}

/** 伺服器回什麼都不能讓畫面炸掉:只留認得的 key,值只收字串 */
export function parseLookupFieldMap(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of LOOKUP_TARGET_FIELDS) {
    const v = o[field];
    if (typeof v === 'string' && v.trim() !== '') out[field] = v.trim();
  }
  return out;
}

/**
 * 把後台設定的識別碼格式編成 RegExp。空字串或編不起來都回 null(= 不檢查)。
 *
 * 一律補上頭尾錨點,與後端 compileLookupPattern 同一套規則 ——
 * 兩邊不一致的話,前端放行的值後端會擋,使用者看到的是「明明填對了卻說格式錯」。
 */
export function compileLookupPattern(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (p === '') return null;
  try {
    return new RegExp(`^(?:${p})$`);
  } catch {
    return null;
  }
}

// ── Provider ────────────────────────────────────────────────────────────

/**
 * 主機時間的基準點:serverMs 是伺服器回的那一刻,perf 是收到它時的 performance.now()。
 * 顯示時間一律用 serverMs + (現在的 performance.now() - perf) 推算 ——
 * performance.now() 是單調時鐘,使用者改自己電腦的時間也推不動它。
 */
export interface ServerTimeSync {
  serverMs: number;
  perf: number;
}

/** 目前這一刻。deviceTime=true 代表沒拿到主機時間,退回裝置時間(浮水印要標示) */
export interface NowResult {
  ms: number;
  deviceTime: boolean;
}

interface AppSettingsContextValue {
  settings: AppSettings;
  /** 還沒從伺服器拿到值時為 true(畫面用預設值,不是空白) */
  loading: boolean;
  /**
   * 重試完仍然讀不到設定。此時畫面上的階段、必拍清單、名稱全是出廠值,
   * 跟這個機構實際設定的不一樣,所以要讓使用者看得到,不能安靜降級。
   */
  failed: boolean;
  /** 後台存檔後呼叫,讓全站立刻換成新設定 */
  refresh: () => Promise<void>;
  /**
   * 現在幾點(毫秒)。以主機時間為準,拿不到才退回裝置時間並把 deviceTime 標成 true。
   *
   * 為什麼掛在這裡:主機時間跟著 /api/public/settings 的回應一起下來
   * (見後端 public-settings.controller 的 serverTime),浮水印與拍照存證都要它。
   * 那兩支原本各自打同一支端點、各自每五分鐘校正一次 —— 同一頁上兩份主機時間,
   * 而且是兩倍的請求。現在由這裡供應,整個前端只有一個時間基準。
   */
  serverNow: () => NowResult;
}

const AppSettingsContext = createContext<AppSettingsContextValue>({
  settings: DEFAULT_APP_SETTINGS,
  loading: false,
  failed: false,
  refresh: async () => {},
  serverNow: () => ({ ms: Date.now(), deviceTime: true }),
});

/**
 * 公開設定端點的一次回應:設定本體 + 伺服器時間。
 * serverMs 拿不到(舊版後端、回應格式不對)就是 null,呼叫端退回裝置時間。
 */
export interface PublicSettingsPayload {
  settings: AppSettings;
  serverMs: number | null;
}

/** 讀公開設定(含主機時間)。任何失敗都回 null,呼叫端沿用預設值 */
export async function fetchPublicAppSettingsPayload(
  signal?: AbortSignal,
): Promise<PublicSettingsPayload | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/public/settings`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { settings?: unknown; serverTime?: unknown };
    if (body.settings === undefined) return null;
    const ms = typeof body.serverTime === 'string' ? Date.parse(body.serverTime) : NaN;
    return {
      settings: parseAppSettings(body.settings),
      serverMs: Number.isFinite(ms) ? ms : null,
    };
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      console.error('[app-settings] 讀取公開設定失敗', err);
    }
    return null;
  }
}

/**
 * 重試間隔(毫秒)。第一次失敗多半是同一個對外 IP 上十幾個人同時開頁面撞到速率限制,
 * 或後端還在起。退避重試兩次就能吃掉這一類,不必讓使用者自己按重新整理。
 * 全部失敗才顯示提示,不要一失敗就跳警告。
 */
const SETTINGS_RETRY_DELAYS_MS = [600, 2400] as const;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** 讀公開設定,失敗就退避重試。全部失敗才回 null(匯出是為了讓測試釘住重試次數) */
export async function fetchPublicAppSettingsPayloadWithRetry(
  signal?: AbortSignal,
): Promise<PublicSettingsPayload | null> {
  const first = await fetchPublicAppSettingsPayload(signal);
  if (first) return first;
  for (const delay of SETTINGS_RETRY_DELAYS_MS) {
    if (signal?.aborted) return null;
    await sleep(delay, signal);
    if (signal?.aborted) return null;
    const next = await fetchPublicAppSettingsPayload(signal);
    if (next) return next;
  }
  return null;
}

/**
 * 主機時間的重新校正間隔。分頁開著幾個小時之後,performance.now() 推出來的時間
 * 會跟主機慢慢漂開,所以定期再對一次。
 *
 * 五分鐘是從浮水印元件搬過來的原值 —— 收斂之前浮水印與拍照存證各有一個
 * 五分鐘的計時器,各打各的同一支端點。現在整個前端只剩這一個。
 */
const SERVER_TIME_RESYNC_MS = 5 * 60 * 1000;

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 時間基準放 ref 不放 state:它每五分鐘更新一次,而且只有讀秒的那一刻要用,
  // 放 state 會讓整棵樹每五分鐘重畫一次。
  const timeSync = useRef<ServerTimeSync | null>(null);

  const apply = useCallback((payload: PublicSettingsPayload | null) => {
    if (payload) {
      setSettings(payload.settings);
      if (payload.serverMs !== null) {
        timeSync.current = { serverMs: payload.serverMs, perf: performance.now() };
      }
    }
    setFailed(payload === null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await fetchPublicAppSettingsPayloadWithRetry());
  }, [apply]);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const next = await fetchPublicAppSettingsPayloadWithRetry(ac.signal);
      if (ac.signal.aborted) return;
      apply(next);
    })();
    return () => ac.abort();
  }, [apply]);

  // 定期重新校正主機時間。這一趟不重試也不改 failed:它只是校時,
  // 失敗就沿用上一次的基準,不該把畫面推去顯示「設定讀取失敗」。
  useEffect(() => {
    const t = setInterval(() => {
      void (async () => {
        const next = await fetchPublicAppSettingsPayload();
        if (next?.serverMs != null) {
          timeSync.current = { serverMs: next.serverMs, perf: performance.now() };
          setSettings(next.settings);
        }
      })();
    }, SERVER_TIME_RESYNC_MS);
    return () => clearInterval(t);
  }, []);

  const serverNow = useCallback((): NowResult => {
    const sync = timeSync.current;
    if (!sync) return { ms: Date.now(), deviceTime: true };
    return { ms: sync.serverMs + (performance.now() - sync.perf), deviceTime: false };
  }, []);

  const value = useMemo<AppSettingsContextValue>(
    () => ({ settings, loading, failed, refresh, serverNow }),
    [settings, loading, failed, refresh, serverNow],
  );

  return (
    <AppSettingsContext.Provider value={value}>
      {failed ? (
        // 靜默降級最糟的後果不是畫面難看,是使用者照著出廠階段做事:
        // 把客戶拖進一個後台早就刪掉的階段,存檔時才被後端擋下來,而且看不懂為什麼。
        <p role="alert" className="flash flash-warning m-3">
          設定讀取失敗,目前顯示預設值。階段、必拍清單與名稱可能與貴單位實際設定的不同,
          存檔時可能會被伺服器擋下來。請重新整理頁面;一直是這樣的話請找系統管理員看後端狀態。
        </p>
      ) : null}
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings(): AppSettings {
  return useContext(AppSettingsContext).settings;
}

export function useAppSettingsContext(): AppSettingsContextValue {
  return useContext(AppSettingsContext);
}

/**
 * 「現在幾點」的取用點,以主機時間為準。
 *
 * 給存證用途:照片浮水印上的時間與防截圖浮水印的時鐘都走這一支,
 * 使用者把自己電腦的時間改掉也推不動它(基準是伺服器時間 + 單調時鐘)。
 * 拿不到主機時間時回 deviceTime: true,呼叫端要在畫面上標示「裝置時間」,
 * 不可以裝作那是主機時間。
 */
export function useServerNow(): () => NowResult {
  return useContext(AppSettingsContext).serverNow;
}

/**
 * 「時間點 → 給人看的字串」,照組織設定的時區,格式是 YYYY-MM-DD HH:mm。
 *
 * 為什麼不用 toLocaleString():那一支要嘛吃裝置的時區與語系,要嘛得寫死一組
 * 語系代碼。畫面上原本九處寫的是 toLocaleString('zh-TW'),那有兩個問題 ——
 * 一是時間照看的人的裝置時區算,跨時區的人看到的「最後登入」跟同事對不起來;
 * 二是把介面語系釘在一個地區,而這是通用產品。
 * 這裡回的是不依賴語系的數字格式,時區則一律照系統設定的那一格。
 *
 * 傳 null / undefined / 解析不出來的字串一律回空字串,由呼叫端決定要顯示什麼。
 */
export function useOrgTimeFormat(): (value: string | number | Date | null | undefined) => string {
  const { timezone } = useAppSettings();
  return useMemo(() => {
    return (value) => {
      if (value === null || value === undefined || value === '') return '';
      const d = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return formatOrgDateTime(d, timezone, { seconds: false });
    };
  }, [timezone]);
}

/**
 * 照片存證項目 key → 標籤。
 *
 * 後端回的 required / missing 是一串 key,畫面上要顯示的中文由後台設定決定
 * (每個行業拍的東西不一樣:餐廳拍廚房、工地拍圍籬)。查不到就回原 key,
 * 不要顯示空白 —— 缺件提示上出現空字串比出現英文 key 更難懂。
 */
export function usePhotoKindLabel(): (key: string) => string {
  const { photoChecklist } = useAppSettings();
  return useMemo(() => {
    const map = new Map(photoChecklist.map((i) => [i.key, i.label]));
    return (key: string) => map.get(key) ?? key;
  }, [photoChecklist]);
}

/** 代碼 → 名稱。查不到就回代碼本身,不要顯示空白:空字串比英文代碼更難懂 */
export function labelOf(list: readonly VocabItem[], key: string | null | undefined): string {
  if (!key) return '';
  return list.find((i) => i.key === key)?.label ?? key;
}

/**
 * 手動新增互動可以選的管道:到訪打卡那一個要拿掉。
 * 打卡要 GPS 與照片,只能從外勤拜訪頁走,後端也會擋(見 interactionBlockReason)。
 */
export function manualChannels(channels: readonly VocabItem[]): VocabItem[] {
  return channels.filter((c) => c.key !== VISIT_CHANNEL_KEY);
}

/** 互動管道、場所類型與商業分類這三份清單 */
export interface CrmVocab {
  channels: VocabItem[];
  premisesTypes: VocabItem[];
  categories: VocabItem[];
}

/**
 * 互動管道與場所類型。
 *
 * 這是 useAppSettings() 的取用捷徑,不是第二個供應點:兩份清單跟其餘設定同一趟
 * /api/public/settings 進來,由 AppSettingsProvider 統一負責重試與「設定讀取失敗」提示。
 * 之前它們自己一支 lib/crm-vocab.ts 各打各的,同一頁上兩份設定會走散,
 * 而且那一份失敗時畫面上什麼都看不到。
 */
export function useCrmVocab(): CrmVocab {
  const { channels, premisesTypes, categories } = useAppSettings();
  return useMemo(
    () => ({ channels, premisesTypes, categories }),
    [channels, premisesTypes, categories],
  );
}

/**
 * 戰情圖表與日報回的計數欄位 → 顯示名稱。
 *
 * 欄位名(interactions / visits / interested / converted / overdue)是 API 合約,
 * 不是階段代碼,所以它們寫在這裡;但其中兩個算的就是階段:
 * interested 算的是「進行中排最後的那一階」,converted 算的是成交階段。
 * 顯示名稱因此跟著後台的階段設定走 —— 寫死「有意願」「已成交」的話,
 * 管理員把階段改名之後,圖例與日報還印著舊名字,而數字是新的。
 */
export function useStatMetricLabel(): Record<string, string> {
  const { stages } = useAppSettings();
  return useMemo(() => {
    const inProgress = stages.filter((s) => !s.terminal);
    const nearest = inProgress.length ? inProgress[inProgress.length - 1] : undefined;
    const won = stages.find((s) => s.key === WON_STAGE_KEY);
    return {
      interactions: '互動',
      visits: '拜訪',
      interested: nearest?.label ?? '有意願',
      converted: won?.label ?? '成交',
      overdue: '逾期',
    };
  }, [stages]);
}

/** 站頭/頁尾用的商標文字 */
export function useLogoText(): string {
  const s = useAppSettings();
  return s.logoText || s.productName;
}

/**
 * 外部查詢帶入這一組設定的取用點。
 *
 * 給畫面用的三件事:那顆按鈕要不要出現(enabled)、這一格的標籤寫什麼(label)、
 * 送出前要不要擋格式(pattern)。**任何畫面都不要自己寫某一個地區的正式名稱**,
 * 那個字一律從這裡拿,這套系統要能裝在任何地方。
 */
export function useLookupSettings(): {
  enabled: boolean;
  label: string;
  pattern: RegExp | null;
} {
  const { lookupEnabled, lookupLabel, lookupPattern } = useAppSettings();
  return useMemo(
    () => ({
      enabled: lookupEnabled,
      label: lookupLabel.trim() || LOOKUP_DEFAULT_LABEL,
      pattern: compileLookupPattern(lookupPattern),
    }),
    [lookupEnabled, lookupLabel, lookupPattern],
  );
}

/** 只要標籤的簡版。清單、提示、欄位名共用同一個字 */
export function useLookupLabel(): string {
  const s = useAppSettings();
  return s.lookupLabel.trim() || LOOKUP_DEFAULT_LABEL;
}
