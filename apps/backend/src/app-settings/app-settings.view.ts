// ref:3687 mc/陳彥輔/米球®
/**
 * 前後端共用的「應用程式設定」外觀(view model)與雙向轉換。
 *
 * 為什麼要有這一支:資料庫那邊是五個地方(system_settings id=1 的 JSON、dev_stages、
 * visit_photo_kinds、dev_interaction_channels、dev_premises_types),
 * 前端那邊是一個扁平物件 AppSettings。
 * 兩邊的形狀不可能一樣,但**對應規則只能有一份** —— 散在 controller 與 service 裡
 * 的話,GET 與 PATCH 會慢慢走散,症狀是「存檔成功、重整之後值變回去」,
 * 那種問題從畫面上完全看不出原因。
 *
 * 這支是純函式,不碰 Prisma 也不碰 Nest,兩邊(SettingsService 的公開端點與
 * AppSettingsService 的後台端點)都直接用同一組轉換。
 *
 * 對應的前端型別:apps/frontend/src/lib/app-settings.tsx 的 AppSettings。
 * 那邊改欄位,這邊要跟著改,不然後台存得下去、畫面吃不到。
 */
import {
  DEFAULT_CATEGORIES,
  DEFAULT_INTERACTION_CHANNELS,
  DEFAULT_LOCALE,
  DEFAULT_PREMISES_TYPES,
  DEFAULT_TIME_ZONE,
  LOOKUP_DEFAULT_LABEL,
  LOOKUP_TARGET_FIELDS,
  ZONE_NAMES,
  resolveTimeZone,
  type ZoneName,
} from '@mitchcrm/shared';
// 型別直接向 settings.types.ts 拿,不向 settings.service.ts 拿:
// 那一支 import 這個檔的函式,兩邊互指就是一個 import 環(見 settings.types.ts 檔頭)
import type { SystemSettingsData } from '../settings/settings.types';

/**
 * 階段代碼與照片種類代碼的格式。前端 STAGE_KEY_PATTERN 用的是同一條。
 *
 * 收減號是因為前端的正規表示式收:兩邊不一致的話,使用者在後台建一個
 * `follow-up`,前端解析時整筆丟掉,畫面上那一欄直接消失而且沒有錯誤訊息。
 * 大寫一律不收 —— 這個值會直接寫進 dev_customers.stage,
 * 「Lead」與「lead」看起來一樣但是兩筆資料。
 */
export const SETTINGS_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;

export const KEY_FORMAT_MESSAGE = '代碼只能用小寫英文字母、數字、底線與減號,長度 1 到 32';

/** 看板色組名。對應前端 globals.css 的 --st-<name>-bg / -fg / -bar */
export const STAGE_COLOR_NAMES = [
  'purple',
  'info',
  'teal',
  'amber',
  'pink',
  'green',
  'neutral',
  'danger',
] as const;
export type StageColorName = (typeof STAGE_COLOR_NAMES)[number];

/**
 * 舊資料的色票對照。
 *
 * 第一版的預設階段把色票存成 hex(#94a3b8 之類),前端只認色組名,
 * 拿到 hex 會退回 neutral,結果是升級之後整個看板變灰。
 * 已經上線的資料庫不會因為改了預設值就跟著變,所以要有這張對照表。
 */
const LEGACY_HEX_TO_COLOR: Readonly<Record<string, StageColorName>> = {
  '#94a3b8': 'neutral',
  '#60a5fa': 'info',
  '#38bdf8': 'teal',
  '#fbbf24': 'amber',
  '#a78bfa': 'purple',
  '#34d399': 'green',
  '#f87171': 'danger',
};

export function normalizeStageColor(raw: string | null | undefined): StageColorName {
  const v = (raw ?? '').trim().toLowerCase();
  if ((STAGE_COLOR_NAMES as readonly string[]).includes(v)) return v as StageColorName;
  return LEGACY_HEX_TO_COLOR[v] ?? 'neutral';
}

/**
 * 功能區識別色。值只能是這五組已驗過對比的色盤,不開放自由填色值。
 * 定義在 @mitchcrm/shared,前後端共用同一份;這裡只是 re-export,不要另外寫一份。
 */
