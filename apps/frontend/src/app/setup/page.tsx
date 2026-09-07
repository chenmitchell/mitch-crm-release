// ref:3687 mc/陳彥輔/米球®
'use client';

// 安裝精靈(/setup)。第一次架起這套系統時走一遍。
//
// 設計前提:**除了管理員帳號,每一步都可以跳過**。跳過的那一段不會出現在送給後端的
// payload 裡,後端就用它自己的預設值。理由很簡單 —— 一個人在剛裝好系統、什麼都還沒摸過
// 的時候,沒有辦法決定「我們公司的客戶階段要哪幾個」。逼他當下決定,他只會亂填。
// 每一頁下方都寫明「之後可以在系統設定改」,而那句話是真的:
// /admin/settings 的分頁涵蓋這裡的每一個項目。
//
// ── 管理員帳號是唯一不能跳過的一步 ──────────────────────────────────
// 它沒有預設值,而且後端的「裝好了沒」判準就是 users 表有沒有人。以前這一步可以跳過,
// 跳過之後後端照樣回 201,但一個帳號都沒建,於是完成畫面上三句話同時是假的:
// 「精靈不會再出現」(還會)、「跳過的步驟會用預設值」(管理員沒有預設值)、
// 「用剛才建立的管理員帳號登入」(沒有那個帳號,按下前往登入的人無帳號可用)。
// 現在:這一步沒有「跳過」按鈕,直接跳到最後一步也會被完成步驟擋下並說明,
// 而完成畫面的文案依實際狀態決定,不預先假設帳號建好了。
//
// 無障礙:
//   步驟列是 <ol>,目前這一步用 aria-current="step",且文字前面標「第 N 步」——
//     不是只有顏色在標示位置。
//   每個欄位都有 <label>,錯誤訊息 role="alert" 並用 aria-describedby 綁在欄位上。
//   所有按鈕與輸入框最小高度 44px(2.5.5 AAA)。
//   送出中的狀態用 aria-busy + role="status" 播報,不是只把按鈕變灰。
//   換步驟時把焦點送到新的步驟標題,並用 aria-live 播報「第 N 步,共 M 步:標題」——
//     以前按完「下一步」焦點還留在按鈕上,section 裡的內容整個換掉卻沒有任何播報,
//     螢幕閱讀器使用者按了之後聽不到任何變化,只能自己往下摸索十個步驟。
//
// ── 填到一半不會消失,跳步也會驗 ────────────────────────────────────
// 每一次改動都寫一份草稿進 localStorage(密碼除外,理由見下面草稿那一段),
// 進場讀得到就先問「上次填到第 N 步,接著填還是重新開始」。
// 步驟列可以直接跳步,但往前跳之前會先驗要離開的那一步(往回走不驗,回頭看一眼
// 不可能繞過任何檢查);送出前十步再全部驗一次,
// 第一個有問題的地方連同「第幾步、哪一步」一起講,並把人送回那一步。
// 這兩件事以前都沒有:填到第 8 步關掉分頁就整份重來,而跳步等於繞過驗證 ——
// 把緯度清空跳到最後一步,Number('') 是 0,後端收下,地圖鏡頭就停在赤道的海上。
//
// 進場先問一次 GET /api/setup/status:
//   以前這一頁完全不看 initialized,任何人手動打 /setup 都會看到一份空白的十步表單,
//   從頭填到底、按下送出,才在那一刻吃到後端的 409,而且填的東西全部沒了。
//   現在改成一進場先問,已初始化就直接顯示「系統已安裝」並請人去登入,不讓人白填。
//   問不到後端時**不**當成「還沒裝」—— 服務暫時不通的時候,把人送進一個看起來
//   可以重設系統的表單比擋住更糟。這一種情況顯示錯誤訊息並提供重試。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_APP_SETTINGS,
  RESERVED_STAGE_KEYS,
  STAGE_COLOR_NAMES,
  STAGE_KEY_PATTERN,
  ZONE_NAMES,
  ZONE_LABEL,
  AREA_LABEL,
  type AreaKey,
  type PhotoCheckItem,
  type StageDef,
  type ZoneName,
} from '@/lib/app-settings';
import { fetchSetupStatus, setupAdminError, submitSetup, type SetupPayload } from '@/lib/setup';
import {
  Field,
  LookupEditor,
  PhotoChecklistEditor,
  StageEditor,
  type LookupEditorValue,
} from '@/components/settings/editors';
import { LocaleField, TimeZoneField, localeFieldsError } from '@/components/settings/locale-fields';
import { DEFAULT_TIME_ZONE } from '@mitchcrm/shared/time';
// 密碼長度規則全系統一份(見 packages/shared/src/password.ts):
// 這裡、邀請註冊、改密碼三處以前各寫一個數字,規則等於形同虛設。
import { PASSWORD_MIN } from '@mitchcrm/shared/password';

// ── 步驟定義 ─────────────────────────────────────────────────────────────

type StepId =
  | 'org'
  | 'admin'
  | 'locale'
  | 'departments'
  | 'stages'
  | 'photos'
  | 'map'
  | 'lookup'
  | 'appearance'
  | 'done';

const STEPS: ReadonlyArray<{ id: StepId; title: string; blurb: string }> = [
  { id: 'org', title: '組織名稱', blurb: '這套系統要顯示成誰的名字' },
  { id: 'admin', title: '管理員帳號', blurb: '第一個能登入後台的人' },
  { id: 'locale', title: '時區與地區', blurb: '打卡與日報照哪個時區算' },
  { id: 'departments', title: '部門與主管', blurb: '團隊的初始結構' },
  { id: 'stages', title: '客戶階段', blurb: '看板上會有哪幾欄' },
  { id: 'photos', title: '照片存證檢查表', blurb: '外勤到現場要拍什麼' },
  { id: 'map', title: '地圖與地理編碼', blurb: '拜訪地圖打開時看哪裡' },
  { id: 'lookup', title: '外部查詢帶入', blurb: '要不要用外部服務自動帶資料' },
  { id: 'appearance', title: '外觀', blurb: '配色與日夜模式' },
  { id: 'done', title: '完成', blurb: '確認後開始使用' },
];

// ── 各步驟的表單狀態 ─────────────────────────────────────────────────────

interface DepartmentRow {
  name: string;
  managerName: string;
  managerEmail: string;
}

/** 精靈十步的表單狀態。export 是給草稿的測試用的,頁面外沒有別人在改它 */
export interface WizardState {
  org: { name: string; displayName: string; productName: string; logoText: string };
  admin: { email: string; name: string; password: string; password2: string };
  locale: { timezone: string; locale: string };
  departments: DepartmentRow[];
  stages: StageDef[];
  photos: PhotoCheckItem[];
  map: {
    lat: string;
    lng: string;
    zoom: string;
    provider: 'nominatim' | 'none';
    /** 逗號分隔的兩碼國碼,空字串 = 不限制國家 */
    countryCodes: string;
  };
  lookup: LookupEditorValue;
  appearance: {
    themeScheme: 'A' | 'B';
    themeSidebar: 'dark' | 'light';
    themeDefaultMode: 'light' | 'dark' | 'system';
    areaColors: Record<AreaKey, ZoneName>;
  };
}

/**
 * 不能跳過的步驟。目前只有管理員帳號:它沒有預設值,
 * 而且後端判斷「系統裝好了沒」看的就是有沒有使用者。
 */
const REQUIRED_STEPS = new Set<StepId>(['admin']);

/** 管理員帳號在步驟列的位置(擋下之後要把人送回去) */
const ADMIN_STEP_INDEX = STEPS.findIndex((s) => s.id === 'admin');

const D = DEFAULT_APP_SETTINGS;

