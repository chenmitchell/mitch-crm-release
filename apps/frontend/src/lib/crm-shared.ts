'use client';

// 客戶管理 CRM 各頁共用的型別、常數與小工具。
// 原本全部寫在 /admin/crm/page.tsx 裡,拆頁(new / search / board / stats / import)後集中在這裡,
// 避免同一份階段配色與 fetch 邏輯複製五份。
// 共用範圍:階段標籤/配色(來自後台設定)、客戶型別、角色 hook(useCrmRole)、看板載入、日期小工具。
// 無障礙:階段配色直接引用 globals.css 的 --st-* token,fg 對 bg 全部 >= 7:1,
//   map/page.tsx、visit-map.tsx、sales-charts.tsx 一律用 useStageMeta(),不要再複製一份。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useMemo } from 'react';
// 客戶清單與客戶卡的回應形狀是前後端共用的一份契約(packages/shared/src/api),
// 不在這裡手寫 interface —— 手寫的那一份與後端沒有任何編譯期的連結
import type { CustomerCardJson, CustomerListItemJson } from '@mitchcrm/shared';
import { getApiBase } from '@/lib/env';
import { useAppSettings, type StageDef } from '@/lib/app-settings';
import { useMeRole } from '@/lib/me-context';

/**
 * 階段的 key 由後台設定決定,所以型別就是字串。
 * 舊程式碼用 StageKey 當作固定聯集,現在改成別名,避免一次改動十幾個檔案的簽名。
 */
export type StageKey = string;

/** 一格階段的顯示資訊(由 /api/public/settings 供應,見 lib/app-settings.tsx) */
export type { StageDef } from '@/lib/app-settings';

export interface StageMeta {
  /** 全部階段,順序即後台設定的順序 */
  all: StageDef[];
  /** 進看板的階段(後台可逐項決定) */
  board: StageDef[];
  /** 新增/編輯表單下拉可選的階段 */
  form: StageDef[];
  /** 階段 key → 中文標籤;查不到就回原字串,不要顯示空白 */
  label: (key: string) => string;
  /** 階段 key → 配色(bg / border / fg 三件一組,對比由 --st-* token 保證 >= 7:1) */
  colors: (key: string) => StageColors;
  /** 這個 key 有沒有被設定過 */
  has: (key: string) => boolean;
}

export interface StageColors {
  bg: string;
  border: string;
  fg: string;
}

/** 由色組名組出三個 CSS 變數。色組定義在 globals.css 的 --st-*(淺深模式各一份) */
export function stageColorsOf(color: string): StageColors {
  return {
    bg: `var(--st-${color}-bg)`,
    border: `var(--st-${color}-bar)`,
    fg: `var(--st-${color}-fg)`,
  };
}

/**
 * 取得目前生效的階段設定。
 *
 * 全部 CRM 畫面都走這一支,不准再在畫面檔案裡寫死階段清單 ——
 * 階段是每間公司自己定的,寫死就等於別人裝了改不掉。
 */
export function useStageMeta(): StageMeta {
  const { stages } = useAppSettings();
  return useMemo(() => stageMetaOf(stages), [stages]);
}

/** 非 React 情境(工具函式、事件處理)用的同一份邏輯 */
export function stageMetaOf(stages: StageDef[]): StageMeta {
  const byKey = new Map(stages.map((s) => [s.key, s]));
  return {
    all: stages,
    board: stages.filter((s) => s.board),
    form: stages.filter((s) => s.form),
    label: (key) => byKey.get(key)?.label ?? key,
    colors: (key) => stageColorsOf(byKey.get(key)?.color ?? 'neutral'),
    has: (key) => byKey.has(key),
  };
}

/*
 * 這裡原本有一份寫死的 CATEGORIES(20 個中文分類),被新增客戶頁與客戶卡
 * 直接畫成下拉,後台完全改不到 —— 而「前台不得出現寫死的業務用語清單」
 * 正是這套系統的產品原則。分類已經改成與場所類型同構的主檔(dev_categories),
 * 讀法是 useCrmVocab() 的 categories,設定頁在 /admin/settings 的「商業分類」分頁。
 */

/**
 * 清單與看板的一列。
 *
 * 欄位不在這裡手寫,而是直接用共用契約 CustomerListItemJson ——
 * 這一份與後端 crm.service.ts 的 CUSTOMER_LIST_SELECT 是同一個型別的兩端,
 * 後端少 select 一格就在後端那一側編譯不過。以前兩邊各寫一份 interface,
 * 拿掉後端的欄位所有檢查都是綠的,畫面上那一格從此永遠是 undefined。
 *
 * note 另外接上去而且是選填:清單與看板的回應不帶它(最長 8000 字,清單一個字
 * 都不顯示),只有客戶卡的 GET /api/admin/crm/:id 會帶。
 */
export type DevCustomer = CustomerListItemJson & {
  note?: string | null;
};

/**
 * 客戶卡主體的欄位(GET /api/admin/crm/:id)。
 * 同樣來自共用契約;客戶卡另外帶的互動時間軸與 _count 由那一頁自己接上去。
 */