export { ZONE_NAMES };
export type { ZoneName };
export const AREA_KEYS = ['crm', 'field', 'team', 'system'] as const;
export type AreaKey = (typeof AREA_KEYS)[number];
export type AreaColors = Record<AreaKey, ZoneName>;

/** 看板一欄的對外形狀(前端 StageDef) */
export interface StageView {
  key: string;
  label: string;
  color: StageColorName;
  /** 出現在看板欄位 */
  board: boolean;
  /** 出現在新增 / 編輯表單的下拉 */
  form: boolean;
  /** 終止階段(成交或放棄):不再視為進行中 */
  terminal: boolean;
}

/** 照片存證檢查表的一項(前端 PhotoCheckItem) */
export interface PhotoCheckItemView {
  key: string;
  label: string;
  /** 必拍(缺了會在客戶卡顯示缺件提示) */
  required: boolean;
  /** 只在這些場所類型要求;空陣列 = 所有場所 */
  placeTypes: string[];
}

/**
 * 互動管道與場所類型的對外形狀。
 *
 * 只有代碼與名稱兩格:排序就是陣列順序(與階段、照片種類同一套約定),
 * 啟用與否在轉換時就過濾掉了,畫面拿到的清單直接就是「可以選的那些」。
 */
export interface VocabItemView {
  key: string;
  label: string;
}

/** 資料表那側的通用主檔列(dev_interaction_channels / dev_premises_types) */
export interface VocabRow {
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

/** 出廠的互動管道與場所類型,讀不到主檔時的保底 */
export const DEFAULT_CHANNEL_VIEW: VocabItemView[] = DEFAULT_INTERACTION_CHANNELS.map((c) => ({
  key: c.key,
  label: c.label,
}));
export const DEFAULT_PREMISES_TYPE_VIEW: VocabItemView[] = DEFAULT_PREMISES_TYPES.map((p) => ({
  key: p.key,
  label: p.label,
}));
export const DEFAULT_CATEGORY_VIEW: VocabItemView[] = DEFAULT_CATEGORIES.map((c) => ({
  key: c.key,
  label: c.label,
}));

/**
 * 主檔列 → 對外清單。空的(表還沒建好、或全部停用)就退回出廠預設:
 * 讓客戶卡的管道下拉整個空掉,比先給一份保底清單更難用,而且畫面上看不出原因。
 */
export function toVocabView(
  rows: readonly VocabRow[] | undefined,
  fallback: readonly VocabItemView[],
): VocabItemView[] {
  const active = (rows ?? [])
    .filter((r) => r.isActive)
    .map((r) => ({ key: r.key, label: r.label }));
  return active.length > 0 ? active : fallback.map((f) => ({ ...f }));
}

/**
 * 外部查詢識別碼的預設名稱與欄位對應表認得的三個目標欄位。
 * 兩者都定義在 @mitchcrm/shared,前後端共用同一份;這裡只是 re-export。
 */
export { LOOKUP_DEFAULT_LABEL, LOOKUP_TARGET_FIELDS };

/**
 * 欄位對應表的清洗。
 *
 * 這一格是 JSON 欄位,裡面可能是任何東西(手改過的資料列、後台貼錯的字串),
 * 所以逐格檢查:只留三個認得的 key,值只收字串,並且擋掉點分隔路徑裡
 * 會導致原型污染的段落 —— 取值那一側(lookup-url.ts 的 pickByPath)也擋一次,
 * 兩邊都擋是刻意的,少一邊都不該讓這件事成立。
 */
export function normalizeLookupFieldMap(raw: unknown): Record<string, string> {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const field of LOOKUP_TARGET_FIELDS) {
    const v = o[field];
    if (typeof v !== 'string') continue;
    const path = v.trim();
    if (path === '') continue;
    if (path.length > 200) continue;
    if (!/^[A-Za-z0-9_.[\]-]+$/.test(path)) continue;
    if (
      path
        .split('.')
        .some((seg) => seg === '__proto__' || seg === 'constructor' || seg === 'prototype')
    ) {
      continue;
    }
    out[field] = path;
  }
  return out;
}