/** 出廠狀態。export 同樣是給測試當基準用 */
export const INITIAL: WizardState = {
  org: { name: '', displayName: '', productName: D.productName, logoText: '' },
  admin: { email: '', name: '', password: '', password2: '' },
  locale: { timezone: D.timezone, locale: D.locale },
  departments: [{ name: '', managerName: '', managerEmail: '' }],
  stages: D.stages.map((s) => ({ ...s })),
  photos: D.photoChecklist.map((p) => ({ ...p, placeTypes: [...p.placeTypes] })),
  map: {
    lat: String(D.mapDefaultLat),
    lng: String(D.mapDefaultLng),
    zoom: String(D.mapDefaultZoom),
    provider: D.geocodeProvider,
    countryCodes: D.geocodeCountryCodes,
  },
  lookup: {
    enabled: D.lookupEnabled,
    label: D.lookupLabel,
    urlTemplate: D.lookupUrlTemplate,
    fieldMap: { ...D.lookupFieldMap },
    pattern: D.lookupPattern,
  },
  appearance: {
    themeScheme: D.themeScheme,
    themeSidebar: D.themeSidebar,
    themeDefaultMode: D.themeDefaultMode,
    areaColors: { ...D.areaColors },
  },
};

// ── 草稿 ────────────────────────────────────────────────────────────────
//
// 十步的表單填到一半被打斷是常態:分頁被系統回收、手機切出去接電話、按到上一頁。
// 以前這一頁完全沒有留存,回來就是空白的第 1 步,前面填的幾十格全部重來,
// 而畫面上還寫著「正在寫入設定,請不要關掉這一頁」,等於只提醒了送出的那幾秒。
// 現在每一次改動都寫一份草稿進 localStorage,進場讀得到就先問一句
// 「上次填到第 N 步,接著填還是重新開始」,由使用者決定,不擅自幫他還原。
// 安裝成功之後草稿要清掉,否則下一個人進來會看到別人的資料。
//
// 密碼那兩格刻意不存。localStorage 在同一台機器上任何人都讀得到,
// 把管理員密碼放進去換一點方便並不划算,接著填的時候重新輸入一次就好。
//
// 密碼以外的東西是留著的,而且其中有同事的姓名與 Email(部門負責人、管理員本人)。
// 這件事有兩個後果,底下兩段各處理一個:
//   一、草稿有時效。安裝多半當天就走完,留七天已經涵蓋「隔了一個週末回來接著填」;
//       再長就只是把同事的姓名與 Email 明文放在別人的機器上,而那台機器可能根本
//       不是最後完成安裝的那一台(別人在別台裝完,這台的 gate 變成 initialized,
//       以前連讀都不讀就 return,那份草稿就永遠留著)。所以過期不還原並且清掉,
//       而且一發現系統已安裝就先清一次。
//   二、還原前要把草稿會帶進來的非預設值列給管理員看(見 draftDiffLines)。
//
// localStorage 在無痕視窗、企業原則關掉儲存、配額滿的時候會丟例外,
// 所以讀寫一律包 try/catch:存不進去就當作沒有草稿,精靈照樣可以從頭走完,
// 不會因為存不進去而整頁壞掉。

export const SETUP_DRAFT_KEY = 'mitchcrm-setup-draft';

/** 草稿格式版本。改欄位就加一,舊草稿讀到不同的版本一律當作沒有草稿 */
const SETUP_DRAFT_VERSION = 2;

/**
 * 草稿的保存期限。七天:安裝通常當天就走完,七天足夠涵蓋「週五填一半、週一回來接著填」,
 * 再長就只是讓同事的姓名與 Email 一直躺在那台瀏覽器裡。過期的草稿不還原也不留著。
 */
export const SETUP_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SetupDraft {
  stepIndex: number;
  state: WizardState;
  skipped: StepId[];
}

const STEP_IDS = new Set<string>(STEPS.map((s) => s.id));

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * 把讀回來的東西一格一格檢查過再用。
 * localStorage 是使用者自己改得動的地方,不能當可信輸入:型別對不上就退回出廠值,
 * 而不是硬轉型別讓壞資料流進表單(那會在送出時才炸,而且看不出是哪一格)。
 */
function reviveState(raw: unknown): WizardState {
  const o = obj(raw);
  const org = obj(o.org);
  const admin = obj(o.admin);
  const locale = obj(o.locale);
  const map = obj(o.map);
  const lookup = obj(o.lookup);
  const appearance = obj(o.appearance);
  const areaColors = obj(appearance.areaColors);
  const fieldMap = obj(lookup.fieldMap);
  const departments = Array.isArray(o.departments)
    ? o.departments.map((d) => {
        const r = obj(d);
        return {
          name: str(r.name, ''),
          managerName: str(r.managerName, ''),
          managerEmail: str(r.managerEmail, ''),
        };
      })
    : INITIAL.departments.map((d) => ({ ...d }));
  const stages = Array.isArray(o.stages)
    ? o.stages.map((v) => {
        const r = obj(v);
        return {
          key: str(r.key, ''),
          label: str(r.label, ''),
          color: pick(r.color, STAGE_COLOR_NAMES, D.stages[0]?.color ?? STAGE_COLOR_NAMES[0]!),
          board: bool(r.board, true),
          form: bool(r.form, true),
          terminal: bool(r.terminal, false),
        } satisfies StageDef;
      })
    : INITIAL.stages.map((s) => ({ ...s }));
  const photos = Array.isArray(o.photos)
    ? o.photos.map((v) => {
        const r = obj(v);
        return {
          key: str(r.key, ''),
          label: str(r.label, ''),
          required: bool(r.required, false),
          placeTypes: Array.isArray(r.placeTypes)
            ? r.placeTypes.filter((p): p is string => typeof p === 'string')
            : [],
        } satisfies PhotoCheckItem;
      })
    : INITIAL.photos.map((p) => ({ ...p, placeTypes: [...p.placeTypes] }));
  const colors = { ...INITIAL.appearance.areaColors };
  for (const area of Object.keys(colors) as AreaKey[]) {
    colors[area] = pick(areaColors[area], ZONE_NAMES, colors[area]);
  }
  const map1 = { ...INITIAL.lookup.fieldMap };
  for (const key of Object.keys(map1)) map1[key] = str(fieldMap[key], map1[key] ?? '');
  return {
    org: {
      name: str(org.name, ''),
      displayName: str(org.displayName, ''),
      productName: str(org.productName, D.productName),
      logoText: str(org.logoText, ''),
    },
    // 密碼不進草稿,讀回來也一律留白
    admin: { email: str(admin.email, ''), name: str(admin.name, ''), password: '', password2: '' },
    locale: {
      timezone: str(locale.timezone, D.timezone),
      locale: str(locale.locale, D.locale),
    },
    departments: departments.length > 0 ? departments : INITIAL.departments.map((d) => ({ ...d })),
    stages,
    photos,
    map: {
      lat: str(map.lat, String(D.mapDefaultLat)),
      lng: str(map.lng, String(D.mapDefaultLng)),
      zoom: str(map.zoom, String(D.mapDefaultZoom)),
      provider: pick(map.provider, ['nominatim', 'none'] as const, D.geocodeProvider),
      countryCodes: str(map.countryCodes, D.geocodeCountryCodes),
    },
    lookup: {
      enabled: bool(lookup.enabled, D.lookupEnabled),
      label: str(lookup.label, D.lookupLabel),
      urlTemplate: str(lookup.urlTemplate, D.lookupUrlTemplate),
      fieldMap: map1,
      pattern: str(lookup.pattern, D.lookupPattern),
    },
    appearance: {
      themeScheme: pick(appearance.themeScheme, ['A', 'B'] as const, D.themeScheme),
      themeSidebar: pick(appearance.themeSidebar, ['dark', 'light'] as const, D.themeSidebar),
      themeDefaultMode: pick(
        appearance.themeDefaultMode,
        ['light', 'dark', 'system'] as const,
        D.themeDefaultMode,
      ),
      areaColors: colors,
    },
  };
}