export type CrmCustomerCard = CustomerCardJson;

export type Board = Record<string, DevCustomer[]>;

/** 依目前設定的階段開出空看板(欄位由設定決定,不是寫死的七欄) */
export function emptyBoard(stages: StageDef[]): Board {
  const b: Board = {};
  for (const s of stages) b[s.key] = [];
  return b;
}

/** CRM API 前綴(不寫死埠號,由 NEXT_PUBLIC_API_BASE_URL 決定) */
export function crmApiBase(): string {
  return `${getApiBase()}/api/admin/crm`;
}

/** 可用 CRM 的角色 */
export function canUseCrm(role: string | null): boolean {
  return role === 'admin' || role === 'sales' || role === 'sales_manager';
}

/** 看得到全部業務資料的角色(同後端 isViewAll) */
export function isViewAllRole(role: string | null): boolean {
  return role === 'admin' || role === 'sales_manager';
}

/**
 * 讀目前登入者角色。role === null 表示還在載入,'' 表示讀不到(當作沒有權限)。
 *
 * 值來自 root layout 的 MeProvider(見 lib/me-context),這一支不自己打 /api/auth/me。
 * 收斂之前每一頁掛一個這個 hook 就多一次請求,而站頭、admin 外框與浮水印也各打一次 ——
 * 打開 /admin/crm/map 一次會發出四個一模一樣的請求。
 * 更麻煩的是那四份回應彼此可以不一致:其中一份 401、其他成功時,
 * 畫面會同時顯示使用者名稱與「你沒有權限」。
 */
export function useCrmRole(): string | null {
  return useMeRole();
}

/** 看板載入結果。truncated 表示筆數被後端上限切掉,畫面要說出來 */
export interface BoardResult {
  board: Board;
  /** 後端一次最多給幾筆 */
  take: number;
  /** 實際載到幾筆 */
  loaded: number;
  /** 還有客戶沒載進來 */
  truncated: boolean;
}

/**
 * 載入整份看板;失敗回 null(呼叫端顯示錯誤訊息)。
 *
 * 後端回的是 { stages, take, loaded, truncated }:看板沒有游標可以往下翻,
 * 超過上限時只能截斷,而截斷這件事一定要讓使用者知道 ——
 * 安靜截斷的看板會讓人以為「這一欄就這幾筆」。
 */
export async function fetchBoard(stages: StageDef[]): Promise<BoardResult | null> {
  const res = await fetch(`${crmApiBase()}/board`, { credentials: 'include' });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    stages?: Record<string, DevCustomer[] | undefined>;
    take?: number;
    loaded?: number;
    truncated?: boolean;
  };
  const out = emptyBoard(stages);
  for (const [key, rows] of Object.entries(data.stages ?? {})) {
    if (Array.isArray(rows)) out[key] = rows;
  }
  return {
    board: out,
    take: typeof data.take === 'number' ? data.take : 0,
    loaded: typeof data.loaded === 'number' ? data.loaded : 0,
    truncated: data.truncated === true,
  };
}

/** 清單載入結果。nextCursor 不為 null 代表還有下一頁 */
export interface CustomerListResult {
  rows: DevCustomer[];
  nextCursor: string | null;
}

/**
 * 載入客戶清單(GET /api/admin/crm);失敗回 null。
 *
 * 一律把 nextCursor 帶回去給呼叫端 —— 清單有筆數上限(後端預設 500),
 * 而丟掉 nextCursor 的結果是「超過上限的客戶在畫面上不存在,也沒有任何提示」。
 *
 * q 是秒查關鍵字,交給後端查;沒有它的話前端只能過濾已經載進來的那幾百筆。
 */
export async function fetchCustomers(
  opts: { ownerId?: string; q?: string; limit?: number; cursor?: string } = {},
): Promise<CustomerListResult | null> {
  const params = new URLSearchParams();
  if (opts.ownerId) params.set('ownerId', opts.ownerId);
  if (opts.q) params.set('q', opts.q);
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const qs = params.toString();
  const res = await fetch(`${crmApiBase()}${qs ? `?${qs}` : ''}`, { credentials: 'include' });
  if (!res.ok) return null;
  const data = (await res.json()) as { rows?: DevCustomer[]; nextCursor?: string | null };
  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}

export function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

/**
 * 月/日 與 年/月/日 時:分,以**組織時區**計。
 *
 * 實作在 lib/crm-dates.ts(純函式,測得到)。這兩個名字留著是因為好幾頁在用,
 * 改名會一路連坐;但時區必須由呼叫端傳進來 —— 這兩支原本用 getMonth() /
 * getDate() / getHours(),那是看畫面的人的**裝置時區**,而後端的逾期、
 * 地圖「今天要拜訪」與統計全部走組織時區,兩邊會差一天而且看不出來。
 * 時區從 useAppSettings().timezone 讀。
 */
export { fmtOrgShortDate as fmtShortDate, fmtOrgDateTime as fmtDateTime } from './crm-dates';