/** 前端 AppSettings 的完整形狀。欄位名要與前端一字不差 */
export interface AppSettingsView {
  productName: string;
  logoText: string;
  organizationName: string;
  organizationDisplayName: string;
  phone: string;
  mailingAddress: string;
  timezone: string;
  locale: string;
  themeScheme: 'A' | 'B';
  themeSidebar: 'dark' | 'light';
  themeDefaultMode: 'light' | 'dark' | 'system';
  stages: StageView[];
  photoChecklist: PhotoCheckItemView[];
  /** 互動管道(客戶卡的「新增互動」下拉、時間軸的管道名稱) */
  channels: VocabItemView[];
  /** 場所類型(照片存證檢查表按它分組) */
  premisesTypes: VocabItemView[];
  /**
   * 明確設定為「不需照片存證」的場所類型代碼。
   * 空陣列 = 每一種場所都要有必拍項目才放得了成交。
   * 詳見 SystemSettingsData.photoExemptPremises 與 normalizePhotoExemptPremises。
   */
  photoExemptPremises: string[];
  /** 商業分類(客戶卡與新增客戶頁的「分類」下拉) */
  categories: VocabItemView[];
  areaColors: AreaColors;
  mapDefaultLat: number;
  mapDefaultLng: number;
  mapDefaultZoom: number;
  /** 拜訪地圖圖磚網址樣板({z}/{x}/{y})。詳見 SystemSettingsData.mapTileUrl */
  mapTileUrl: string;
  geocodeProvider: 'nominatim' | 'none';
  /**
   * 地理編碼限制的國家(逗號分隔的兩碼國碼,空字串 = 不限制)。
   * 詳見 SystemSettingsData.geocodeCountryCodes 與 normalizeGeocodeCountryCodes。
   */
  geocodeCountryCodes: string;
  /** 外部查詢帶入:開關、識別碼的當地名稱、網址樣板、欄位對應、格式 */
  lookupEnabled: boolean;
  lookupLabel: string;
  lookupUrlTemplate: string;
  lookupFieldMap: Record<string, string>;
  lookupPattern: string;
}

/**
 * 後台送進來的那一包。
 *
 * 全部欄位可省略,省略 = 這一段不動(PATCH 的語意)。清單那兩段特別要緊:
 * `stages: []` 是「把階段全部刪掉」,`stages` 沒帶是「這次不碰階段」——
 * 兩者差一個空陣列,結果差一個看板。
 */
export interface AppSettingsPatch extends Partial<
  Omit<
    AppSettingsView,
    'stages' | 'photoChecklist' | 'channels' | 'premisesTypes' | 'categories' | 'areaColors'
  >
> {
  stages?: Array<Partial<StageView> & { key: string }>;
  photoChecklist?: Array<Partial<PhotoCheckItemView> & { key: string }>;
  channels?: Array<Partial<VocabItemView> & { key: string }>;
  premisesTypes?: Array<Partial<VocabItemView> & { key: string }>;
  categories?: Array<Partial<VocabItemView> & { key: string }>;
  /** 值的合法性由 normalizeAreaColors 收斂,所以這裡收任意字串對照表 */
  areaColors?: Record<string, string>;
}

/** 資料表那側的階段列(只取轉換用得到的欄位) */
export interface StageRow {
  key: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isActive: boolean;
  isTerminal: boolean;
  showOnBoard: boolean;
  showInForm: boolean;
}

/**
 * 資料表那側的照片種類列。
 *
 * 「必拍」與「哪些場所要拍」不在這張表裡,而是在 system_settings 的
 * photoChecklist(場所類型 → 照片代碼)。刻意不加欄位:那份對照表已經是
 * 打卡驗證(checkin-rules)吃的形狀,再開兩個欄位就會有兩份會走散的真相,
 * 而且既有部署的資料表加欄位只能補預設值,等於把現有的必拍設定清成空的。
 */