/**
 * 把草稿字串解析回來。格式不對、版本不同、根本不是 JSON、已經過期,都回 null(當作沒有草稿)。
 * now 只有測試會自己帶。
 */
export function parseSetupDraft(raw: string | null, now: number = Date.now()): SetupDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = obj(parsed);
  if (o.version !== SETUP_DRAFT_VERSION) return null;
  if (typeof o.state !== 'object' || o.state === null) return null;
  // 時效。沒有時間戳、時間戳不是數字、或者超過保存期限,一律當作沒有草稿。
  // 時鐘被往回調的情況(savedAt 在未來)也不放行,免得一份很舊的草稿靠著假時間戳長生不老。
  const savedAt = o.savedAt;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (now - savedAt > SETUP_DRAFT_MAX_AGE_MS || savedAt > now + SETUP_DRAFT_MAX_AGE_MS) return null;
  const idx = o.stepIndex;
  const stepIndex =
    typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < STEPS.length ? idx : 0;
  const skipped = Array.isArray(o.skipped)
    ? o.skipped.filter((k): k is StepId => typeof k === 'string' && STEP_IDS.has(k))
    : [];
  return { stepIndex, state: reviveState(o.state), skipped };
}

/**
 * 序列化。密碼在這裡就拿掉,不是等到讀回來才清。
 * savedAt 是寫入當下的時間,讀回來時用它算時效;now 只有測試會自己帶。
 */
export function serializeSetupDraft(draft: SetupDraft, now: number = Date.now()): string {
  const { admin, ...rest } = draft.state;
  return JSON.stringify({
    version: SETUP_DRAFT_VERSION,
    savedAt: now,
    stepIndex: draft.stepIndex,
    skipped: draft.skipped,
    state: { ...rest, admin: { email: admin.email, name: admin.name } },
  });
}

/** localStorage 拿不到就回 null(無痕視窗、企業原則、伺服器端渲染) */
function draftStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadSetupDraft(
  store: Storage | null = draftStore(),
  now: number = Date.now(),
): SetupDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(SETUP_DRAFT_KEY);
    if (raw === null) return null;
    const draft = parseSetupDraft(raw, now);
    // 過期或格式壞掉的草稿沒有用途,而它裡面有同事的姓名與 Email。
    // 讀到就順手清掉,不要讓它一直躺在這台瀏覽器裡。
    if (!draft) clearSetupDraft(store);
    return draft;
  } catch {
    return null;
  }
}

/**
 * 這份草稿值不值得留。原封不動的第 1 步不算 ——
 * 留著的話,每一個第一次開這一頁的人都會先被問一次「要接著填還是重新開始」,
 * 而他根本還沒填過任何東西。
 */
export function draftWorthKeeping(draft: SetupDraft): boolean {
  if (draft.stepIndex > 0 || draft.skipped.length > 0) return true;
  // 兩邊帶同一個時間:savedAt 每次呼叫都不一樣,不固定住的話這裡永遠不相等
  const at = 0;
  return (
    serializeSetupDraft(draft, at) !==
    serializeSetupDraft({ stepIndex: 0, state: INITIAL, skipped: [] }, at)
  );
}

export function saveSetupDraft(draft: SetupDraft, store: Storage | null = draftStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(SETUP_DRAFT_KEY, serializeSetupDraft(draft));
    return true;
  } catch {
    // 配額滿或不給存:這一次沒留住草稿,但精靈本身照常運作
    return false;
  }
}

export function clearSetupDraft(store: Storage | null = draftStore()): void {
  if (!store) return;
  try {
    store.removeItem(SETUP_DRAFT_KEY);
  } catch {
    // 清不掉就算了,下次進場的還原提示還是由使用者自己決定要不要用
  }
}

/**
 * 還原之前要列給管理員看的一行。
 *
 * 為什麼要列:草稿是 localStorage 裡的一筆資料,誰能碰到那台瀏覽器誰就改得動它,
 * 而 reviveState 只驗型別不看值。一份型別完全合法、但把外部查詢的網址樣板換成
 * 外部網址的草稿,以前在畫面上只顯示「上次停在第 N 步」,管理員按了接著填、
 * 跳到最後送出,從此每一次查詢都把識別碼送去那個網址,全程沒有一句話。
 * 所以還原之前先把「這份草稿會帶進來哪些跟出廠值不同的東西」攤開給人看。
 *
 * 密碼類的欄位不會出現在這裡:它們本來就沒有寫進草稿(見 serializeSetupDraft)。
 */
export interface DraftDiffLine {
  label: string;
  value: string;
}

/** 列出來的值截短,免得一段很長的樣板把畫面撐爆 */
const DIFF_VALUE_MAX = 120;

function diffValue(v: string): string {
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return '(留白)';
  return t.length > DIFF_VALUE_MAX ? `${t.slice(0, DIFF_VALUE_MAX)}…` : t;
}

/**
 * 這份草稿跟出廠值有哪些不一樣。回傳的順序就是畫面上列出來的順序。
 * 欄位標籤只描述這一頁自己的格子,不是業務用語清單:客戶階段、存證照片項目
 * 這些的內容一律從草稿本身讀出來印,沒有寫死的清單。
 */