export interface PhotoKindRow {
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * 拜訪地圖圖磚的出廠預設網址。改成可設定不改變預設行為:沒填就還是這個。
 * 這是公共的 OpenStreetMap 圖磚,由使用者的瀏覽器直接請求。
 */
export const DEFAULT_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const DEFAULT_AREA_COLORS: AreaColors = {
  crm: 'dev',
  field: 'app',
  team: 'rev',
  system: 'sys',
};

/** 拿不到設定時的保底值。與前端 DEFAULT_APP_SETTINGS 的非清單欄位一致 */
export const APP_SETTINGS_VIEW_DEFAULTS: Omit<
  AppSettingsView,
  'stages' | 'photoChecklist' | 'channels' | 'premisesTypes' | 'categories'
> = {
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
  areaColors: DEFAULT_AREA_COLORS,
  mapDefaultLat: 25.0478,
  mapDefaultLng: 121.5319,
  mapDefaultZoom: 12,
  mapTileUrl: DEFAULT_MAP_TILE_URL,
  geocodeProvider: 'nominatim',
  geocodeCountryCodes: '',
  photoExemptPremises: [],
  lookupEnabled: false,
  lookupLabel: LOOKUP_DEFAULT_LABEL,
  lookupUrlTemplate: '',
  lookupFieldMap: {},
  lookupPattern: '',
};

function pickOne<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 地理編碼的國家限制。
 *
 * 格式:逗號分隔的 ISO 3166-1 alpha-2 兩碼國碼,大小寫都收,存成小寫(例:`tw`、`jp,kr`)。
 * **空字串代表不限制國家**,而且那是出廠值 —— 這套系統會裝在哪一國由使用單位決定。
 *
 * 這一格會原樣變成送給 Nominatim 的 `countrycodes` 查詢參數,所以要在存的時候就洗乾淨:
 * 不是兩個英文字母的段落一律丟掉,避免有人貼進一整句話(或換行、`&`)而讓那個請求
 * 變成別的意思。最多留 20 個國碼,重複的只留一個,順序照使用者填的。
 * 全部段落都不合法時回空字串,也就是「不限制」,而不是把一個壞值送出去查不到任何地址。
 */
export const GEOCODE_COUNTRY_CODES_MAX = 20;

export function normalizeGeocodeCountryCodes(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const seen: string[] = [];
  for (const part of raw.split(',')) {
    const code = part.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(code)) continue;
    if (seen.includes(code)) continue;
    seen.push(code);
    if (seen.length >= GEOCODE_COUNTRY_CODES_MAX) break;
  }
  return seen.join(',');
}

/**
 * 「不需照片存證」的場所類型清單。
 *
 * 這一格是 JSON 欄位,內容可能是任何東西(手改過的資料列、舊版寫進去的形狀),
 * 所以逐格檢查:只留字串、只留合法的代碼格式、去重,並且設上限。
 * 值本身不跟 dev_premises_types 對照 —— 場所類型可以被停用又啟用,
 * 對照的話會在停用期間安靜地把豁免設定清掉,而使用者沒有動過那一格。
 */
export const PHOTO_EXEMPT_PREMISES_MAX = 100;

export function normalizePhotoExemptPremises(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const key = v.trim();
    if (!SETTINGS_KEY_PATTERN.test(key)) continue;
    if (out.includes(key)) continue;
    out.push(key);
    if (out.length >= PHOTO_EXEMPT_PREMISES_MAX) break;
  }
  return out;
}

/** JSON 欄位存的功能區配色可能是任何東西(手改過的資料列),逐格檢查 */
export function normalizeAreaColors(raw: unknown): AreaColors {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as AreaColors;
  for (const area of AREA_KEYS) {
    out[area] = pickOne(o[area], ZONE_NAMES, DEFAULT_AREA_COLORS[area]);
  }
  return out;
}