export function draftDiffLines(state: WizardState): DraftDiffLine[] {
  const out: DraftDiffLine[] = [];
  const put = (label: string, value: string, base: string) => {
    if (value !== base) out.push({ label, value: diffValue(value) });
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  put('組織名稱', state.org.name, INITIAL.org.name);
  put('對外顯示名稱', state.org.displayName, INITIAL.org.displayName);
  put('產品名稱', state.org.productName, INITIAL.org.productName);
  put('標誌文字', state.org.logoText, INITIAL.org.logoText);
  // 密碼那兩格不在草稿裡,所以也不會列在這裡
  put('管理員 Email', state.admin.email, INITIAL.admin.email);
  put('管理員姓名', state.admin.name, INITIAL.admin.name);
  put('時區', state.locale.timezone, INITIAL.locale.timezone);
  put('語系', state.locale.locale, INITIAL.locale.locale);

  if (!same(state.departments, INITIAL.departments)) {
    state.departments.forEach((d, i) => {
      const parts = [d.name, d.managerName, d.managerEmail].filter((v) => v.trim() !== '');
      out.push({
        label: `部門 ${i + 1}`,
        value: parts.length ? diffValue(parts.join(' / ')) : '(留白)',
      });
    });
  }
  if (!same(state.stages, INITIAL.stages)) {
    out.push({
      label: '客戶階段',
      value: diffValue(state.stages.map((v) => v.label || v.key).join('、')),
    });
  }
  if (!same(state.photos, INITIAL.photos)) {
    out.push({
      label: '存證照片項目',
      value: diffValue(state.photos.map((v) => v.label || v.key).join('、')),
    });
  }

  put('地圖中心緯度', state.map.lat, INITIAL.map.lat);
  put('地圖中心經度', state.map.lng, INITIAL.map.lng);
  put('地圖縮放層級', state.map.zoom, INITIAL.map.zoom);
  put('地理編碼服務', state.map.provider, INITIAL.map.provider);
  put('地理編碼國別碼', state.map.countryCodes, INITIAL.map.countryCodes);

  if (state.lookup.enabled !== INITIAL.lookup.enabled) {
    out.push({ label: '外部查詢', value: state.lookup.enabled ? '開啟' : '關閉' });
  }
  put('外部查詢名稱', state.lookup.label, INITIAL.lookup.label);
  // 這一行是這整份清單最重要的一行:草稿改得動它,而它決定識別碼會被送到哪裡
  put('外部查詢網址樣板', state.lookup.urlTemplate, INITIAL.lookup.urlTemplate);
  put('外部查詢輸入格式', state.lookup.pattern, INITIAL.lookup.pattern);
  if (!same(state.lookup.fieldMap, INITIAL.lookup.fieldMap)) {
    out.push({
      label: '外部查詢欄位對應',
      value: diffValue(
        Object.entries(state.lookup.fieldMap)
          .map(([k, v]) => `${k}=${v}`)
          .join('、'),
      ),
    });
  }

  put('配色', state.appearance.themeScheme, INITIAL.appearance.themeScheme);
  put('側欄深淺', state.appearance.themeSidebar, INITIAL.appearance.themeSidebar);
  put('預設模式', state.appearance.themeDefaultMode, INITIAL.appearance.themeDefaultMode);
  if (!same(state.appearance.areaColors, INITIAL.appearance.areaColors)) {
    out.push({
      label: '區塊配色',
      value: diffValue(
        Object.entries(state.appearance.areaColors)
          .map(([k, v]) => `${k}=${v}`)
          .join('、'),
      ),
    });
  }
  return out;
}

// ── 頁面 ────────────────────────────────────────────────────────────────

/** 進場檢查的三種結果。'unreachable' 是「問不到後端」,跟「已安裝」要分開處理 */
type Gate = 'checking' | 'open' | 'initialized' | 'unreachable';

export default function SetupWizardPage() {
  const [gate, setGate] = useState<Gate>('checking');
  const [gateNonce, setGateNonce] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL);
  /** 使用者按了「跳過」的步驟。跳過的步驟不會出現在 payload 裡 */
  const [skipped, setSkipped] = useState<Set<StepId>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  /** 步驟標題。換步驟後焦點送到這裡,螢幕閱讀器才知道畫面換了 */
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** 換步驟的播報文字(視覺上隱藏)。焦點移動之外再播一次「第幾步、共幾步」 */
  const [announce, setAnnounce] = useState('');
  /** 第一次進場不要搶焦點,只有使用者按了上一步 / 下一步 / 步驟列才移動 */
  const firstRender = useRef(true);
  /**
   * 草稿的處置。'checking' 是還沒讀,'ask' 是讀到了正在等使用者決定,
   * 'using' 是可以開始寫草稿了。在使用者決定之前不寫,免得把上一次的內容蓋掉。
   */
  const [draftState, setDraftState] = useState<'checking' | 'ask' | 'using'>('checking');
  /** 讀回來的草稿,等使用者選「接著填」才會套用 */
  const [draft, setDraft] = useState<SetupDraft | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    void (async () => {
      const status = await fetchSetupStatus(ac.signal);
      if (!alive) return;
      if (status === null) setGate('unreachable');
      else setGate(status.initialized ? 'initialized' : 'open');
    })();
    return () => {
      alive = false;
      ac.abort();
    };
  }, [gateNonce]);

  // 系統已經安裝好了(可能是別人在別台機器裝完的),這台機器上的草稿就沒有用途了。
  // 只是 return 不讀的話,那份帶著同事姓名與 Email 的內容會永遠留在這台瀏覽器裡,
  // 因為原本唯一清掉它的時機是「在同一台瀏覽器把安裝走完」。
  useEffect(() => {
    if (gate === 'initialized') clearSetupDraft();
  }, [gate]);

  // 草稿只讀一次,而且只在確定系統還沒安裝之後才讀:已安裝或連不上後端的時候
  // 問「要不要接著填」沒有意義。
  useEffect(() => {
    if (gate !== 'open' || draftState !== 'checking') return;
    const found = loadSetupDraft();
    if (found && draftWorthKeeping(found)) {
      setDraft(found);
      setDraftState('ask');
    } else {
      setDraftState('using');
    }
  }, [gate, draftState]);

  // 每一次改動都寫一份草稿。寫不進去(無痕視窗、配額滿)就當作沒有草稿,不影響操作。
  useEffect(() => {
    if (draftState !== 'using' || gate !== 'open' || done) return;
    const draft: SetupDraft = { stepIndex, state, skipped: [...skipped] };
    // 還沒動過任何東西就不要留下草稿,否則下一個人一進來就被問「要不要接著填」
    if (draftWorthKeeping(draft)) saveSetupDraft(draft);
    else clearSetupDraft();
  }, [draftState, gate, done, stepIndex, state, skipped]);

  const step = STEPS[stepIndex] ?? STEPS[0]!;
  const isLast = step.id === 'done';

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const s = STEPS[stepIndex] ?? STEPS[0]!;
    setAnnounce(`第 ${stepIndex + 1} 步,共 ${STEPS.length} 步:${s.title}。${s.blurb}`);
    headingRef.current?.focus();
  }, [stepIndex]);

  const markUsed = useCallback((id: StepId) => {
    setSkipped((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * 改某一步的欄位。
   *
   * 動到欄位就解除那一步的「跳過」:按過跳過之後從步驟列點回那一步、把時區改成
   * Asia/Tokyo、再從步驟列點到最後一步送出,buildPayload 會因為它還在 skipped
   * 裡而整段不送,剛剛打的字靜靜消失,而那一步本身沒有任何一句話說它被跳過了
   * (「(跳過)」那個標記在目前所在的那一步是不顯示的)。
   * WizardState 的鍵與步驟 id 是同一組名字,所以這裡直接拿 key 當步驟 id。
   */
  const patch = useCallback(
    <K extends keyof WizardState>(key: K, value: WizardState[K]) => {
      setState((cur) => ({ ...cur, [key]: value }));
      markUsed(key as StepId);
    },
    [markUsed],
  );

  function goNext() {
    setError(null);
    const msg = validate(step.id, state);
    if (msg) {
      setError(msg);
      return;
    }
    markUsed(step.id);
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function goSkip() {
    setError(null);
    // 按鈕在必填步驟本來就不顯示,這裡再擋一次:
    // 直接呼叫(鍵盤操作殘留的焦點、之後改版)不該繞過這條規則。
    if (REQUIRED_STEPS.has(step.id)) {
      setError('「管理員帳號」不能跳過:它沒有預設值,不填就沒有人登得進來');
      return;
    }
    setSkipped((cur) => new Set(cur).add(step.id));
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function goBack() {
    setError(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  /**
   * 步驟列的跳步。以前這裡只有 setStepIndex,完全不驗證,於是「第 7 步把緯度清空、
   * 直接點到第 10 步送出」這條路徑上沒有任何一格會發現問題:Number('') 是 0,
   * 後端的 @Min(-90) 收下 0,安裝成功,拜訪地圖的鏡頭停在幾內亞灣的海上。
   * 現在離開一步之前先驗那一步,不過就停在原地並說出原因。
   * 已經按過「跳過」的那一步不驗:它的值根本不會出現在 payload 裡。
   *
   * 只驗往前走的那一邊。往回走不可能繞過任何檢查(送出前的 firstStepError 會再掃
   * 一次每一步),而回頭一律先驗的話,把緯度清空想回第 1 步看一眼組織名的人會被
   * 卡在第 7 步 —— 同一件事按「上一步」卻走得掉,兩顆按鈕的行為不一致。
   */
  function goToStep(target: number) {
    setError(null);
    if (target === stepIndex) return;
    if (target > stepIndex && !skipped.has(step.id)) {
      const msg = validate(step.id, state);
      if (msg) {
        setError(`第 ${stepIndex + 1} 步「${step.title}」還有問題:${msg}`);
        return;
      }
      markUsed(step.id);
    }
    setStepIndex(target);
  }

  async function finish() {
    setError(null);
    // 步驟列可以直接點到最後一步,所以「跳過」擋住還不夠:送出前再確認一次。
    // 少了這一道,payload 裡沒有 admin,後端照樣回 201,而系統其實一個帳號都沒有。
    const adminMsg = adminError(state);
    if (adminMsg) {
      setError(`${adminMsg}。管理員帳號是必填的一步,請回到第 ${ADMIN_STEP_INDEX + 1} 步填完`);
      setStepIndex(ADMIN_STEP_INDEX);
      return;
    }
    // 每一步都再驗一次。跳步的路徑上有些步驟從來沒被驗過,而後端擋下來的訊息是英文,
    // 會被 api-error 的中文過濾濾掉,使用者只看得到「安裝失敗(400)」,
    // 十步的內容都還在畫面上卻沒有一個字說是哪一步哪一格。
    const stepMsg = firstStepError(state, skipped);
    if (stepMsg) {
      setError(stepMsg.message);
      setStepIndex(stepMsg.index);
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitSetup(buildPayload(state, skipped));
      if (!result.ok) {
        setError(result.message ?? '安裝失敗,請稍後再試');
        return;
      }
      // 裝好了草稿就沒有用了,留著只會讓下一個開這一頁的人看到別人填的資料
      clearSetupDraft();
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  const skippedTitles = useMemo(
    () => STEPS.filter((s) => skipped.has(s.id)).map((s) => s.title),
    [skipped],
  );

  if (gate === 'checking') {
    return (
      <article className="mx-auto max-w-2xl space-y-4">
        <h1>安裝精靈</h1>
        <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
          正在確認系統是否已經安裝過...
        </p>
      </article>
    );
  }

  if (gate === 'initialized') {
    return (
      <article className="mx-auto max-w-2xl space-y-4">
        <h1>系統已安裝</h1>
        <p role="status" className="flash flash-info">
          這套系統已經完成初次設定,安裝精靈只能跑一次。請直接登入。
        </p>
        <p className="text-sm text-muted-foreground">
          要調整組織名稱、客戶階段、照片檢查表這些設定,登入後在「系統設定」裡改。
          忘記管理員密碼的話,請找有管理員權限的同事重設,或依照文件從機器上重建帳號。
        </p>
        <a href="/login" className="btn btn-primary min-h-[44px] px-6">
          前往登入
        </a>
      </article>
    );
  }

  if (gate === 'unreachable') {
    return (
      <article className="mx-auto max-w-2xl space-y-4">
        <h1>安裝精靈</h1>
        <p role="alert" className="flash flash-error">
          連不上後端服務,現在無法確認系統是否已經安裝過。
        </p>
        <p className="text-sm text-muted-foreground">
          在確認之前不會顯示安裝表單:如果系統其實已經裝好了,填完只會在送出時被拒絕,
          填的內容也會全部消失。請確認後端服務已啟動,再按下面的按鈕重試。
        </p>
        <button
          type="button"
          className="btn btn-primary min-h-[44px] px-6"
          onClick={() => {
            setGate('checking');
            setGateNonce((n) => n + 1);
          }}
        >
          重新檢查
        </button>
      </article>
    );
  }

  if (!done && draftState === 'checking') {
    return (
      <article className="mx-auto max-w-2xl space-y-4">
        <h1>安裝精靈</h1>
        <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
          正在確認有沒有上次填到一半的內容...
        </p>
      </article>
    );
  }

  if (!done && draftState === 'ask' && draft) {
    const at = STEPS[draft.stepIndex] ?? STEPS[0]!;
    const lines = draftDiffLines(draft.state);
    return (
      <article className="mx-auto max-w-2xl space-y-4">
        <h1>安裝精靈</h1>
        <p role="status" className="flash flash-info">
          這台機器上有一份沒填完的安裝內容,上次停在第 {draft.stepIndex + 1} 步「{at.title}」。
          要接著填,還是重新開始?
        </p>
        <section aria-labelledby="setup-draft-diff" className="space-y-2">
          <h2 id="setup-draft-diff" className="text-base font-semibold">
            接著填會帶進來的內容
          </h2>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              這份草稿裡的每一格都還是預設值,只是上次停在第 {draft.stepIndex + 1} 步。
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                以下是這份草稿裡跟預設值不一樣的欄位。草稿存在這台瀏覽器裡,誰用得到這台機器
                誰就改得動它,所以按「接著填」之前請先看過一遍,尤其是外部查詢的網址樣板。
              </p>
              <dl className="space-y-1 text-sm">
                {lines.map((l) => (
                  <div key={l.label} className="flex flex-wrap gap-x-2">
                    <dt className="font-medium">{l.label}</dt>
                    <dd className="break-all text-muted-foreground">{l.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>
        <p className="text-sm text-muted-foreground">
          這份草稿留著的是上面列出來的那些欄位,包含管理員的 Email 與姓名、部門負責人的姓名與
          Email,明文存在這台瀏覽器裡;只有管理員密碼沒有留存,
          接著填的時候要再輸入一次。草稿存滿七天沒用到就會自動清掉。
          按「重新開始」會把上次的內容清掉,清掉之後找不回來。
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary min-h-[44px] px-6"
            onClick={() => {
              setState(draft.state);
              setSkipped(new Set(draft.skipped));
              setStepIndex(draft.stepIndex);
              setDraft(null);
              setDraftState('using');
            }}
          >
            接著填第 {draft.stepIndex + 1} 步
          </button>
          <button
            type="button"
            className="btn min-h-[44px] px-6"
            onClick={() => {
              clearSetupDraft();
              setState(INITIAL);
              setSkipped(new Set());
              setStepIndex(0);
              setDraft(null);
              setDraftState('using');
            }}
          >
            重新開始,清掉上次的內容
          </button>
        </div>
      </article>
    );
  }

  if (done) {
    // 文案依實際狀態而定:有沒有建管理員帳號,決定的是「精靈會不會再出現」
    // 與「等一下用什麼登入」。這兩句話不能在沒有帳號的時候照樣印出來。
    const created = adminFilled(state);
    return (
      <article className="mx-auto max-w-2xl space-y-4">
        <h1>安裝完成</h1>
        <p role="status" className="flash flash-success">
          {created
            ? `設定已寫入,管理員帳號 ${state.admin.email} 已建立。接下來用這組帳號密碼登入。`
            : '設定已寫入。'}
        </p>
        {created ? null : (
          <p role="alert" className="flash flash-warning text-sm">
            這次沒有建立管理員帳號,所以還沒有人登得進來,安裝精靈下次進來還會出現。請依文件用後端的
            seed 指令建立第一個帳號(設定 SEED_ADMIN_EMAIL 與 SEED_ADMIN_PASSWORD
            後重啟後端),或重新走一次這個精靈。
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          剛才跳過或想改的項目,登入後都在「系統設定」裡,每一項都能再調整。
        </p>
        <a href="/login" className="btn btn-primary min-h-[44px] px-6">
          前往登入
        </a>
      </article>
    );
  }

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          安裝精靈
        </p>
        <h1>{state.org.productName || D.productName} 初次設定</h1>
        <p className="text-sm text-muted-foreground">
          共 {STEPS.length} 步。除了「管理員帳號」之外都可以跳過,跳過的項目會用預設值,
          裝好之後在「系統設定」都改得動。管理員帳號沒有預設值,不填就沒有人登得進來。
        </p>
      </header>

      <nav aria-label="安裝步驟">
        <ol className="flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => {
            const current = i === stepIndex;
            const passed = i < stepIndex;
            const wasSkipped = skipped.has(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goToStep(i)}
                  aria-current={current ? 'step' : undefined}
                  className={`min-h-[44px] rounded-md border px-3 py-2 text-sm ${
                    current
                      ? 'border-transparent bg-primary font-bold text-primary-foreground'
                      : 'border-border bg-surface font-normal text-foreground hover:bg-muted'
                  }`}
                >
                  {/* 狀態不只靠顏色:目前這一步字重變粗,而且下面這行文字直接說出狀態 */}
                  <span className="sr-only">
                    第 {i + 1} 步,
                    {current ? '目前所在' : wasSkipped ? '已跳過' : passed ? '已填' : '尚未填'}:
                  </span>
                  <span aria-hidden="true">{i + 1}. </span>
                  {s.title}
                  {wasSkipped && !current ? (
                    <span className="ml-1 text-xs" aria-hidden="true">
                      (跳過)
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* 換步驟的播報。放在 section 外面、且內容每次都變,螢幕閱讀器才會唸出來 */}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      <section className="card space-y-4" aria-labelledby="setup-step-title">
        <div>
          {/* tabIndex={-1}:程式把焦點送過來,但不進 Tab 順序 */}
          <h2 id="setup-step-title" ref={headingRef} tabIndex={-1} className="page-h2">
            第 {stepIndex + 1} 步:{step.title}
          </h2>
          <p className="page-subtle">{step.blurb}</p>
        </div>

        {error ? (
          <p role="alert" id="setup-error" className="flash flash-error">
            {error}
          </p>
        ) : null}

        <StepBody step={step.id} state={state} patch={patch} skippedTitles={skippedTitles} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={goBack}
          disabled={stepIndex === 0}
          className="btn min-h-[44px] px-4"
        >
          上一步
        </button>
        <div className="flex flex-wrap gap-2">
          {!isLast && !REQUIRED_STEPS.has(step.id) ? (
            <button type="button" onClick={goSkip} className="btn min-h-[44px] px-4">
              跳過這一步
            </button>
          ) : null}
          {isLast ? (
            <button
              type="button"
              onClick={() => void finish()}
              aria-busy={submitting}
              aria-describedby={error ? 'setup-error' : undefined}
              className="btn btn-primary min-h-[44px] px-6"
            >
              {submitting ? '寫入設定中…' : '完成安裝'}
            </button>
          ) : (
            <button type="button" onClick={goNext} className="btn btn-primary min-h-[44px] px-6">
              下一步
            </button>
          )}
        </div>
      </div>
      {submitting ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在寫入設定,請不要關掉這一頁。
        </p>
      ) : null}
    </article>
  );
}

// ── 驗證(只擋「填了但填錯」,沒填的一律放行,因為每一步都可以跳過)──────────

/** 管理員帳號這一步的規則放在 lib/setup(那裡有測試),頁面只是包一層拿 state */
function adminError(s: WizardState): string | null {
  return setupAdminError(s.admin);
}

function adminFilled(s: WizardState): boolean {
  return setupAdminError(s.admin) === null;
}

/**
 * 一格數字欄位的檢查。空字串跟「填了但超出範圍」講的是不一樣的話 ——
 * 使用者清空一格之後看到「要介於 1 到 19 之間」會以為自己填了不合法的數字。
 */
export function numberFieldError(
  raw: string,
  label: string,
  min: number,
  max: number,
): string | null {
  const t = raw.trim();
  if (t === '') return `${label}不能留空,要填 ${min} 到 ${max} 之間的數字`;
  const n = Number(t);
  if (!Number.isFinite(n)) return `${label}要填數字`;
  if (n < min || n > max) return `${label}要介於 ${min} 到 ${max} 之間`;
  return null;
}

/**
 * 從第一步掃到最後一步,回報第一個有問題的步驟。
 * 訊息帶步驟編號與步驟名稱,因為使用者可能是從步驟列跳過來的,
 * 只講「縮放層級要介於 1 到 19 之間」他不知道那一格在第幾步。
 * 已經按過「跳過」的步驟不驗:那一段整個不會出現在 payload 裡。
 */
export function firstStepError(
  s: WizardState,
  skipped: ReadonlySet<StepId>,
): { index: number; message: string } | null {
  for (let i = 0; i < STEPS.length; i += 1) {
    const st = STEPS[i]!;
    if (skipped.has(st.id)) continue;
    const msg = validate(st.id, s);
    if (msg) {
      return { index: i, message: `第 ${i + 1} 步「${st.title}」還有問題:${msg}` };
    }
  }
  return null;
}

export function validate(step: StepId, s: WizardState): string | null {
  if (step === 'locale') {
    // 後端 resolveTimeZone 收下任何合法的 IANA 值,不合法的會被靜靜換成預設時區。
    // 前端這裡直接拿 Intl 試一次,讓打錯字的人當場看到,而不是裝完才發現時間全錯。
    const msg = localeFieldsError(s.locale.timezone, s.locale.locale);
    if (msg) return msg;
  }
  if (step === 'admin') {
    // 以前這裡是「完全沒填 = 等同跳過」,於是整套系統可以在沒有任何帳號的狀態下
    // 走完安裝,而完成畫面還叫人去登入。現在這一步一律要填齊。
    const msg = adminError(s);
    if (msg) return msg;
  }
  if (step === 'stages') {
    if (s.stages.length === 0) return '至少要留一個客戶階段';
    const keys = new Set<string>();
    for (const st of s.stages) {
      if (!STAGE_KEY_PATTERN.test(st.key)) {
        return `階段代碼「${st.key}」不合法:只能用小寫英數字、底線與減號,最多 32 個字`;
      }
      if (keys.has(st.key)) return `階段代碼「${st.key}」重複了`;
      keys.add(st.key);
      if (st.label.trim() === '') return '每個階段都要有名稱';
    }
    if (!s.stages.some((st) => st.board)) return '至少要有一個階段出現在看板上';
  }
  if (step === 'photos') {
    const keys = new Set<string>();
    for (const p of s.photos) {
      if (!STAGE_KEY_PATTERN.test(p.key)) {
        return `照片項目代碼「${p.key}」不合法:只能用小寫英數字、底線與減號`;
      }
      if (keys.has(p.key)) return `照片項目代碼「${p.key}」重複了`;
      keys.add(p.key);
      if (p.label.trim() === '') return '每個照片項目都要有名稱';
    }
  }
  if (step === 'map') {
    // 留白要單獨擋。Number('') 是 0,0 又剛好落在合法的經緯度範圍裡,
    // 於是「把緯度清空」會一路通到後端,存成 0,拜訪地圖的鏡頭停在幾內亞灣的海上。
    const lat = numberFieldError(s.map.lat, '預設緯度', -90, 90);
    if (lat) return lat;
    const lng = numberFieldError(s.map.lng, '預設經度', -180, 180);
    if (lng) return lng;
    const zoom = numberFieldError(s.map.zoom, '縮放層級', 1, 19);
    if (zoom) return zoom;
    // 留空是合法的,那代表不限制國家
    const codes = s.map.countryCodes.trim();
    if (codes !== '' && !/^[A-Za-z]{2}(\s*,\s*[A-Za-z]{2})*$/.test(codes)) {
      return '限制國家要填兩碼國碼,多個用逗號分隔(例如 tw 或 jp,kr)。留空代表不限制';
    }
  }
  if (step === 'lookup') {
    const l = s.lookup;
    // 只在「要啟用」的時候要求網址,關著就讓人一路跳過去
    if (l.enabled) {
      const t = l.urlTemplate.trim();
      if (t === '') return '要啟用外部查詢帶入,必須填查詢網址樣板';
      if (!t.includes('{q}')) return '查詢網址樣板要包含 {q},那是識別碼會被代進去的位置';
      if (!t.startsWith('https://')) return '查詢網址只接受 https';
    }
    if (l.label.trim() === '') return '識別碼的名稱不能留空';
    if (l.pattern.trim() !== '') {
      try {
        new RegExp(l.pattern);
      } catch {
        return '識別碼格式不是合法的正規表示式。留空代表不限制格式';
      }
    }
  }
  return null;
}

// ── 組 payload:跳過的步驟整段不送 ────────────────────────────────────────

/**
 * 字串轉數字,轉不出來就退回出廠值。
 * 以前這裡直接寫 Number(s.map.lat):空字串會變成 0,而 0 是合法的經緯度,
 * 後端收得下來,於是「清空那一格」變成「把鏡頭搬到赤道上的海面」而沒有任何提示。
 * 送出前 firstStepError 已經會擋下留白,這一層是最後一道:寧可送出廠值,
 * 也不要把空字串靜靜地變成 0。
 */
function numOr(raw: string, fallback: number): number {
  const t = raw.trim();
  if (t === '') return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

function buildPayload(s: WizardState, skipped: Set<StepId>): SetupPayload {
  const out: SetupPayload = {};
  if (!skipped.has('org') && (s.org.name || s.org.displayName || s.org.productName)) {
    out.organization = {
      name: s.org.name.trim(),
      displayName: s.org.displayName.trim(),
      productName: s.org.productName.trim() || D.productName,
      logoText: s.org.logoText.trim(),
    };
  }
  if (!skipped.has('admin') && s.admin.email && s.admin.password) {
    out.admin = {
      email: s.admin.email.trim(),
      name: s.admin.name.trim(),
      password: s.admin.password,
    };
  }
  if (!skipped.has('locale')) {
    out.locale = { timezone: s.locale.timezone, locale: s.locale.locale };
  }
  if (!skipped.has('departments')) {
    const rows = s.departments
      .map((d) => ({
        name: d.name.trim(),
        managerName: d.managerName.trim(),
        managerEmail: d.managerEmail.trim(),
      }))
      .filter((d) => d.name !== '');
    if (rows.length > 0) out.departments = rows;
  }
  if (!skipped.has('stages')) out.stages = s.stages.map((st) => ({ ...st }));
  if (!skipped.has('photos')) {
    out.photoChecklist = s.photos.map((p) => ({ ...p, placeTypes: [...p.placeTypes] }));
  }
  if (!skipped.has('map')) {
    out.map = {
      defaultLat: numOr(s.map.lat, D.mapDefaultLat),
      defaultLng: numOr(s.map.lng, D.mapDefaultLng),
      defaultZoom: numOr(s.map.zoom, D.mapDefaultZoom),
      geocodeProvider: s.map.provider,
      geocodeCountryCodes: s.map.countryCodes.trim(),
    };
  }
  if (!skipped.has('lookup')) {
    out.lookup = {
      enabled: s.lookup.enabled,
      label: s.lookup.label.trim(),
      urlTemplate: s.lookup.urlTemplate.trim(),
      fieldMap: { ...s.lookup.fieldMap },
      pattern: s.lookup.pattern.trim(),
    };
  }
  if (!skipped.has('appearance')) {
    out.appearance = {
      themeScheme: s.appearance.themeScheme,
      themeSidebar: s.appearance.themeSidebar,
      themeDefaultMode: s.appearance.themeDefaultMode,
      areaColors: { ...s.appearance.areaColors },
    };
  }
  return out;
}

// ── 各步驟畫面 ───────────────────────────────────────────────────────────

function StepBody({
  step,
  state,
  patch,
  skippedTitles,
}: {
  step: StepId;
  state: WizardState;
  patch: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void;
  skippedTitles: string[];
}) {
  switch (step) {
    case 'org':
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="組織全名" hint="出現在頁尾的版權列">
            <input
              type="text"
              className="input"
              value={state.org.name}
              onChange={(e) => patch('org', { ...state.org, name: e.target.value })}
            />
          </Field>
          <Field label="組織顯示名" hint="比較短的稱呼,站頭副標用">
            <input
              type="text"
              className="input"
              value={state.org.displayName}
              onChange={(e) => patch('org', { ...state.org, displayName: e.target.value })}
            />
          </Field>
          <Field label="產品名稱" hint={`系統自己的名字,預設 ${D.productName}`}>
            <input
              type="text"
              className="input"
              value={state.org.productName}
              onChange={(e) => patch('org', { ...state.org, productName: e.target.value })}
            />
          </Field>
          <Field label="站頭商標文字" hint="留空就用產品名稱">
            <input
              type="text"
              className="input"
              value={state.org.logoText}
              onChange={(e) => patch('org', { ...state.org, logoText: e.target.value })}
            />
          </Field>
        </div>
      );

    case 'admin':
      return (
        <div className="space-y-4">
          <p role="note" className="flash flash-info text-sm">
            這一步不能跳過:它沒有預設值,而且「系統裝好了沒」看的就是有沒有帳號。
            這裡填的就是第一個能登入後台的人,裝好之後馬上用這組帳號密碼登入。密碼至少 {PASSWORD_MIN}{' '}
            個字元,之後可以在「改密碼」自行更換。
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Email(登入帳號)">
              <input
                type="email"
                autoComplete="username"
                className="input"
                value={state.admin.email}
                onChange={(e) => patch('admin', { ...state.admin, email: e.target.value })}
              />
            </Field>
            <Field label="姓名">
              <input
                type="text"
                autoComplete="name"
                className="input"
                value={state.admin.name}
                onChange={(e) => patch('admin', { ...state.admin, name: e.target.value })}
              />
            </Field>
            <Field label="密碼" hint={`至少 ${PASSWORD_MIN} 個字元`}>
              <input
                type="password"
                autoComplete="new-password"
                className="input"
                value={state.admin.password}
                onChange={(e) => patch('admin', { ...state.admin, password: e.target.value })}
              />
            </Field>
            <Field label="再輸入一次密碼">
              <input
                type="password"
                autoComplete="new-password"
                className="input"
                value={state.admin.password2}
                onChange={(e) => patch('admin', { ...state.admin, password2: e.target.value })}
              />
            </Field>
          </div>
        </div>
      );

    case 'locale':
      return (
        <div className="space-y-4">
          <p role="note" className="flash flash-info text-sm">
            這一步跳過的話,時區就是預設的 {DEFAULT_TIME_ZONE}。時區決定打卡時間、
            日報的日期界線,以及存證照片浮水印上的時間與 GMT 位移 ——
            設錯的話照片會壓上錯的時間,而畫面上看不出來。之後可以在 「系統設定 → 時區與地區」改。
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <TimeZoneField
              value={state.locale.timezone}
              onChange={(v) => patch('locale', { ...state.locale, timezone: v })}
              hint="打卡時間、日報的日期界線、照片浮水印的時間都照這個時區算"
            />
            <LocaleField
              value={state.locale.locale}
              onChange={(v) => patch('locale', { ...state.locale, locale: v })}
              hint="目前只存起來備用:畫面上的日期一律用不依語系的固定格式,改這一欄不會改變顯示方式"
            />
          </div>
        </div>
      );

    case 'departments':
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            先開幾個部門就好,人可以之後再加。主管 Email 對不到已建立的帳號時,
            系統只會建部門、不指派主管。
          </p>
          <ul className="space-y-3">
            {state.departments.map((d, i) => (
              <li key={i} className="rounded-md border border-border p-3">
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label={`第 ${i + 1} 個部門名稱`}>
                    <input
                      type="text"
                      className="input"
                      value={d.name}
                      onChange={(e) => {
                        const next = [...state.departments];
                        next[i] = { ...d, name: e.target.value };
                        patch('departments', next);
                      }}
                    />
                  </Field>
                  <Field label={`第 ${i + 1} 個部門的主管姓名`}>
                    <input
                      type="text"
                      className="input"
                      value={d.managerName}
                      onChange={(e) => {
                        const next = [...state.departments];
                        next[i] = { ...d, managerName: e.target.value };
                        patch('departments', next);
                      }}
                    />
                  </Field>
                  <Field label={`第 ${i + 1} 個部門的主管 Email`}>
                    <input
                      type="email"
                      className="input"
                      value={d.managerEmail}
                      onChange={(e) => {
                        const next = [...state.departments];
                        next[i] = { ...d, managerEmail: e.target.value };
                        patch('departments', next);
                      }}
                    />
                  </Field>
                </div>
                <button
                  type="button"
                  className="btn btn-sm mt-2 min-h-[44px] px-3"
                  onClick={() =>
                    patch(
                      'departments',
                      state.departments.filter((_, j) => j !== i),
                    )
                  }
                >
                  移除第 {i + 1} 個部門
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn min-h-[44px] px-4"
            onClick={() =>
              patch('departments', [
                ...state.departments,
                { name: '', managerName: '', managerEmail: '' },
              ])
            }
          >
            新增一個部門
          </button>
        </div>
      );

    case 'stages':
      return (
        <StageEditor
          stages={state.stages}
          reservedKeys={RESERVED_STAGE_KEYS}
          onChange={(next) => patch('stages', next)}
        />
      );

    case 'photos':
      return (
        <PhotoChecklistEditor items={state.photos} onChange={(next) => patch('photos', next)} />
      );

    case 'map':
      return (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="拜訪地圖預設緯度" hint="打開地圖時鏡頭停在哪">
            <input
              type="number"
              step="0.0001"
              className="input"
              value={state.map.lat}
              onChange={(e) => patch('map', { ...state.map, lat: e.target.value })}
            />
          </Field>
          <Field label="拜訪地圖預設經度">
            <input
              type="number"
              step="0.0001"
              className="input"
              value={state.map.lng}
              onChange={(e) => patch('map', { ...state.map, lng: e.target.value })}
            />
          </Field>
          <Field label="預設縮放層級" hint="1 是整個地球,19 是看得到門牌">
            <input
              type="number"
              min="1"
              max="19"
              className="input"
              value={state.map.zoom}
              onChange={(e) => patch('map', { ...state.map, zoom: e.target.value })}
            />
          </Field>
          <Field label="地理編碼服務" hint="把客戶地址換成座標的服務">
            <select
              className="input"
              value={state.map.provider}
              onChange={(e) =>
                patch('map', {
                  ...state.map,
                  provider: e.target.value === 'none' ? 'none' : 'nominatim',
                })
              }
            >
              <option value="nominatim">OpenStreetMap Nominatim</option>
              <option value="none">不啟用(座標全部人工填)</option>
            </select>
          </Field>
          <Field
            label="限制國家"
            full
            hint="逗號分隔的兩碼國碼(ISO 3166-1 alpha-2),例如 tw 或 jp,kr。留空 = 不限制國家,也就是全世界都查"
          >
            <input
              type="text"
              inputMode="text"
              autoCapitalize="none"
              spellCheck={false}
              className="input font-mono"
              placeholder="留空 = 不限制"
              value={state.map.countryCodes}
              onChange={(e) => patch('map', { ...state.map, countryCodes: e.target.value })}
            />
          </Field>
        </div>
      );

    case 'lookup':
      return <LookupEditor value={state.lookup} onChange={(next) => patch('lookup', next)} />;

    case 'appearance':
      return (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="配色方案">
              <select
                className="input"
                value={state.appearance.themeScheme}
                onChange={(e) =>
                  patch('appearance', {
                    ...state.appearance,
                    themeScheme: e.target.value === 'B' ? 'B' : 'A',
                  })
                }
              >
                <option value="A">藍綠</option>
                <option value="B">赤陶</option>
              </select>
            </Field>
            <Field label="側欄底色">
              <select
                className="input"
                value={state.appearance.themeSidebar}
                onChange={(e) =>
                  patch('appearance', {
                    ...state.appearance,
                    themeSidebar: e.target.value === 'light' ? 'light' : 'dark',
                  })
                }
              >
                <option value="dark">深色</option>
                <option value="light">淺色</option>
              </select>
            </Field>
            <Field label="預設日夜模式" hint="每個人之後仍可自己切換">
              <select
                className="input"
                value={state.appearance.themeDefaultMode}
                onChange={(e) => {
                  const v = e.target.value;
                  patch('appearance', {
                    ...state.appearance,
                    themeDefaultMode: v === 'light' || v === 'dark' ? v : 'system',
                  });
                }}
              >
                <option value="system">跟隨作業系統</option>
                <option value="light">淺色</option>
                <option value="dark">深色</option>
              </select>
            </Field>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">功能區識別色</legend>
            <p className="text-sm text-muted-foreground">
              後台每一區用不同色系,讓人一眼知道自己在哪一區。
              只能從這五組挑,是因為每一組的對比在淺色、深色兩種模式都量過,
              自由填色碼很容易讓文字掉出無障礙標準。
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {(Object.keys(AREA_LABEL) as AreaKey[]).map((area) => (
                <Field key={area} label={AREA_LABEL[area]}>
                  <select
                    className="input"
                    value={state.appearance.areaColors[area]}
                    onChange={(e) =>
                      patch('appearance', {
                        ...state.appearance,
                        areaColors: {
                          ...state.appearance.areaColors,
                          [area]: e.target.value as ZoneName,
                        },
                      })
                    }
                  >
                    {ZONE_NAMES.map((z) => (
                      <option key={z} value={z}>
                        {ZONE_LABEL[z]}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          </fieldset>
        </div>
      );

    case 'done': {
      // 「精靈就不會再出現」只有在真的建了管理員帳號時才成立:
      // 後端的判準是 users 表有沒有人,沒建帳號就還是「未初始化」。
      const adminReady = adminFilled(state);
      return (
        <div className="space-y-3">
          {adminReady ? (
            <p className="text-sm">
              按下「完成安裝」之後,設定會寫進資料庫,管理員帳號({state.admin.email})
              會被建立,這個安裝精靈就不會再出現。
            </p>
          ) : (
            <p role="alert" className="flash flash-error text-sm">
              還不能完成安裝:「管理員帳號」那一步還沒填完。它沒有預設值,不填的話這次安裝
              不會建立任何帳號,沒有人登得進來,安裝精靈下次也還會出現。請回到第{' '}
              {ADMIN_STEP_INDEX + 1} 步填 Email 與密碼。
            </p>
          )}
          {skippedTitles.includes('時區與地區') ? (
            <p role="alert" className="flash flash-warning text-sm">
              時區那一步跳過了,系統會用預設的 {DEFAULT_TIME_ZONE}。
              打卡時間、日報的日期界線與存證照片浮水印上的時間都照這個時區算,
              不在這個時區的組織請登入後到「系統設定 → 時區與地區」改掉。
            </p>
          ) : null}
          {skippedTitles.length > 0 ? (
            <div>
              <p className="text-sm font-medium">跳過的步驟(會用預設值):</p>
              <ul className="mt-1 list-inside list-disc text-sm text-muted-foreground">
                {skippedTitles.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">每一步都填過了。</p>
          )}
          <p className="text-sm text-muted-foreground">
            全部項目之後都能在「系統設定」改,包含這裡填過的與跳過的。
          </p>
        </div>
      );
    }

    default:
      return null;
  }
}