/** 資料表 + 設定列 → 前端要的那一包 */
export function toAppSettingsView(
  settings: SystemSettingsData,
  stages: readonly StageRow[],
  photoKinds: readonly PhotoKindRow[],
  vocab: {
    channels?: readonly VocabRow[];
    premisesTypes?: readonly VocabRow[];
    categories?: readonly VocabRow[];
  } = {},
): AppSettingsView {
  const checklist = settings.photoChecklist ?? {};
  const d = APP_SETTINGS_VIEW_DEFAULTS;
  const organizationName = (settings.companyName ?? '').trim();
  return {
    productName: (settings.productName ?? '').trim() || d.productName,
    logoText: settings.logoText ?? '',
    organizationName,
    organizationDisplayName: settings.organizationDisplayName ?? '',
    phone: settings.contactPhone ?? '',
    mailingAddress: settings.mailingAddress ?? '',
    // 認不得的時區字串(手動改資料庫、舊資料)退回出廠預設:讀出來的值一定用得起來,
    // 日期計算不會因為一格設定打錯就整條路徑丟例外
    timezone: resolveTimeZone(settings.timezone ?? d.timezone),
    locale: (settings.locale ?? '').trim() || d.locale,
    themeScheme: settings.themeScheme === 'B' ? 'B' : 'A',
    themeSidebar: settings.themeSidebar === 'light' ? 'light' : 'dark',
    themeDefaultMode: pickOne(
      settings.themeDefaultMode,
      ['light', 'dark', 'system'] as const,
      d.themeDefaultMode,
    ),
    stages: stages
      .filter((s) => s.isActive)
      .map((s) => ({
        key: s.key,
        label: s.label,
        color: normalizeStageColor(s.color),
        board: s.showOnBoard,
        form: s.showInForm,
        terminal: s.isTerminal,
      })),
    photoChecklist: photoKinds
      .filter((k) => k.isActive)
      .map((k) => {
        // 出現在哪幾個場所的必備清單裡,就是「這個場所要拍它」
        const placeTypes = Object.entries(checklist)
          .filter(([, kinds]) => Array.isArray(kinds) && kinds.includes(k.key))
          .map(([place]) => place)
          .sort();
        return {
          key: k.key,
          label: k.label,
          required: placeTypes.length > 0,
          placeTypes,
        };
      }),
    channels: toVocabView(vocab.channels, DEFAULT_CHANNEL_VIEW),
    premisesTypes: toVocabView(vocab.premisesTypes, DEFAULT_PREMISES_TYPE_VIEW),
    photoExemptPremises: normalizePhotoExemptPremises(settings.photoExemptPremises),
    categories: toVocabView(vocab.categories, DEFAULT_CATEGORY_VIEW),
    areaColors: normalizeAreaColors(settings.areaColors),
    mapDefaultLat: pickNumber(settings.mapDefaultLat, d.mapDefaultLat),
    mapDefaultLng: pickNumber(settings.mapDefaultLng, d.mapDefaultLng),
    mapDefaultZoom: pickNumber(settings.mapDefaultZoom, d.mapDefaultZoom),
    mapTileUrl: (settings.mapTileUrl ?? '').trim() || d.mapTileUrl,
    geocodeProvider: pickOne(
      settings.geocodeProvider,
      ['nominatim', 'none'] as const,
      d.geocodeProvider,
    ),
    geocodeCountryCodes: normalizeGeocodeCountryCodes(settings.geocodeCountryCodes),
    lookupEnabled: settings.lookupEnabled ?? d.lookupEnabled,
    lookupLabel: (settings.lookupLabel ?? '').trim() || d.lookupLabel,
    lookupUrlTemplate: settings.lookupUrlTemplate ?? d.lookupUrlTemplate,
    lookupFieldMap: normalizeLookupFieldMap(settings.lookupFieldMap),
    lookupPattern: settings.lookupPattern ?? d.lookupPattern,
  };
}

/**
 * 前端送來的那一包 → system_settings 要寫的欄位。
 * 只挑「有帶」的欄位,沒帶的一律不動(PATCH 語意)。
 */
export function toSettingsPatch(
  view: Omit<
    AppSettingsPatch,
    'stages' | 'photoChecklist' | 'channels' | 'premisesTypes' | 'categories'
  >,
): Partial<SystemSettingsData> {
  const patch: Partial<SystemSettingsData> = {};
  if (view.productName !== undefined) patch.productName = view.productName.trim();
  if (view.logoText !== undefined) patch.logoText = view.logoText.trim();
  // organizationName 就是 companyName:同一個值,兩個名字。
  // 舊欄位名留著是因為 /api/public/settings 與匯出檔都用 companyName,改名會一路連坐。
  if (view.organizationName !== undefined) patch.companyName = view.organizationName.trim();
  if (view.organizationDisplayName !== undefined) {
    patch.organizationDisplayName = view.organizationDisplayName.trim();
  }
  if (view.phone !== undefined) patch.contactPhone = view.phone.trim();
  if (view.mailingAddress !== undefined) patch.mailingAddress = view.mailingAddress.trim();
  // 存進去之前先驗:不是合法的 IANA 時區就存出廠預設。
  // 存了認不得的字串的話,畫面上看起來設定成功,日期計算卻整套退回預設,兩邊對不上。
  if (view.timezone !== undefined) patch.timezone = resolveTimeZone(view.timezone);
  if (view.locale !== undefined) patch.locale = view.locale.trim();
  if (view.themeScheme !== undefined) patch.themeScheme = view.themeScheme;
  if (view.themeSidebar !== undefined) patch.themeSidebar = view.themeSidebar;
  if (view.themeDefaultMode !== undefined) patch.themeDefaultMode = view.themeDefaultMode;
  if (view.areaColors !== undefined) patch.areaColors = normalizeAreaColors(view.areaColors);
  if (view.mapDefaultLat !== undefined) patch.mapDefaultLat = view.mapDefaultLat;
  if (view.mapDefaultLng !== undefined) patch.mapDefaultLng = view.mapDefaultLng;
  if (view.mapDefaultZoom !== undefined) patch.mapDefaultZoom = view.mapDefaultZoom;
  // 空字串是有意義的值:代表「用出廠的公共圖磚」,讀取端(toAppSettingsView)
  // 看到空的就填預設。合法性(協定與 {z}/{x}/{y})由 service 的 assertMapTileUrl 擋。
  if (view.mapTileUrl !== undefined) patch.mapTileUrl = view.mapTileUrl.trim();
  if (view.geocodeProvider !== undefined) patch.geocodeProvider = view.geocodeProvider;
  if (view.geocodeCountryCodes !== undefined) {
    patch.geocodeCountryCodes = normalizeGeocodeCountryCodes(view.geocodeCountryCodes);
  }
  if (view.photoExemptPremises !== undefined) {
    patch.photoExemptPremises = normalizePhotoExemptPremises(view.photoExemptPremises);
  }
  if (view.lookupEnabled !== undefined) patch.lookupEnabled = view.lookupEnabled;
  if (view.lookupLabel !== undefined) patch.lookupLabel = view.lookupLabel.trim();
  if (view.lookupUrlTemplate !== undefined) {
    patch.lookupUrlTemplate = view.lookupUrlTemplate.trim();
  }
  if (view.lookupFieldMap !== undefined) {
    patch.lookupFieldMap = normalizeLookupFieldMap(view.lookupFieldMap);
  }
  if (view.lookupPattern !== undefined) patch.lookupPattern = view.lookupPattern.trim();
  return patch;
}

/**
 * 照片存證檢查表:清單形狀 → 場所類型對照表。
 *
 * 打卡驗證(checkin-rules)吃的是 { 場所類型: [照片代碼] } 這種形狀,
 * 而後台編輯的是一列一項的清單。兩者是同一份資料的兩種寫法,
 * 這裡是唯一的換算點:每次寫入檢查表都重算一次對照表存回 settings,
 * 打卡那條路徑就完全不必知道清單長什麼樣。
 *
 * placeTypes 空陣列的意思是「所有場所都要」,所以要有一份已知場所清單。
 */
export function toPhotoChecklistMap(
  items: readonly PhotoCheckItemView[],
  placeTypes: readonly string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const place of placeTypes) out[place] = [];
  for (const item of items) {
    if (!item.required) continue;
    const targets = item.placeTypes.length > 0 ? item.placeTypes : placeTypes;
    for (const place of targets) {
      if (!out[place]) out[place] = [];
      if (!out[place].includes(item.key)) out[place].push(item.key);
    }
  }
  return out;
}
