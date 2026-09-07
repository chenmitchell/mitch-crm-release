/**
 * 客戶管理 CRM 的主要服務(客戶卡、清單、看板、互動、移交、成交、匯入)。
 *
 * ── 這個檔為什麼這麼大 ──────────────────────────────────────────
 * 這裡集中的是「同一筆客戶列」上的所有寫入路徑。它們共用同一把列鎖
 * (lock.ts 的 lockCustomerRow)與同一組階段規則,拆成幾支服務之後,
 * 鎖與規則就會各拿一份,而這一類 check-then-act 的競態不會有錯誤訊息:
 * 兩個請求各自讀到舊資料、各自覺得合法,最後一筆寫進去的贏。
 * 拆檔要連鎖一起搬,不是把 method 剪貼出去就好。
 *
 * ── 三條貫穿整個檔的規則 ────────────────────────────────────────
 * 1. **業務語彙一律查主檔,不寫死。** 階段查 dev_stages(StageCatalogService)、
 *    互動管道查 dev_interaction_channels、場所類型查 dev_premises_types、
 *    商業分類查 dev_categories。寫死清單編譯得過、測試也綠,
 *    要等管理員第一次改設定才爆,而且是安靜地爆。
 * 2. **「今天」一律問 OrgTimeService。** 日報、排程、逾期追蹤的日界線是組織設定的時區,
 *    不是伺服器的本地時間,也不是 UTC。
 * 3. **失敗要說話。** 匯入查不到的進度與分類進錯誤報表、成交缺照片擋下來並列出缺哪幾項。
 *    安靜地退回預設值是這個模組最容易犯、也最難被發現的錯。
 *
 * 存取範圍(誰看得到誰的客戶)由 ../scope/view-scope.ts 一處算出,這裡只依它組 where。
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  orgDateKey,
  orgDateParts,
  orgDayRange,
  orgPeriodStart,
  resolveTimeZone,
} from '@mitchcrm/shared';
// 清單與客戶卡的回應形狀是前後端共用的一份契約(packages/shared/src/api)。
// 這裡 import 的是型別,編譯後不留任何東西;它的作用是讓下面的 select
// 與前端的畫面型別對同一份負責,少給一格就編譯不過。
import type {
  AssertAssignable,
  CustomerCardRow,
  CustomerListItemRow,
  CustomerListSelectShape,
} from '@mitchcrm/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrgTimeService } from '../settings/org-time.service';
import {
  SYSTEM_NOTE_PREFIX,
  photoRequirementState,
  missingPhotoKinds,
  type PhotoChecklist,
  systemPrefixBlockReason,
} from './checkin/checkin-rules';
import { CrmGeoService, pickAddress } from './map/crm-geo.service';
import { SettingsService } from '../settings/settings.service';
import { lockCustomerRow } from './lock';
import { isCaseRefUniqueViolation } from './case-ref-conflict';
import { CASE_REF_TAKEN_MESSAGE } from './deletion/crm-deletion-rules';
import { IMPORT_MAX_ROWS } from './dto/import-rows.dto';
import { TRANSFER_BATCH_MAX } from './dto/transfer-batch.dto';
import {
  CONVERTED_NOTE_PREFIX,
  CUSTOMER_NOT_FOUND_MESSAGE,
  INTERACTIONS_TAKE,
  MERGED_CUSTOMER_MESSAGE,
  mergedCustomerError,
} from './crm-messages';
import { randomUUID } from 'node:crypto';
import {
  authorFilter,
  canSeeOwner,
  ownOnlyScope,
  ownerFilter,
  type ViewScope,
} from '../scope/view-scope';
import {
  convertedInteractionWhere,
  countableCustomerWhere,
  humanInteractionWhere,
  liveCustomerFilter,
  overdueCustomerWhere,
  relatedLiveCustomerFilter,
  suspiciousVisitWhere,
  visitInteractionWhere,
} from './crm-scope-filters';
import {
  DEFAULT_STAGE_CATALOG,
  LOST_STAGE_KEY,
  StageCatalogService,
  WON_STAGE_KEY,
} from '../app-settings/stage-catalog.service';
import { LOOKUP_DEFAULT_LABEL, SETTINGS_KEY_PATTERN } from '../app-settings/app-settings.view';
// UUID 格式的判準全後端共用一份(見 common/uuid.ts),不要在檔案裡再寫一條正規表示式。
// 這裡兩條都要:UUID_RE 是嚴格版(擋我們自己產生的 id),LOOSE_UUID_RE 是寬鬆版
// (放行外部系統送來的案件編號,理由見 common/uuid.ts 的註解)。
import { UUID_RE, LOOSE_UUID_RE } from '../common/uuid';
import {
  DEFAULT_INTERACTION_CHANNELS,
  DEFAULT_PREMISES_TYPES,
  DEFAULT_VISIT_PHOTO_KINDS,
  NOTE_CHANNEL_KEY,
  VISIT_CHANNEL_KEY,
} from '@mitchcrm/shared';

/** 階段 key 的格式,與 app-settings 的 key 規則一致 */
/** 代碼格式與後台設定、前端用的是同一條規則(見 app-settings.view) */
const STAGE_KEY_RE = SETTINGS_KEY_PATTERN;

/**
 * 客戶管理 CRM 服務。
 * 存取範圍一律由 ViewScope 決定(自己 / 團隊與部門子樹 / 全部),見 ../scope/view-scope.ts。
 * 移交只改 ownerId,接手者的清單自動顯示(不另通知)。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

type Stage = string;

/**
 * 互動管道與場所類型都是可設定的主檔(dev_interaction_channels / dev_premises_types),
 * 所以型別就是字串,合法值一律查資料表。
 * 這裡不留任何一份寫死的清單:留了的話,後台新增的管道會被程式擋掉,
 * 而使用者看到的是「選了送出以後變成備註」,畫面上看不出原因。
 */
type Channel = string;
type PremisesType = string;

/** 主檔一列的顯示資料。管道與場所類型共用同一種形狀 */
export interface VocabDisplay {
  key: string;
  label: string;
}

/** 出廠的互動管道與場所類型,只在讀不到主檔時當保底 */
const DEFAULT_CHANNEL_DISPLAY: VocabDisplay[] = DEFAULT_INTERACTION_CHANNELS.map((c) => ({
  key: c.key,
  label: c.label,
}));
const DEFAULT_PREMISES_DISPLAY: VocabDisplay[] = DEFAULT_PREMISES_TYPES.map((p) => ({
  key: p.key,
  label: p.label,
}));

/** 照片種類的顯示資料:名稱與排序。呼叫端從 visit_photo_kinds 讀,讀不到才用出廠預設 */
export interface PhotoKindDisplay {
  key: string;
  label: string;
  sortOrder: number;
}

/** 出廠的照片種類顯示資料(來自 @mitchcrm/shared),只當讀不到主檔時的保底 */
export const DEFAULT_PHOTO_KIND_DISPLAY: PhotoKindDisplay[] = DEFAULT_VISIT_PHOTO_KINDS.map(
  (k) => ({
    key: k.key,
    label: k.label,
    sortOrder: k.sortOrder,
  }),
);

/**
 * 存證照片類型串成中文(依後台排序、頓號分隔),給錯誤訊息與互動歷程共用。
 *
 * 順序與名稱都吃 visit_photo_kinds 主檔,不寫死七個代碼:寫死的話,
 * 管理員新增的種類會排在最前面(indexOf 回 -1),名稱還會印成英文代碼,
 * 而使用者看到的就是一句「還缺:meter」。
 * 主檔裡沒有的代碼(停用過的歷史照片)排在最後,名稱退回代碼本身。
 */
export function photoKindsZh(
  kinds: readonly string[],
  catalog: readonly PhotoKindDisplay[] = DEFAULT_PHOTO_KIND_DISPLAY,
): string {
  const order = new Map(catalog.map((k, i) => [k.key, k.sortOrder * 1000 + i]));
  const label = new Map(catalog.map((k) => [k.key, k.label]));
  const last = Number.MAX_SAFE_INTEGER;
  const uniq = [...new Set(kinds)].sort((a, b) => (order.get(a) ?? last) - (order.get(b) ?? last));
  return uniq.map((k) => label.get(k) ?? k).join('、');
}

/**
 * 結案前檢查的純函式:premisesType 沒選、或必備照片缺項,就回一句可直接顯示給業務看的錯誤訊息;通過回 null。
 * 抽出來是為了單元測試(crm-convert-check.spec.ts)不用碰 DB。
 */
/** 場所類型代碼 → 顯示名稱;主檔裡沒有就退回代碼本身(訊息不會變成空白) */
export function premisesLabelOf(
  catalog: readonly VocabDisplay[],
  key: string | null | undefined,
): string {
  if (!key) return '';
  return catalog.find((p) => p.key === key)?.label ?? key;
}

/**
 * 必拍清單沒設定時擋下來的訊息。
 *
 * 分兩句講:設定頁只有系統管理員進得去,對站在現場的訪查人員說「請先到後台的
 * 照片存證檢查表勾選至少一項」,他找不到那一頁,也不知道要找誰,等於沒有下一步。
 * canConfigure 由呼叫端依可見範圍給(viewAll 只有系統管理員會是 true)。
 */
export function checklistNotConfiguredMessage(premisesLabel: string, canConfigure = true): string {
  if (!canConfigure) {
    return `這種場所類型(${premisesLabel})還沒設定要拍哪些照片,請聯絡系統管理員設定後再標記成交`;
  }
  return `此場所類型(${premisesLabel})尚未設定必拍清單,請先到後台的照片存證檢查表勾選至少一項,或把它設為「不需照片存證」,再標記成交`;
}

/**
 * 成交守衛。三種場所狀態走三條路(見 checkin-rules 的 photoRequirementState):
 *
 *   required 有必拍項目 → 缺件就擋,訊息列出還缺哪幾種
 *   exempt   管理員明確設過「這個場所不需照片存證」→ 放行,一張都不用拍
 *   unset    沒有必拍項目、也沒有被設為豁免 → 擋下,並告訴管理員兩條路各要去哪裡設
 *
 * exempt 與 unset 一定要分開:兩者在檢查表裡看起來都是一份空的必拍清單,
 * 合在一起處理的話,不是漏掉「新增場所忘了設必拍」的洞,就是後台永遠設不出
 * 一個真的不用拍照的場所類型。
 */
export function convertBlockReason(
  premisesType: string | null | undefined,
  kindsPresent: readonly string[],
  checklist?: PhotoChecklist,
  catalog?: readonly PhotoKindDisplay[],
  premisesLabel?: string,
  exemptPremises: readonly string[] = [],
  /** 看訊息的人自己設定得了必拍清單嗎(只有系統管理員可以),決定用哪一句話 */
  canConfigure = true,
): string | null {
  if (!premisesType) return '請先在客戶資料選擇場所類型,再標記成交';
  const state = photoRequirementState(premisesType, checklist, exemptPremises);
  if (state === 'exempt') return null;
  if (state === 'unset')
    return checklistNotConfiguredMessage(premisesLabel ?? premisesType, canConfigure);
  const missing = missingPhotoKinds(premisesType, kindsPresent, checklist);
  if (missing.length) return `標記成交前必須有存證照片,還缺:${photoKindsZh(missing, catalog)}`;
  return null;
}

/**
 * 匯入的「進度」欄填的是階段標籤,不是代碼,所以要一份「標籤 → 代碼」的對照。
 *
 * 這份對照由 dev_stages 現況產生(見 CrmService.stageLabelMap),不寫死 ——
 * 寫死的話,管理員把「報價中」改名「議價中」之後,匯入查不到就安靜降階成第一階,
 * 使用者看到的是「匯入成功」,實際上整批客戶的進度都被洗掉了。
 *
 * 這裡只留舊名的相容別名:出廠的「名單」曾經叫「名單/陌生」,
 * 舊檔案還在使用者手上,查不到就當成錯誤回報反而是退步。
 * 別名只在「目前的階段標籤都對不上」時才用。
 */
const LEGACY_STAGE_LABEL_ALIASES: Record<string, string> = {
  '名單/陌生': '名單',
};

/**
 * 匯入的錯誤報表最多列幾種查不到的名稱(進度與商業分類共用),
 * 其餘用「等 N 種」帶過,訊息才不會長到看不完
 */
const UNKNOWN_STAGE_LABELS_SHOWN = 5;
/**
 * 一次回傳幾筆「第幾列第幾欄」的細項。上限存在的理由是回應大小,不是隱藏資訊:
 * 總筆數另外用 errorCount 回,前端會顯示「還有 N 筆」。
 */
const IMPORT_ERRORS_RETURNED = 50;
/** 匯入一次的筆數上限(與 ImportRowsDto 的 ArrayMaxSize 同一個常數)與分段寫入的每段筆數 */
const IMPORT_CHUNK = 100;

/** 系統紀錄前綴「【」與備註前綴檢查定義在 checkin/checkin-rules.ts,手動互動與打卡共用;這裡 re-export 給既有引用 */
export { SYSTEM_NOTE_PREFIX };

/** 已成交的判定:stage=converted 或已填外部案件編號,任一成立就算 */
export function isConvertedCustomer(c: { stage: string; externalCaseRef: string | null }): boolean {
  return c.stage === WON_STAGE_KEY || c.externalCaseRef !== null;
}
export const CONVERTED_ALREADY_MESSAGE = '此客戶已成交,不可重複標記';
export const CONVERTED_ALREADY_REASON = '此客戶已成交';

// MERGED_CUSTOMER_MESSAGE 抽到 crm-messages.ts(checkin 也要用,不該為了一句訊息 import 整個 CrmService),
// 這裡 re-export 讓既有的 import 路徑不用全改
export { MERGED_CUSTOMER_MESSAGE, mergedCustomerError } from './crm-messages';

/** 可以接手客戶的角色;其他角色看不到 CRM,接手就是把客戶變成孤兒 */
export const TRANSFERABLE_ROLES = ['sales', 'sales_manager'] as const;
/**
 * 接手者不合格時的統一訊息。
 *
 * 「帳號不存在」「不是業務」「已停用」「不在你的可見範圍」四種情形都回這一句,
 * 而且不提任何一種的名字。分開回的話,拿任意 uuid 逐一送移交就能問出
 * 「這個 id 是不是一個啟用中的業務帳號」,那是一個帳號枚舉的管道;
 * 對訪查主管來說,也等於可以問出別的團隊有哪些人。
 * 合法的接手者一律來自 GET /crm/sales-users(同一套 ViewScope),所以正常操作看不到這句。
 */
export const TRANSFER_TARGET_MESSAGE = '找不到可接手的人員,請從轉派清單重新挑選';

/**
 * 一般編輯(PATCH)改 stage 的規則,純函式方便測試:
 * - 沒帶 stage、或帶的跟現在一樣(冪等,含 converted→converted)一律放行
 * - 不能把 stage 改成 converted(要走成交流程,才有場所類型與存證照片檢查)
 * - 已成交的客戶(stage=converted 或已填外部案件編號)不能退回其他階段
 * 回傳錯誤訊息;允許時回 null。
 */
export function stageChangeBlockReason(
  current: { stage: string; externalCaseRef: string | null },
  nextStage: string | undefined,
): string | null {
  if (nextStage === undefined || nextStage === current.stage) return null;
  if (nextStage === WON_STAGE_KEY) return '標記成交請透過客戶卡的「標記為成交」流程';
  if (isConvertedCustomer(current)) return '已成交的客戶不可退回其他階段';
  return null;
}

/**
 * 使用者手動新增互動的限制,純函式方便測試:
 * - channel=visit 只能由外勤拜訪打卡寫入(要 GPS 與照片)
 * - note 不能以「【」開頭,這個符號保留給系統紀錄(報表用它辨識成交等事件)
 */
export function interactionBlockReason(channel: unknown, note: unknown): string | null {
  if (channel === VISIT_CHANNEL_KEY) return '拜訪打卡請到外勤拜訪頁進行';
  return systemPrefixBlockReason(note);
}

/** 手動互動的發生時間不可晚於伺服器時間(允許 1 分鐘時鐘誤差);違規回錯誤訊息 */
export const OCCURRED_AT_FUTURE_TOLERANCE_MS = 60 * 1000;
export function occurredAtBlockReason(occurredAt: Date, serverTime: Date): string | null {
  if (Number.isNaN(occurredAt.getTime())) return '發生時間格式錯誤';
  if (occurredAt.getTime() - serverTime.getTime() > OCCURRED_AT_FUTURE_TOLERANCE_MS)
    return '發生時間不可晚於現在';
  return null;
}

const ADDRESS_FIELDS = ['registeredAddress', 'actualAddress', 'contactAddress'] as const;
const ADDRESS_LABEL: Record<(typeof ADDRESS_FIELDS)[number], string> = {
  registeredAddress: '登記地址',
  actualAddress: '實際營業地址',
  contactAddress: '聯絡地址',
};

/**
 * 找出這次更新有變動的地址欄位,組成系統紀錄的文字(每個欄位一行)。沒變動回空陣列。
 * 座標要不要清另由 geocodeAddressChanged 判斷(只有地圖實際用的那個地址變了才清)。
 */
type AddressFields = Partial<Record<(typeof ADDRESS_FIELDS)[number], unknown>>;
const addrStr = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/**
 * 地圖用的地址(pickAddress:實際營業地址 > 登記地址 > 聯絡地址,正規化後)更新前後是否不同。
 * 只有這個不同,舊的地理編碼才不可信,才要把 lat / lng / geocodedAt 清掉讓地圖重新編碼;
 * 改到沒被採用的欄位(例如有實際地址時只改聯絡地址)不清。
 */
export function geocodeAddressChanged(before: AddressFields, after: AddressFields): boolean {
  const merged: Record<(typeof ADDRESS_FIELDS)[number], string | null> = {
    registeredAddress: null,
    actualAddress: null,
    contactAddress: null,
  };
  const prev = { ...merged };
  for (const k of ADDRESS_FIELDS) {
    prev[k] = addrStr(before[k]);
    merged[k] = after[k] === undefined ? prev[k] : addrStr(after[k]);
  }
  return pickAddress(prev) !== pickAddress(merged);
}
export function addressChangeLines(before: AddressFields, after: AddressFields): string[] {
  const lines: string[] = [];
  for (const k of ADDRESS_FIELDS) {
    if (after[k] === undefined) continue; // 這次沒帶
    const oldV = (before[k] as string | null | undefined) ?? null;
    const newV = (after[k] as string | null | undefined) ?? null;
    if (oldV === newV) continue;
    lines.push(
      `${SYSTEM_NOTE_PREFIX}地址變更】${ADDRESS_LABEL[k]}:${oldV ?? '(空)'} → ${newV ?? '(空)'}`,
    );
  }
  return lines;
}

/**
 * 清單一次最多幾筆,以及看板一次最多幾筆。
 *
 * 上限只有一個(CUSTOMER_LIST_TAKE_MAX),看板用的是同一個上限。
 * 原本 BOARD_TAKE 寫 2000、clampListTake 的上限是 1000,而看板走的正是
 * clampListTake,所以看板實際上限一直都是 1000 —— 那個 2000 是一個會說謊的常數:
 * 讀程式的人以為看板放寬到兩千筆,實際上第 1001 筆起就被安靜切掉。
 * 要放寬就一起放寬,不要靠兩個對不上的數字表達。
 *
 * 沒有上限不是選項:那會變成一支把整張表吐給瀏覽器的端點。上限存在的代價
 * 由呼叫端負責講清楚 —— 清單有 nextCursor 可以往下翻,看板回 truncated 讓畫面明說。
 */
export const CUSTOMER_LIST_TAKE_DEFAULT = 500;
export const CUSTOMER_LIST_TAKE_MAX = 1000;
export const BOARD_TAKE = CUSTOMER_LIST_TAKE_MAX;
/** 工作報告的清單只顯示前 12 筆(數字用 count,不受這個上限影響) */
export const REPORT_LIST_TAKE = 12;

/** limit 收斂到 1..CUSTOMER_LIST_TAKE_MAX;沒帶或不是正整數就用預設 */
export function clampListTake(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return CUSTOMER_LIST_TAKE_DEFAULT;
  const n = Math.floor(limit);
  if (n < 1) return CUSTOMER_LIST_TAKE_DEFAULT;
  return Math.min(n, CUSTOMER_LIST_TAKE_MAX);
}

/** 秒查關鍵字的長度上限:再長也沒有意義,而且 contains 會愈掃愈慢 */
export const SEARCH_QUERY_MAX = 64;

/**
 * 秒查的 where 片段:公司名 / 識別碼 / 聯絡人 / 電話任一片段命中就算。
 *
 * 為什麼要有這一支:秒查原本是把客戶「整批」撈到前端再用 JS 過濾,而清單預設
 * 只給 500 筆,所以第 501 筆起的客戶用秒查永遠找不到,畫面上也不會說少了什麼。
 * 關鍵字丟給資料庫查,找得到的就是全部。
 *
 * 電話與識別碼另外用「只留數字」的版本再比一次:使用者輸入 0912-345 而資料庫存
 * 0912345 的話,單靠原字串會查不到。反之資料庫存分隔符號、使用者打純數字這一種,
 * 需要在 SQL 端去掉分隔符號才能比對,那要 DB 函式,這裡不做 —— 有此限制,
 * 不是「看起來會查到」卻默默漏掉。
 */
export function searchCustomerWhere(q: string): Prisma.DevCustomerWhereInput | null {
  const raw = q.trim().slice(0, SEARCH_QUERY_MAX);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const or: Prisma.DevCustomerWhereInput[] = [
    { companyName: { contains: raw, mode: 'insensitive' } },
    { contactName: { contains: raw, mode: 'insensitive' } },
    { taxId: { contains: raw } },
    { contactPhone: { contains: raw } },
  ];
  if (digits && digits !== raw) {
    or.push({ taxId: { contains: digits } }, { contactPhone: { contains: digits } });
  }
  return { OR: or };
}

/**
 * 清單與看板要的欄位。
 *
 * 刻意逐格列出而不是用 include:預設會把所有純量欄位帶上,其中 note 最長 8000 字,
 * 而清單與看板一個字都不顯示。列在這裡的話,之後有人在資料表加一個大欄位,
 * 清單不會安靜地跟著變大。
 */
export const CUSTOMER_LIST_SELECT = {
  id: true,
  taxId: true,
  companyName: true,
  representative: true,
  registeredAddress: true,
  actualAddress: true,
  contactAddress: true,
  website: true,
  social: true,
  category: true,
  stage: true,
  source: true,
  contactName: true,
  contactPhone: true,
  ownerId: true,
  nextFollowUpAt: true,
  lastContactAt: true,
  externalCaseRef: true,
  lat: true,
  lng: true,
  premisesType: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true } },
  // CustomerListSelectShape 由共用契約反推:契約裡的每一格在這裡都必須是 true。
  // 拿掉任何一格(例如 representative),錯誤就出現在這一行,而不是等到
  // 畫面上那一欄永遠空白才有人發現。
} satisfies Prisma.DevCustomerSelect & CustomerListSelectShape;

export type CustomerListRow = Prisma.DevCustomerGetPayload<{
  select: typeof CUSTOMER_LIST_SELECT;
}>;

/**
 * 清單實際回應的型別必須符合共用契約。
 *
 * 上面的 satisfies 守的是「select 有沒有列到」,這一行守的是「列到的東西型別對不對」
 * (欄位改型別、關聯的 select 少帶一格,都在這一行報錯)。
 * 這是型別層的宣告,沒有人讀它,編譯後不留任何程式碼。
 */
type _CustomerListRowMatchesContract = AssertAssignable<CustomerListRow, CustomerListItemRow>;

/** 各訪查人員開發中筆數的一列(GET /api/admin/crm/by-sales) */
export interface SalesRollupRow {
  salesId: string;
  salesName: string;
  /** 帳號還啟用嗎;false = 已停用的離職帳號,客戶仍計入,由畫面標示 */
  active: boolean;
  inDev: number;
  interested: number;
  overdue: number;
}

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  // CrmGeoService 用 @Optional:單元測試直接 new CrmService(prisma) 不必帶;沒有就不排背景補座標
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly geo?: CrmGeoService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly stageCatalog?: StageCatalogService,
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /** 組織設定的時區;沒注入 OrgTimeService(單元測試直接 new)就退回出廠時區 */
  private async timeZone(): Promise<string> {
    return this.orgTime ? this.orgTime.timeZone() : resolveTimeZone(null);
  }

  /** 目前的階段目錄;沒有目錄服務(單元測試)就用出廠清單 */
  private async stageCatalogEntries() {
    if (!this.stageCatalog) return [...DEFAULT_STAGE_CATALOG];
    return this.stageCatalog.all();
  }

  /**
   * 「識別碼或公司名至少填一個」的訊息。
   *
   * 識別碼那一格在各地叫什麼由後台設定(lookupLabel)決定,不能寫死成某一個地區的正式名稱,
   * 這套系統要能裝在任何地方。讀不到設定就用通用說法。
   */
  private async identifierRequiredMessage(): Promise<string> {
    let label = LOOKUP_DEFAULT_LABEL;
    try {
      const configured = (await this.settings?.get())?.lookupLabel?.trim();
      if (configured) label = configured;
    } catch {
      // 讀不到設定不該讓建檔整支掛掉
    }
    return `${label}或公司名稱至少要填一個`;
  }

  /** 目前採用的照片存證檢查表:先看系統設定,讀不到就用出廠預設(見 checkin-rules) */
  private async photoChecklist(): Promise<PhotoChecklist | undefined> {
    if (!this.settings) return undefined;
    try {
      const s = await this.settings.get();
      const list = s.photoChecklist;
      if (list && typeof list === 'object') return list;
    } catch {
      // 讀不到設定就用出廠預設,不要讓成交流程整個停掉
    }
    return undefined;
  }

  /**
   * 明確被設為「不需照片存證」的場所類型。
   * 讀不到設定就回空陣列 —— 讀不到的時候要往「擋下來」那一邊倒,
   * 不是往「放行」那一邊,否則設定服務一出問題就等於全面解除成交守衛。
   */
  private async photoExemptPremises(): Promise<string[]> {
    if (!this.settings) return [];
    try {
      const s = await this.settings.get();
      return Array.isArray(s.photoExemptPremises)
        ? s.photoExemptPremises.filter((k): k is string => typeof k === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * 目前的照片種類主檔(名稱與排序)。讀不到就用出廠預設 ——
   * 讓成交流程因為讀不到一份「顯示用」的清單而整個停掉並不合理。
   */
  private async photoKindCatalog(
    tx?: Pick<PrismaService, 'visitPhotoKind'>,
  ): Promise<PhotoKindDisplay[]> {
    try {
      const rows = await (tx ?? this.prisma).visitPhotoKind.findMany({
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true },
      });
      if (rows.length > 0) return rows as PhotoKindDisplay[];
    } catch {
      // 讀不到主檔就用出廠預設
    }
    return [...DEFAULT_PHOTO_KIND_DISPLAY];
  }

  /** 新增或改了地圖用地址後,排背景補座標;任何失敗只記 log,不影響主流程 */
  private scheduleGeocode(customer: {
    id: string;
    actualAddress: string | null;
    registeredAddress: string | null;
    contactAddress: string | null;
  }) {
    if (!this.geo) return;
    try {
      if (pickAddress(customer)) this.geo.scheduleGeocode(customer.id);
    } catch {
      // 排程失敗不影響新增/更新結果
    }
  }

  /**
   * 輸入的階段 key:格式對就照收(實際存不存在由 assertStageKey 對資料表檢查),
   * 否則落回流程的第一階。第一階是查表來的,不是寫死的 lead ——
   * 後台把第一階換成別的代碼之後,寫死的落點會變成一個不存在的階段。
   */
  private async stageOf(v: unknown): Promise<Stage> {
    const k = typeof v === 'string' ? v.trim() : '';
    if (STAGE_KEY_RE.test(k)) return k;
    const entries = await this.stageCatalogEntries();
    return entries[0]?.key ?? DEFAULT_STAGE_CATALOG[0]!.key;
  }

  /**
   * 階段 key 必須是 dev_stages 裡啟用中的一筆。
   *
   * 不檢查的話,打錯字的 key 會被存進客戶資料,而那位客戶從此不屬於任何一個看板欄位,
   * 畫面上就是「客戶不見了」,沒有任何錯誤訊息。
   * 資料表讀不到(遷移還沒跑完)就放行:擋下來會讓整個 CRM 不能新增客戶,那更糟。
   */
  private async assertStageKey(key: string): Promise<void> {
    try {
      const rows = await this.prisma.devStage.findMany({ select: { key: true, isActive: true } });
      if (rows.length === 0) return;
      const ok = rows.some((r: { key: string; isActive: boolean }) => r.key === key && r.isActive);
      if (!ok) throw new BadRequestException(`沒有這個客戶階段:${key}`);
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      // 讀不到階段主檔就不擋,理由見上面
    }
  }
  /**
   * 輸入的管道代碼:對得上啟用中的管道就照收,否則落回保留的 note。
   *
   * 落回 note 而不是回 400,是為了與可設定之前的行為一致(舊前端送舊代碼不該整筆失敗),
   * 而 note 是保留管道,一定存在。清單一律查主檔,不比對寫死的陣列。
   */
  private async channelOf(v: unknown): Promise<Channel> {
    const k = typeof v === 'string' ? v.trim() : '';
    const known = await this.channelCatalog();
    return known.some((c) => c.key === k) ? k : NOTE_CHANNEL_KEY;
  }

  /**
   * 互動管道主檔(名稱與排序)。讀不到或是空的就用出廠預設 ——
   * 讓新增互動因為讀不到一份顯示用清單而整個停掉並不合理。
   */
  private async channelCatalog(
    tx?: Pick<PrismaService, 'devInteractionChannel'>,
  ): Promise<VocabDisplay[]> {
    const db = tx ?? this.prisma;
    try {
      const rows = await db.devInteractionChannel.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true },
      });
      if (rows.length > 0) return rows as VocabDisplay[];
    } catch {
      // 讀不到主檔就用出廠預設
    }
    return [...DEFAULT_CHANNEL_DISPLAY];
  }

  /** 場所類型主檔。理由同 channelCatalog */
  private async premisesCatalog(): Promise<VocabDisplay[]> {
    try {
      const rows = await this.prisma.devPremisesType.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true },
      });
      if (rows.length > 0) return rows as VocabDisplay[];
    } catch {
      // 讀不到主檔就用出廠預設
    }
    return [...DEFAULT_PREMISES_DISPLAY];
  }

  /**
   * 商業分類主檔(dev_categories)。停用的也一起讀。
   *
   * 為什麼連停用的都讀:這一份是拿來**驗證**匯入的值,不是拿來給人選的。
   * 管理員把某個分類停用之後,既有客戶身上仍然掛著那個代碼,重新匯出再匯入
   * 不該被判成「不在主檔裡」。要給人選的清單另外查(where isActive),兩者用途不同。
   *
   * 讀不到主檔就回空陣列,呼叫端會當成「沒有主檔可比對」而全部放行 ——
   * 一格設定讀不到不該讓整批匯入失敗。
   */
  private async categoryCatalog(): Promise<VocabDisplay[]> {
    try {
      const rows = await this.prisma.devCategory.findMany({
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true },
      });
      return rows as VocabDisplay[];
    } catch {
      return [];
    }
  }

  /**
   * 匯入的分類欄位:名稱或代碼 → dev_categories 的代碼。
   *
   * 與階段的 stageLabelMap 同一套做法,理由也一樣:範本 xlsx 的下拉是**出廠分類的
   * 靜態快照**,組織換成自己的分類之後,拿舊範本填的人會匯進一批不在主檔裡的值。
   * 那些值在畫面上會退回顯示原字串,看起來「正常」,於是主檔實際上不再是權威來源,
   * 而且沒有任何一個地方會提示這件事。查不到就進錯誤報表,不安靜寫進去。
   */
  private async categoryKeyMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const rows = await this.categoryCatalog();
    for (const c of rows) {
      const label = c.label.trim();
      if (label && !out.has(label)) out.set(label, c.key);
    }
    for (const c of rows) if (!out.has(c.key)) out.set(c.key, c.key);
    return out;
  }
  private s(v: unknown): string | null {
    const t = (v ?? '').toString().trim();
    return t.length ? t : null;
  }
  /**
   * 場所類型:只收 dev_premises_types 裡啟用中的代碼,其他值(含空字串)視為未填 → null。
   * 清單查主檔,後台新增的場所類型立刻可以用。
   */
  private async premisesOf(v: unknown): Promise<PremisesType | null> {
    const k = typeof v === 'string' ? v.trim() : '';
    if (!k) return null;
    const known = await this.premisesCatalog();
    return known.some((p) => p.key === k) ? k : null;
  }

  /**
   * 客戶清單。
   *
   * 一定帶 take,而且不回 note:
   *   沒有上限的話,一位主管的清單就是他團隊的全部客戶,一次全吐;
   *   note 是 Text 欄位(前端限 8000 字),清單上一個字都不會顯示,
   *   卻是整包回應裡最大的一塊。同專案其他清單都有上限(地圖 2000、
   *   日報 2000、排程 1000),這一支之前是漏網的。
   *
   * 游標分頁:orderBy 的最後一段是 id,讓排序是唯一的 —— 只用
   * nextFollowUpAt / updatedAt 排的話,值相同的幾筆在兩次查詢之間可能換位置,
   * 游標翻頁就會跳過或重複某幾筆,而畫面上看不出來。
   */
  async list(
    userId: string,
    view: ViewScope,
    opts: { stage?: string; ownerId?: string; q?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ rows: CustomerListRow[]; nextCursor: string | null }> {
    // 已被合併的客戶(mergedIntoId 不為 null)不進清單與看板,資料都在保留的那筆
    // countableCustomerWhere:已被合併的那筆(內容在保留筆上)與已被刪掉的那筆都不進清單
    const where: Record<string, unknown> = { ...countableCustomerWhere(), ...ownerFilter(view) };
    // 看得到多個人的時候才允許再指定某一位;否則沿用範圍本身,不讓人用 query 參數越權。
    //
    // 先過 UUID 格式:owner_id 在資料庫是 uuid 欄位,admin 傳一個 `?ownerId=abc`
    // 會讓 Prisma 在轉型時丟例外,結果是 500 加一列 error_logs —— 那是輸入問題,
    // 不該變成伺服器錯誤。格式不對就當成沒指定,沿用原本的可見範圍(不是回空清單:
    // 那會讓人以為「這個人名下沒有客戶」)。日報那一支早就是這個做法,照抄。
    const ownerId = UUID_RE.test(opts.ownerId ?? '') ? opts.ownerId : undefined;
    if (view.viewAll && ownerId) where.ownerId = ownerId;
    else if (!view.viewAll && ownerId && view.ownerIds.includes(ownerId)) {
      where.ownerId = ownerId;
    }
    if (opts.stage && STAGE_KEY_RE.test(opts.stage)) where.stage = opts.stage;
    // 秒查關鍵字:在資料庫裡查,不是把全部客戶撈回前端再過濾(見 searchCustomerWhere)
    const search = opts.q ? searchCustomerWhere(opts.q) : null;
    if (search) Object.assign(where, search);
    const take = clampListTake(opts.limit);
    const cursor = UUID_RE.test(opts.cursor ?? '') ? { id: opts.cursor as string } : undefined;
    const rows = await this.prisma.devCustomer.findMany({
      where,
      orderBy: [{ nextFollowUpAt: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      select: CUSTOMER_LIST_SELECT,
      take: take + 1,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    if (rows.length > take) {
      const page = rows.slice(0, take);
      return { rows: page, nextCursor: page[page.length - 1]?.id ?? null };
    }
    return { rows, nextCursor: null };
  }

  /**
   * 看板:一次回所有欄位。
   *
   * 回應帶 truncated / take:看板沒有游標可以往下翻(要一次畫完才看得懂),
   * 所以超過上限時只能截斷 —— 但一定要說。安靜截斷的看板會讓使用者以為
   * 「這一欄只有這幾筆」,而那是錯的,畫面上完全看不出來。
   */
  async board(userId: string, view: ViewScope) {
    const { rows, nextCursor } = await this.list(userId, view, { limit: BOARD_TAKE });
    const byStage: Record<string, typeof rows> = {};
    // ── 主檔是空的時候回什麼:回空的,不補寫死的欄位 ──────────────────────
    //
    // 以前這裡在讀不到或讀到空清單時補上出廠的七個 key。那個保底看起來無害,
    // 實際上是把一個 blocking 等級的安裝問題整個蓋掉:出廠 seed 失敗時
    // (五張主檔一筆都沒有),/api/public/settings 誠實回 `stages: []`,
    // 而這一支照樣回七個桶,於是同一份系統設定兩支 API 給出兩種答案,
    // 畫面上看起來一切正常,沒有人會去看開機日誌那五行警告。
    //
    // 正確的一邊是資料表。看板的欄位本來就由前端拿設定裡的階段清單畫
    // (見 lib/crm-shared 的 fetchBoard / emptyBoard),這一支回的是「每一階段有哪些客戶」,
    // 補出來的空桶對畫面沒有任何貢獻,只有掩蓋事實這一個作用。
    //
    // 讀失敗與讀到空清單一律回空:兩種都代表「現在沒有可信的階段清單」,
    // 而客戶不會因此消失 —— 下面那一圈以每一筆客戶自己的 stage 開桶,
    // 主檔真的空掉時看板仍然畫得出實際存在的那幾欄。
    let stageKeys: string[] = [];
    try {
      const defined = await this.prisma.devStage.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true },
      });
      stageKeys = defined.map((d: { key: string }) => d.key);
    } catch {
      stageKeys = [];
    }
    for (const st of stageKeys) byStage[st] = [];
    for (const r of rows) (byStage[r.stage] ??= []).push(r);
    // nextCursor 不為 null 表示還有下一頁,也就是這份看板被上限切掉了
    return {
      stages: byStage,
      take: BOARD_TAKE,
      loaded: rows.length,
      truncated: nextCursor !== null,
    };
  }

  async get(id: string, userId: string, view: ViewScope) {
    const c = await this.prisma.devCustomer.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true } },
        // 時間軸截斷後,前端仍要顯示正確的總筆數,所以另外帶 _count
        _count: { select: { interactions: true } },
        interactions: {
          orderBy: { occurredAt: 'desc' },
          // 客戶卡的時間軸只帶最近 50 筆(跑了三年的老客戶不該一次整段吐回前端)
          take: INTERACTIONS_TAKE,
          include: { user: { select: { name: true } } },
        },
      },
    });
    // 已刪除的客戶跟不存在一樣回 404:它不在清單、看板、秒查裡,直接打 id 也不該讀得到內容。
    // 要看要救回請走回收桶(GET /api/admin/crm-trash),那是管理員的路徑。
    if (!c || c.deletedAt || !canSeeOwner(view, c.ownerId))
      throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    // 已合併的那筆不能再操作。保留筆的 id 只在「這個人本來就看得到保留筆」時才帶回去,
    // 讓客戶卡直接給一個過去的連結;看不到的人只拿到訊息(見 mergedCustomerError)
    if (c.mergedIntoId) {
      const survivor = await this.prisma.devCustomer.findUnique({
        where: { id: c.mergedIntoId },
        select: { id: true, ownerId: true },
      });
      const visible = survivor !== null && canSeeOwner(view, survivor.ownerId);
      throw new BadRequestException(mergedCustomerError(visible ? c.mergedIntoId : null));
    }
    return c;
  }

  async create(userId: string, dto: Record<string, unknown>) {
    const taxId = this.s(dto.taxId);
    const companyName = this.s(dto.companyName);
    if (!taxId && !companyName)
      throw new BadRequestException(await this.identifierRequiredMessage());
    // 建檔也不能直接是成交,同 update 的規則
    const firstStage = await this.stageOf(undefined);
    const wantedStage = dto.stage === undefined ? undefined : await this.stageOf(dto.stage);
    const stageBlocked = stageChangeBlockReason(
      { stage: firstStage, externalCaseRef: null },
      wantedStage,
    );
    if (stageBlocked) throw new BadRequestException(stageBlocked);
    if (wantedStage !== undefined) await this.assertStageKey(wantedStage);
    const created = await this.prisma.devCustomer.create({
      data: {
        taxId,
        companyName: companyName ?? '(未命名)',
        representative: this.s(dto.representative),
        registeredAddress: this.s(dto.registeredAddress),
        actualAddress: this.s(dto.actualAddress),
        contactAddress: this.s(dto.contactAddress),
        website: this.s(dto.website),
        social: this.s(dto.social),
        category: this.s(dto.category),
        stage: wantedStage ?? firstStage,
        premisesType: await this.premisesOf(dto.premisesType),
        source: this.s(dto.source),
        contactName: this.s(dto.contactName),
        contactPhone: this.s(dto.contactPhone),
        note: this.s(dto.note),
        nextFollowUpAt: dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt as string) : null,
        ownerId: userId,
      },
    });
    this.scheduleGeocode(created);
    return created;
  }

  /**
   * 一般編輯(PATCH)。整段在 interactive transaction 裡做,開頭 lockCustomerRow ——
   * 與移交 / 打卡 / 成交共用同一把列鎖。
   *
   * 為什麼非鎖不可:階段規則是 check-then-act。原本的寫法在鎖外 get() 讀一次就直接寫,
   * 於是「業務把階段從有意願改回名單」與「主管按標記為成交」同一秒發生時,
   * 業務這一邊的 stageChangeBlockReason 看的是舊資料(還沒成交)所以回 null,
   * 無條件把 stage 寫成 lead。結果是:階段被退回、時間軸留著成交紀錄、
   * 而 externalCaseRef 是 null 所以 isConvertedCustomer 回 false ——
   * 「已成交不可退回」這道規則從此對這一筆永久失效,戰情的成交數也少一筆,
   * 而畫面上完全看不出來。鎖內重讀 stage 與 externalCaseRef 再判斷,兩個請求就會排隊。
   */
  async update(id: string, userId: string, view: ViewScope, dto: Record<string, unknown>) {
    // 鎖外先做存取檢查(只能改自己看得到的客戶)與明顯不合法的輸入,不用進交易
    await this.get(id, userId, view);
    const data: Record<string, unknown> = {};
    const fields = [
      'taxId',
      'companyName',
      'representative',
      'registeredAddress',
      'actualAddress',
      'contactAddress',
      'website',
      'social',
      'category',
      'source',
      'contactName',
      'contactPhone',
      'note',
    ];
    for (const k of fields) if (dto[k] !== undefined) data[k] = this.s(dto[k]);
    if (dto.companyName !== undefined) data.companyName = this.s(dto.companyName) ?? '(未命名)';
    const nextStage = dto.stage === undefined ? undefined : await this.stageOf(dto.stage);
    if (nextStage !== undefined) await this.assertStageKey(nextStage);
    // null / 空字串代表清掉;undefined 代表這次沒帶,不動
    if (dto.premisesType !== undefined) data.premisesType = await this.premisesOf(dto.premisesType);
    if (dto.nextFollowUpAt !== undefined)
      data.nextFollowUpAt = dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt as string) : null;

    // 交易內設定,交易外才排背景地理編碼:排程失敗不該讓這次編輯回滾
    let regeocode = false;
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockCustomerRow(tx, id);
      // 鎖內重讀:階段判斷與地址比對都以這一份為準,鎖外那份可能已經被別的請求改掉
      const cur = await tx.devCustomer.findUnique({
        where: { id },
        select: {
          stage: true,
          externalCaseRef: true,
          mergedIntoId: true,
          deletedAt: true,
          registeredAddress: true,
          actualAddress: true,
          contactAddress: true,
        },
      });
      // 鎖內也要看一次:鎖外的 get() 到這裡之間可能剛好被刪掉
      if (!cur || cur.deletedAt) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
      if (cur.mergedIntoId) throw new BadRequestException(MERGED_CUSTOMER_MESSAGE);

      // 階段:不能直接改成 converted(要走成交流程),已成交的也不能退回
      if (nextStage !== undefined) {
        const blocked = stageChangeBlockReason(cur, nextStage);
        if (blocked) throw new BadRequestException(blocked);
        data.stage = nextStage;
      }

      // 地址有變:在時間軸留系統紀錄(所有變動欄位);只有地圖實際採用的地址變了才清掉地理編碼結果
      const addrLines = addressChangeLines(cur, data);
      if (!addrLines.length) return tx.devCustomer.update({ where: { id }, data });
      regeocode = geocodeAddressChanged(cur, data);
      const row = await tx.devCustomer.update({
        where: { id },
        data: regeocode ? { ...data, lat: null, lng: null, geocodedAt: null } : data,
      });
      await tx.devInteraction.create({
        data: {
          customerId: id,
          userId,
          channel: NOTE_CHANNEL_KEY,
          note: addrLines.join('\n'),
          occurredAt: new Date(),
        },
      });
      return row;
    });

    if (regeocode) this.scheduleGeocode(updated);
    return updated;
  }

  async addInteraction(
    customerId: string,
    userId: string,
    view: ViewScope,
    dto: Record<string, unknown>,
  ) {
    await this.get(customerId, userId, view);
    // 拜訪只能由外勤打卡寫(crm-checkin.service 直接寫 DB,不經這裡);【開頭保留給系統紀錄
    const blocked = interactionBlockReason(dto.channel, dto.note);
    if (blocked) throw new BadRequestException(blocked);
    const serverTime = new Date();
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt as string) : serverTime;
    const timeBlocked = occurredAtBlockReason(occurredAt, serverTime);
    if (timeBlocked) throw new BadRequestException(timeBlocked);
    const it = await this.prisma.devInteraction.create({
      data: {
        customerId,
        userId,
        channel: await this.channelOf(dto.channel),
        note: this.s(dto.note),
        occurredAt,
        nextAction: this.s(dto.nextAction),
        gpsLat: typeof dto.gpsLat === 'number' ? dto.gpsLat : null,
        gpsLng: typeof dto.gpsLng === 'number' ? dto.gpsLng : null,
      },
    });
    await this.prisma.devCustomer.update({
      where: { id: customerId },
      data: { lastContactAt: occurredAt },
    });
    return it;
  }

  /**
   * 客戶移交。整段在 interactive transaction 裡做,開頭 lockCustomerRow(與打卡 / 成交 / 排程共用同一把列鎖):
   * 原本是「鎖外讀 ownerId → 陣列式 $transaction 寫入」,與併發的排程 / 打卡交錯時,
   * 對方會拿鎖外那份舊 ownerId 落地。鎖內重讀 ownerId 與 mergedIntoId 再寫,同一客戶的請求就會排隊。
   */
  /**
   * 移交前的共同檢查:接手者存在、啟用中、是能進 CRM 的角色、而且在呼叫者的可見範圍內。
   * 單筆與批次共用同一份 —— 分兩份寫的話,批次那條遲早會少掉其中一項。
   */
  private async assertTransferTarget(toUserId: string, view: ViewScope) {
    // 接手者要同時滿足兩件事:
    // (1) 是「啟用中的業務或訪查主管」。移交給不進 CRM 的角色(例如 admin,或日後新增的
    //     角色)或已停用的帳號,客戶就變成沒人看得到的孤兒資料。
    // (2) 在呼叫者自己的可見範圍內。少了這條,訪查主管可以把客戶推給團隊外的任何人:
    //     推完那筆客戶就離開他的可見範圍,連他自己都收不回來。轉派下拉(salesUsers)
    //     早就用同一套 ViewScope 限縮了,API 這側要跟上,否則下拉只是畫面上的裝飾。
    //     admin(viewAll)不受這條限制,口徑與 salesUsers 一致。
    const target = await this.prisma.user.findUnique({
      where: { id: toUserId },
      select: { id: true, name: true, role: true, status: true },
    });
    if (
      !target ||
      target.status !== 'active' ||
      !(TRANSFERABLE_ROLES as readonly string[]).includes(target.role as string) ||
      !canSeeOwner(view, target.id)
    ) {
      throw new BadRequestException(TRANSFER_TARGET_MESSAGE);
    }
    return target;
  }

  /**
   * 移交一筆客戶(交易 + 客戶列鎖)。呼叫端必須先過 assertTransferTarget。
   * 這段與呼叫者姓名跟客戶列無關的檢查放在鎖外,明顯不能移交的請求不用進交易。
   */
  private async transferOne(
    customerId: string,
    target: { id: string; name: string },
    actor: { name: string } | null,
    actorUserId: string,
    view: ViewScope,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockCustomerRow(tx, customerId);
      // 鎖內重讀:原負責人與合併狀態都以這一份為準
      const c = await tx.devCustomer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          ownerId: true,
          mergedIntoId: true,
          deletedAt: true,
          owner: { select: { name: true } },
        },
      });
      // 可見範圍檢查要在鎖內、用重讀回來的 ownerId 做:鎖外那份可能已經被別的移交改掉。
      // 查不到與看得到但沒權限回同一句話 —— 分開回的話,主管可以拿別人團隊的客戶 id
      // 逐一試,用「找不到」與「無權限」的差別問出這筆客戶存不存在。
      if (!c || c.deletedAt || !canSeeOwner(view, c.ownerId))
        throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
      if (c.mergedIntoId) throw new BadRequestException(MERGED_CUSTOMER_MESSAGE);

      // 客戶與「還會用到的排程」的負責人要一起換,不然舊業務還能從排程讀到客戶資料、取消新業務的排程
      const updated = await tx.devCustomer.update({
        where: { id: customerId },
        data: { ownerId: target.id },
      });
      await tx.devVisitPlan.updateMany({
        where: { customerId, status: { in: ['planned', 'missed'] } },
        data: { ownerId: target.id },
      });
      // 移交寫進客戶時間軸,讓業務在客戶卡看得到「原本誰的 → 轉給誰(誰執行)」
      await tx.devInteraction.create({
        data: {
          customerId,
          userId: actorUserId,
          channel: 'note',
          note: `【客戶移交】原負責:${c.owner?.name ?? '—'} → 轉給:${target.name}(執行:${actor?.name ?? '—'})`,
          occurredAt: new Date(),
        },
      });
      return updated;
    });
  }

  async transfer(customerId: string, toUserId: string, actorUserId: string, view: ViewScope) {
    const target = await this.assertTransferTarget(toUserId, view);
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { name: true },
    });
    return this.transferOne(customerId, target, actor, actorUserId, view);
  }

  /**
   * 批次移交。
   *
   * 為什麼要有:匯入一律把客戶歸在匯入者名下,而單筆移交一次只能一筆。一份 2000 筆的
   * 名單要分給 26 個人,沒有這一支就只能開 2000 張客戶卡按 2000 次移交。
   *
   * 三個刻意的選擇:
   * 1. **每一筆各自一個交易、各自鎖自己那一列**,不包成一個大交易。批次的一筆失敗
   *    (別人剛好把它合併掉、或它已經不在可見範圍)不該讓另外 199 筆一起回退,
   *    而且一個交易同時握住 200 把列鎖,跟打卡、標記成交那些路徑撞上的機會大得多。
   * 2. **權限與可見範圍走的是跟單筆完全同一份程式**(assertTransferTarget / transferOne),
   *    不另外寫一套寬鬆版。
   * 3. **有筆數上限**(TRANSFER_BATCH_MAX),而且重複的 id 先去掉:同一筆做兩次會在
   *    時間軸上留下兩筆移交紀錄。
   *
   * 回傳逐筆結果,失敗的那幾筆帶著原因,呼叫端才說得出「哪幾筆沒轉成功、為什麼」。
   */
  async transferMany(
    customerIds: readonly string[],
    toUserId: string,
    actorUserId: string,
    view: ViewScope,
  ): Promise<{
    requested: number;
    transferred: number;
    failed: Array<{ id: string; message: string }>;
  }> {
    const ids = [...new Set(customerIds)].slice(0, TRANSFER_BATCH_MAX);
    const target = await this.assertTransferTarget(toUserId, view);
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { name: true },
    });
    let transferred = 0;
    const failed: Array<{ id: string; message: string }> = [];
    for (const id of ids) {
      try {
        await this.transferOne(id, target, actor, actorUserId, view);
        transferred += 1;
      } catch (err) {
        // 只回我們自己寫的那幾句訊息。其他例外(Prisma 的、連線的)一律換成通用句,
        // 不要把資料庫的錯誤內文往外送。
        const message =
          err instanceof NotFoundException || err instanceof BadRequestException
            ? ((err.getResponse() as { message?: string })?.message ?? err.message)
            : '移交失敗,請稍後再試';
        failed.push({ id, message });
      }
    }
    return { requested: ids.length, transferred, failed };
  }

  /**
   * 可轉派的業務清單(給訪查主管 / admin 的轉派下拉用;不透過 admin 專屬的 /admin/users)。
   *
   * 一定要吃 ViewScope:這支就是移交下拉的資料來源,不限縮的話,訪查主管在下拉裡
   * 看得到全公司的人,等於一份完整的員工名冊,也讓他把客戶轉給團隊外的人。
   * 口徑同 view-scope.ts —— 主管看自己團隊,admin 才看全部。
   */
  async salesUsers(view: ViewScope) {
    return this.prisma.user.findMany({
      where: {
        role: { in: ['sales', 'sales_manager'] },
        status: 'active',
        ...(view.viewAll ? {} : { id: { in: [...view.ownerIds] } }),
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  // 成交:標記已成交 + 記下外部案件編號 + 寫進時間軸(互動歷程留在 CRM,可回溯)。
  // 帶 externalRef 時,另把最近 20 筆互動整理成純文字歷程附進客戶備註(DevCustomer.note)。
  // 成交前預檢(不寫入):讓前端在按下「標記為成交」之前先問,避免使用者填完才被擋
  async convertCheck(
    customerId: string,
    userId: string,
    view: ViewScope,
  ): Promise<{ ok: boolean; reason: string | null }> {
    const cust = await this.get(customerId, userId, view);
    if (isConvertedCustomer(cust)) return { ok: false, reason: CONVERTED_ALREADY_REASON };
    const photoRows = await this.prisma.devVisitPhoto.findMany({
      where: { customerId },
      select: { kind: true },
    });
    const [checklist, kindCatalog, premises, exempt] = await Promise.all([
      this.photoChecklist(),
      this.photoKindCatalog(),
      this.premisesCatalog(),
      this.photoExemptPremises(),
    ]);
    const reason = convertBlockReason(
      cust.premisesType,
      photoRows.map((p) => p.kind as string),
      checklist,
      kindCatalog,
      premisesLabelOf(premises, cust.premisesType),
      exempt,
      view.viewAll,
    );
    return { ok: reason === null, reason };
  }

  /**
   * 標記成交。整段在 interactive transaction 裡做:開頭 lockCustomerRow(與打卡 / 刪照片共用同一把列鎖),
   * 鎖內重讀 stage / 外部案件編號 / 照片 kinds 再檢查,最後 updateMany 加「尚未成交」條件,
   * count 不是 1 就視為被搶先標記過,回 400。兩個併發請求只會有一個成功。
   *
   * externalRef:選填的外部案件編號(接別的系統時用),格式限 uuid,一個編號只能對到一位客戶。
   * 這個欄位沒有外鍵 —— 對應的案件在哪一個系統由使用單位自己決定,CRM 只負責記著。
   */
  async markConverted(customerId: string, userId: string, view: ViewScope, externalRef?: string) {
    // 外部系統的案件編號,不保證是 UUIDv4,所以用寬鬆版而不是嚴格版 UUID_RE。
    // 詳見 common/uuid.ts 的 LOOSE_UUID_RE 註解。
    const caseRef = externalRef && LOOSE_UUID_RE.test(externalRef) ? externalRef : null;
    if (externalRef && !caseRef) throw new BadRequestException('案件編號格式錯誤');
    // 鎖外先做存取檢查(只能標記自己看得到的客戶)與便宜的預檢,讓明顯不行的請求不用進交易
    const pre = await this.get(customerId, userId, view);
    if (isConvertedCustomer(pre)) throw new BadRequestException(CONVERTED_ALREADY_MESSAGE);
    // 歷程上的日期以組織設定的時區顯示;在交易外先讀好,交易內不再打設定
    const tz = await this.timeZone();

    try {
      return await this.convertOnce(customerId, userId, caseRef, tz, view.viewAll);
    } catch (err) {
      /*
       * 上面那道「查有沒有別人佔著這個編號」是 check-then-act,在 READ COMMITTED
       * 底下沒有謂詞鎖:同一刻主管從回收桶還原一筆掛著同一個編號的客戶時,
       * 兩邊各自查對方,對方當下都還不算活著,於是兩邊都放行,
       * 最後由 dev_customers_external_case_ref_live_key 這道 partial unique index
       * 擋下其中一邊(Prisma 的 P2002)。
       *
       * 不攔的話 GlobalExceptionFilter 會把它轉成 500 加一列 error_logs,
       * 使用者看到「伺服器發生未預期的錯誤」。資料是安全的(交易整個回滾),
       * 但那句話沒有任何下一步可以做,而這裡本來就有一句說得清楚的 400。
       * 還原那一端做的是同一件事(見 CrmDeletionService.runCatchingCaseRefClash)。
       */
      if (isCaseRefUniqueViolation(err)) throw new BadRequestException(CASE_REF_TAKEN_MESSAGE);
      throw err;
    }
  }

  /** markConverted 的交易本體。權限、格式與預檢都在呼叫端做完了 */
  private async convertOnce(
    customerId: string,
    userId: string,
    caseRef: string | null,
    tz: string,
    /** 這個人設定得了必拍清單嗎(只有系統管理員可以)。只影響擋下時講哪一句話 */
    canConfigure = true,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockCustomerRow(tx, customerId);
      // 鎖內重讀:stage / 外部案件編號 / note / premisesType 都以此為準
      const cust = await tx.devCustomer.findUnique({
        where: { id: customerId },
        select: {
          stage: true,
          externalCaseRef: true,
          note: true,
          premisesType: true,
          mergedIntoId: true,
          deletedAt: true,
        },
      });
      if (!cust || cust.mergedIntoId || cust.deletedAt)
        throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
      if (isConvertedCustomer(cust)) throw new BadRequestException(CONVERTED_ALREADY_MESSAGE);

      // 必拍清單與照片種類名稱都在鎖內讀:鎖外讀的話,管理員在這幾毫秒之間改了必拍清單,
      // 這一筆會拿舊清單放行,而畫面上看不出「它是照哪一版規則過的」。
      const [checklist, kindCatalog, premises, exempt] = await Promise.all([
        this.photoChecklist(),
        this.photoKindCatalog(tx),
        this.premisesCatalog(),
        this.photoExemptPremises(),
      ]);

      if (caseRef) {
        // 一個外部案件編號只能對到一位客戶,不然兩邊對帳時分不出是哪一位。
        //
        // 回收桶裡的那些不算:不排除的話,訊息會說「此案件編號已對應其他客戶」,
        // 而那位客戶已經被刪掉,使用者在清單、看板、秒查、查重上都找不到它,
        // 拿著這句話沒有任何下一步可以做。已刪除的那筆要重新回到檯面上只有一條路
        // (從回收桶還原),而還原那一端會擋下編號撞號的情況並說清楚
        // (見 crm-deletion-rules 的 restoreCaseRefTakenMessage),
        // 所以兩筆活著的客戶掛同一個編號這件事仍然不會發生。
        const linked = await tx.devCustomer.findFirst({
          where: { externalCaseRef: caseRef, id: { not: customerId }, deletedAt: null },
          select: { id: true },
        });
        if (linked) throw new BadRequestException(CASE_REF_TAKEN_MESSAGE);
      }
      const now = new Date();

      // 成交前檢查:場所類型要選、該類型的必備存證照片要齊(看整個客戶的照片,不限單次打卡)
      const photoRows = await tx.devVisitPhoto.findMany({
        where: { customerId },
        select: { kind: true },
      });
      const kindsPresent = photoRows.map((p) => p.kind as string);
      const blocked = convertBlockReason(
        cust.premisesType,
        kindsPresent,
        checklist,
        kindCatalog,
        premisesLabelOf(premises, cust.premisesType),
        exempt,
        canConfigure,
      );
      if (blocked) throw new BadRequestException(blocked);

      // 互動歷程(最近 20 筆,舊→新):日期 管道 內容 下一步
      const HISTORY_TITLE = '【客戶互動歷程】';
      // 舊標題:這個區塊靠標題切掉上一次附過的內容,標題換過名字。備註裡如果留著
      // 舊標題寫進去的區塊,只認新標題會切不到,重複成交就會疊出兩段歷程。
      // 兩個都認,切在最前面出現的那一個。
      const LEGACY_HISTORY_TITLE = '【業務開發歷程】';
      // 切點要認得出「這是系統自己寫的區塊」,不是使用者打的字。
      // 只比對標題四個字的話,備註裡任何位置出現這幾個字(使用者自己寫的、
      // 或匯出改完再匯入時帶進來的別人歷程文字),那個位置之後整段都會被
      // updateMany 覆寫掉,而且沒有第二份可以救。
      // 系統寫出去的區塊固定長成:標題自成一行(或整份備註的開頭),
      // 後面緊接著 stamp 的「YYYY/MM/DD 成交,案件編號 」,所以比對帶上這個錨點。
      // 兩個標題都不含正規表示式的特殊字元,直接嵌進樣板不必跳脫。
      const HISTORY_BLOCK_ANCHOR = `(?:${HISTORY_TITLE}|${LEGACY_HISTORY_TITLE})\\d{4}/\\d{2}/\\d{2} 成交,案件編號 `;
      const HISTORY_BLOCK_RE = new RegExp(`(?:^|\\n)${HISTORY_BLOCK_ANCHOR}`);
      /** 同一個錨點,但只認「從這個位置開始」,用來看下一個區塊是不是緊接著 */
      const HISTORY_BLOCK_AT_RE = new RegExp(`^${HISTORY_BLOCK_ANCHOR}`);
      // 區塊的**結束**邊界。只界定開頭、從那裡砍到備註結尾的話,使用者寫在區塊
      // 後面的字會一起消失,而那正是這一段本來要防的事:從匯出檔把含區塊的備註
      // 改一改匯進另一筆客戶,那筆第一次成交就會把使用者補的內容洗掉。
      // 系統寫出去的區塊形狀固定:標題行、照片行、一到多行「- 」開頭的互動行。
      // 認到最後一行連續的互動行就算結束,後面的東西接回去。
      // 規則保守:形狀對不上(照片行不在、照片行後面一行互動行都沒有、
      // 中間夾了空行)就當作認不出來,整份備註原封不動留著。寧可留下一段舊歷程
      // 讓人自己刪,也不要替使用者刪掉他寫的字。
      const PHOTO_LINE_PREFIX = '存證照片:';
      const INTERACTION_LINE_PREFIX = '- ';
      /**
       * 從 `from`(區塊標題行的第一個字)往下讀,回傳區塊結束的位置(不含結尾換行)。
       * 認不出結束就回 null,呼叫端整份留著。
       */
      const historyBlockEnd = (text: string, from: number): number | null => {
        const lineEnd = (at: number) => {
          const nl = text.indexOf('\n', at);
          return nl === -1 ? text.length : nl;
        };
        // 標題行。整份備註就到標題行為止的話,後面沒有東西可以保護,直接收在這裡
        const titleEnd = lineEnd(from);
        if (titleEnd >= text.length) return titleEnd;
        let cursor = titleEnd + 1;
        if (!text.startsWith(PHOTO_LINE_PREFIX, cursor)) return null;
        let end = lineEnd(cursor);
        cursor = end + 1;
        let interactionLines = 0;
        while (text.startsWith(INTERACTION_LINE_PREFIX, cursor)) {
          end = lineEnd(cursor);
          cursor = end + 1;
          interactionLines += 1;
        }
        return interactionLines === 0 ? null : end;
      };
      let historyNote: string | null = null;
      if (caseRef) {
        const recent = await tx.devInteraction.findMany({
          where: { customerId },
          orderBy: { occurredAt: 'desc' },
          take: 20,
          select: { channel: true, note: true, nextAction: true, occurredAt: true },
        });
        // 管道名稱吃 dev_interaction_channels 主檔:寫死對照表的話,
        // 後台把管道整組換掉之後,歷程上印的還是舊名字,而數字是新的
        const channels = await this.channelCatalog(tx);
        const chLabel = new Map(channels.map((c) => [c.key, c.label]));
        const fmtDate = (dt: Date) => orgDateKey(dt, tz).replace(/-/g, '/');
        const one = (v: string | null | undefined, max: number) =>
          (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
        const lines = [...recent].reverse().map((it) => {
          const parts = [
            fmtDate(it.occurredAt),
            chLabel.get(it.channel) ?? it.channel,
            one(it.note, 200) || '(無內容)',
          ];
          const next = one(it.nextAction, 100);
          if (next) parts.push(`下一步:${next}`);
          return `${INTERACTION_LINE_PREFIX}${parts.join(' ')}`;
        });
        const stamp = `${fmtDate(now)} 成交,案件編號 ${caseRef}`;
        const photoLine = `${PHOTO_LINE_PREFIX}${photoRows.length} 張${photoRows.length ? `(${photoKindsZh(kindsPresent, kindCatalog)})` : ''}`;
        const block = `${HISTORY_TITLE}${stamp}\n${photoLine}\n${lines.length ? lines.join('\n') : `${INTERACTION_LINE_PREFIX}(尚無互動紀錄)`}`;
        // 保留原備註;若之前已附過歷程,換成這次的(避免每次標記都疊一段)
        const rawNote = cust.note ?? '';
        // 第一個符合錨點的位置就是上一次附上去的區塊開頭;找不到就整份備註留著。
        const cut = HISTORY_BLOCK_RE.exec(rawNote);
        // base 是區塊之前的內容,tail 是區塊之後的內容,兩邊都要留下來。
        let base = rawNote;
        let tail = '';
        if (cut) {
          // exec 的比對包含前面那個換行(備註開頭的區塊沒有),標題本身從這裡開始
          const blockStart = cut.index + (rawNote[cut.index] === '\n' ? 1 : 0);
          let end = historyBlockEnd(rawNote, blockStart);
          if (end !== null) {
            // 舊版本疊出來的第二段:兩個區塊之間只隔空白行時視為同一串,一起收掉。
            // 不一起收的話,它會被當成使用者的內容留著,這次再附一段就是三段。
            for (;;) {
              let at = end;
              while (at < rawNote.length && /[\r\n\t ]/.test(rawNote[at] ?? '')) at += 1;
              if (at === end || !HISTORY_BLOCK_AT_RE.test(rawNote.slice(at))) break;
              const nextEnd = historyBlockEnd(rawNote, at);
              if (nextEnd === null) break;
              end = nextEnd;
            }
            base = rawNote.slice(0, cut.index);
            tail = rawNote.slice(end);
          }
        }
        const kept = [base.trimEnd(), tail.trim()].filter((part) => part !== '').join('\n\n');
        historyNote = kept ? `${kept}\n\n${block}` : block;
      }

      // 條件式更新:只有「此刻仍未成交」的那筆會被改到;count 不是 1 就是被搶先了
      const res = await tx.devCustomer.updateMany({
        where: { id: customerId, stage: { not: WON_STAGE_KEY }, externalCaseRef: null },
        data: {
          stage: WON_STAGE_KEY,
          externalCaseRef: caseRef,
          ...(historyNote !== null ? { note: historyNote } : {}),
        },
      });
      if (res.count !== 1) throw new BadRequestException(CONVERTED_ALREADY_MESSAGE);
      // 系統紀錄前綴「【已成交】」:stats / report 用它計數,改字要連那兩支一起改
      await tx.devInteraction.create({
        data: {
          customerId,
          userId,
          channel: 'note',
          note: `${CONVERTED_NOTE_PREFIX}已標記成交${caseRef ? `(案件編號 ${caseRef})` : ''}`,
          occurredAt: now,
        },
      });
      return tx.devCustomer.findUnique({ where: { id: customerId } });
    });
  }

  /**
   * 工作報告彙整(本週 week / 當日 today;自己 me / 全隊 team)。
   * team 的「全隊」就是這個人的可見範圍(自己團隊與部門子樹;admin 是全部)。
   * 回傳可直接複製給 AI 的文字 + 統計。
   *
   * 每一個數字的口徑都引用 ../crm-scope-filters 的共用片段,與主管戰情圖表
   * (CrmStatsService.bySales)完全一致:
   *   互動 / 拜訪  只算人寫的(排除【客戶移交】【照片刪除】【合併】【已成交】等系統紀錄),
   *                而且依「誰寫的」算(authorFilter),不是「誰的客戶」——
   *                主管在我的客戶上寫的備註不該算成我的產出。
   *   拜訪         另外扣掉 gpsSuspicious=true 的可疑打卡。
   *   逾期         排除終止階段(成交、放棄,以及後台自己加的)。
   * 這一段之前兩支各寫一份,結果是零實際互動的人在報告上顯示 3 筆、
   * 同一週的戰情顯示 0,而畫面上看不出哪一個才對。
   *
   * 每一支查詢都有上限:數字用 count(不受上限影響),清單只取要顯示的前 12 筆。
   * 之前是把可能上萬筆的互動整批撈回來,只為了用其中的 12 筆。
   */
  async report(userId: string, view: ViewScope, range: 'week' | 'today', scope: 'me' | 'team') {
    // team 檢視要看得到別人才有意義:一般業務的範圍只有自己,選 team 也等於 me
    const team = scope === 'team' && (view.viewAll || view.ownerIds.length > 1);
    const now = new Date();
    // 起點以組織設定的時區計(不是伺服器時間,也不是寫死的 UTC+8):
    // 當日 = 當地今天 00:00,本週 = 當地這週一 00:00
    const tz = await this.timeZone();
    const start = range === 'today' ? orgDayRange(now, tz).start : orgPeriodStart('week', now, tz);

    // 「本人」檢視就是只看自己寫的、自己負責的;team 檢視用可見範圍當條件,
    // 不是「沒有條件」—— 主管的全隊是他的團隊,不是全公司
    const reportScope: ViewScope = team ? view : ownOnlyScope(userId);
    const custWhere = team ? ownerFilter(view) : { ownerId: userId };
    const authorWhere = authorFilter(reportScope) as Prisma.DevInteractionWhereInput;

    // 「有意願」= 進行中階段裡排最後的那一階(離終點最近的一階),不是寫死的代碼:
    // 後台把流程改長改短,這個數字跟著走,不會因為找不到 interested 就永遠是 0
    const catalog = await this.stageCatalogEntries();
    const inProgress = catalog.filter((st) => !st.isTerminal);
    const terminalKeys = catalog.filter((st) => st.isTerminal).map((st) => st.key);
    const nearestToWonKey = inProgress.length ? inProgress[inProgress.length - 1]!.key : null;
    const overdueWhere = { ...overdueCustomerWhere(now, terminalKeys), ...custWhere };

    const [
      interactions,
      visitsRaw,
      suspicious,
      converted,
      interested,
      overdueCount,
      recent,
      dueRows,
    ] = await Promise.all([
      this.prisma.devInteraction.count({
        // liveCustomerFilter:客戶被刪掉之後,他身上的互動不再算進報告
        where: {
          occurredAt: { gte: start },
          ...humanInteractionWhere(),
          ...liveCustomerFilter(),
          ...authorWhere,
        },
      }),
      this.prisma.devInteraction.count({
        where: { ...visitInteractionWhere(start), ...liveCustomerFilter(), ...authorWhere },
      }),
      this.prisma.devInteraction.count({
        where: { ...suspiciousVisitWhere(start), ...liveCustomerFilter(), ...authorWhere },
      }),
      // 本期成交:以本期內的【已成交】系統紀錄計數(stage 快照沒有時間,直接數會虛胖),
      // 歸給客戶目前的負責人,與戰情圖表同一個算法
      this.prisma.devInteraction.count({
        where: { ...convertedInteractionWhere(start), ...relatedLiveCustomerFilter(reportScope) },
      }),
      nearestToWonKey === null
        ? Promise.resolve(0)
        : this.prisma.devCustomer.count({
            where: { ...custWhere, stage: nearestToWonKey, ...countableCustomerWhere() },
          }),
      // overdueWhere 已含「不算被合併掉的那一筆」(見 crm-scope-filters 的 overdueCustomerWhere)
      this.prisma.devCustomer.count({ where: overdueWhere }),
      this.prisma.devInteraction.findMany({
        where: {
          occurredAt: { gte: start },
          ...humanInteractionWhere(),
          ...liveCustomerFilter(),
          ...authorWhere,
        },
        select: {
          note: true,
          occurredAt: true,
          customer: { select: { companyName: true } },
        },
        orderBy: { occurredAt: 'desc' },
        take: REPORT_LIST_TAKE,
      }),
      this.prisma.devCustomer.findMany({
        where: overdueWhere,
        select: { companyName: true },
        orderBy: { nextFollowUpAt: 'asc' },
        take: REPORT_LIST_TAKE,
      }),
    ]);
    const visits = Math.max(0, visitsRaw - suspicious);

    const label = range === 'today' ? '當日拜訪日報' : '本週工作彙整';
    const who = team ? '團隊' : '本人';
    // 顯示成當地的「月/日」
    const fmt = (dt: Date) => {
      const p = orgDateParts(dt, tz);
      return `${p.month}/${p.day}`;
    };
    const lines: string[] = [];
    lines.push(`【${label}・${who}・${fmt(start)}~${fmt(now)}】`);
    lines.push(
      `互動 ${interactions} 筆、拜訪 ${visits} 次、目前有意願 ${interested} 家、本期成交 ${converted} 家。`,
    );
    if (recent.length) {
      lines.push('重點動態:');
      for (const it of recent) {
        const nm = it.customer?.companyName ?? '(未命名)';
        const note = (it.note ?? '').replace(/\s+/g, ' ').slice(0, 40);
        lines.push(`- ${nm}(${fmt(it.occurredAt)}):${note || '(無摘要)'}`);
      }
    }
    if (dueRows.length) {
      lines.push('待跟進(逾期):');
      for (const c of dueRows) lines.push(`- ${c.companyName ?? '(未命名)'}`);
    }
    const text = lines.join('\n');
    return {
      title: `${label}(${who})`,
      text,
      stats: {
        interactions,
        visits,
        suspiciousVisits: suspicious,
        interested,
        converted,
        overdue: overdueCount,
      },
    };
  }

  /**
   * 各業務開發中筆數。同樣吃 ViewScope:主管只該看到自己團隊的人。
   *
   * 停用(離職)帳號名下的客戶照樣算,該列標 active: false —— 與漏斗、
   * 貢獻度分級同一個口徑,理由寫在 crm-scope-filters.ts 的 crmSalesUserWhere。
   * 被合併掉的那一筆不算(它的 stage 是 dropped,本來就會被終止階段排掉,
   * 這裡明寫一次是為了不依賴那個巧合)。
   */
  async bySales(view: ViewScope) {
    // 進行中 / 終止一律問階段目錄的 is_terminal,不是寫死的 converted / dropped
    const catalog = await this.stageCatalogEntries();
    const terminalKeys = catalog.filter((st) => st.isTerminal).map((st) => st.key);
    const inProgress = catalog.filter((st) => !st.isTerminal);
    const nearestToWonKey = inProgress.length ? inProgress[inProgress.length - 1]!.key : null;
    const baseWhere: Prisma.DevCustomerWhereInput = {
      stage: { notIn: terminalKeys },
      ...countableCustomerWhere(),
      ...ownerFilter(view),
    };
    const now = new Date();
    // 這一支數的是「每位訪查人員手上有幾筆」,結果是一人一列,不是一筆客戶一列。
    // 所以交給資料庫 group by,不要把可能上萬筆的客戶整批撈回來只為了在記憶體裡數。
    //
    // 這也是這一支為什麼沒有 take:同檔的清單與看板都有筆數上限,但那是**清單**,
    // 截斷的是「顯示到第幾筆」,而且截斷這件事會由 truncated 告訴使用者。
    // 這裡截斷的會是**數字本身**,畫面上看不出少算,所以正確的做法不是補一個 take,
    // 而是根本不要把明細撈出來 —— group by 的結果列數是「人數 × 階段數」,
    // 本來就有界(後台設得出來的階段是個位數,團隊人數也是),不需要上限。
    const [byStage, overdue] = await Promise.all([
      this.prisma.devCustomer.groupBy({
        by: ['ownerId', 'stage'],
        where: baseWhere,
        _count: { _all: true },
      }),
      this.prisma.devCustomer.groupBy({
        by: ['ownerId'],
        // 逾期的口徑與本週工作報告、主管戰情共用同一支 where,不要在這裡另寫一份
        where: { ...overdueCustomerWhere(now, terminalKeys), ...ownerFilter(view) },
        _count: { _all: true },
      }),
    ]);

    const map = new Map<string, SalesRollupRow>();
    const ensure = (ownerId: string): SalesRollupRow => {
      let m = map.get(ownerId);
      if (!m) {
        m = {
          salesId: ownerId,
          salesName: '(未知)',
          active: true,
          inDev: 0,
          interested: 0,
          overdue: 0,
        };
        map.set(ownerId, m);
      }
      return m;
    };
    for (const g of byStage) {
      const m = ensure(g.ownerId);
      const n = g._count._all;
      m.inDev += n;
      if (nearestToWonKey !== null && g.stage === nearestToWonKey) m.interested += n;
    }
    for (const g of overdue) ensure(g.ownerId).overdue += g._count._all;

    // 姓名與帳號狀態另外查一次。group by 帶不出關聯欄位,而列數就是進榜的人數,
    // 這一次查詢本來就有界
    const ownerIds = [...map.keys()];
    if (ownerIds.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true, status: true },
      });
      for (const u of users) {
        const m = map.get(u.id);
        if (!m) continue;
        m.salesName = u.name ?? '(未知)';
        // 停用(離職)帳號名下的客戶照樣算,只是標成 active: false,由畫面說明
        m.active = u.status !== 'disabled';
      }
    }
    return [...map.values()].sort((a, b) => b.inDev - a.inDev);
  }

  /**
   * 匯入的「進度」欄:標籤 → 階段代碼。
   *
   * 對照表由 dev_stages 現況產生(順便收代碼本身,讓匯出的檔案直接匯得回來),
   * 加上舊名的相容別名。查不到就回 null,由呼叫端當成錯誤回報 ——
   * 安靜降階是最糟的處理:使用者看到「匯入成功」,整批客戶的進度卻被洗掉了。
   */
  private async stageLabelMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const entries = await this.stageCatalogEntries();
    for (const st of entries) {
      const label = st.label.trim();
      if (label && !out.has(label)) out.set(label, st.key);
    }
    for (const st of entries) if (!out.has(st.key)) out.set(st.key, st.key);
    for (const [alias, label] of Object.entries(LEGACY_STAGE_LABEL_ALIASES)) {
      const key = out.get(label);
      if (key && !out.has(alias)) out.set(alias, key);
    }
    return out;
  }

  /**
   * 匯入名單。三件事跟原本不同:
   * 1. 查重改成「一次 findMany 撈回可見範圍內既有的識別碼與公司名」建 Set 比對,
   *    不再逐列 findFirst —— 1000 列原本是 2000 次往返,現在是 1 次查 + 幾次寫。
   * 2. 寫入分段提交(IMPORT_CHUNK 一段,每段 createMany 是一個原子敘述),
   *    不會出現「前面寫進去、後面沒寫」又完全無法交代的狀態:回傳的 created 就是實際寫成功的筆數。
   * 3. 同一批內重複的識別碼與公司名也算重複(先寫進去的那筆會佔位),不會匯進兩筆一樣的。
   * 欄位長度由 ImportRowsDto 擋在 controller,這裡收到的已經是驗過的資料。
   *
   * ── 錯誤要指到第幾列第幾欄 ──────────────────────────────────────
   * 每一列可以帶 rowNumber(前端解析 CSV 時就知道的試算表列號)。回傳的 errors
   * 就是「第幾列、哪一欄、怎麼了」的清單。以前這裡只回總數與「查不到的進度有哪幾種」,
   * 使用者拿到「有 3 筆的進度不在階段設定裡」之後,只能自己一列一列翻檔案找那三列。
   * rowNumber 沒帶時 row 回 null,訊息仍然照舊給,不會因為少一個欄位就整批失敗。
   */
  async importRows(userId: string, view: ViewScope, rows: unknown, batchId?: string) {
    const list = (Array.isArray(rows) ? rows : []).slice(0, IMPORT_MAX_ROWS);
    // 這一次匯入的批次識別碼。每一筆寫進去的客戶都帶同一個值,
    // 匯錯的時候才有辦法用「刪掉這一批」一次收回去(見 crm/deletion 的 deleteImportBatch)。
    // 一批全部略過(0 筆寫入)時仍然回這個 id,前端不必分兩種情況處理。
    //
    // 呼叫端帶得進來:一次匯入大於 100 列時前端會切成好幾次 POST,整次匯入共用
    // 同一個識別碼,「刪掉這一批」才收得回全部。沒帶就在這裡生一個(直接打 API 的
    // 來源不一定有批次的概念),格式由 ImportRowsDto 擋成 UUID。
    const importBatchId = batchId ?? randomUUID();
    let skipped = 0;
    /** 逐列逐欄的問題;row 是檔案裡的列號(沒帶就 null),field 是欄位代碼 */
    const errors: Array<{ row: number | null; field: string; message: string }> = [];
    const pushError = (row: number | null, field: string, message: string) => {
      errors.push({ row, field, message });
    };
    let convertedAsInterested = 0; // 標成「已成交」但被降為前一階的筆數

    const stageByLabel = await this.stageLabelMap();
    const categoryByLabel = await this.categoryKeyMap();
    const catalog = await this.stageCatalogEntries();
    const inProgress = catalog.filter((st) => !st.isTerminal);
    // 「已成交」匯入時降到最接近終點的那一個進行中階段:成交只能經由客戶卡的成交流程產生
    // (要過場所類型與存證照片檢查),匯入不能直接把客戶標成已成交。
    const fallbackForWon = inProgress.length
      ? inProgress[inProgress.length - 1]!.key
      : await this.stageOf(undefined);
    const firstStage = await this.stageOf(undefined);
    // 查不到的進度標籤:記下來進錯誤報表,不安靜降階
    const unknownStageLabels = new Set<string>();
    let unknownStageRows = 0;
    // 查不到的商業分類:同樣進錯誤報表。那一格留空匯進來,不寫一個主檔裡沒有的值
    const unknownCategoryLabels = new Set<string>();
    let unknownCategoryRows = 0;

    // 1. 正規化 + 批內先擋掉沒有識別碼也沒有公司名的
    type Candidate = {
      taxId: string | null;
      companyName: string | null;
      rowNumber: number | null;
      data: Record<string, unknown>;
    };
    const candidates: Candidate[] = [];
    for (const raw of list) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const rowNumber =
        typeof r.rowNumber === 'number' && Number.isInteger(r.rowNumber) && r.rowNumber > 0
          ? r.rowNumber
          : null;
      const taxId = this.s(r.taxId);
      const companyName = this.s(r.companyName);
      if (!taxId && !companyName) {
        skipped += 1;
        pushError(rowNumber, 'taxId', '這一列的識別碼與公司名都空白,無法成為一筆客戶,已略過');
        continue;
      }
      const labelStage = this.s(r.stage) ?? '';
      // 沒填進度就是第一階,填了但查不到就照實回報(仍然匯進來,但使用者知道哪幾筆要改)
      let stage: string;
      if (labelStage === '') {
        stage = firstStage;
      } else {
        const hit = stageByLabel.get(labelStage);
        if (hit === undefined) {
          unknownStageLabels.add(labelStage);
          unknownStageRows += 1;
          stage = firstStage;
          pushError(
            rowNumber,
            'stage',
            `「${labelStage}」不在目前的階段設定裡,這一列已先放在第一階`,
          );
        } else {
          stage = hit;
        }
      }
      if (stage === WON_STAGE_KEY) {
        stage = fallbackForWon;
        convertedAsInterested += 1;
      }
      // 分類:空白就是沒填;主檔是空的(讀不到)就整批放行,照原樣收
      const rawCategory = this.s(r.category);
      let category: string | null = rawCategory;
      if (rawCategory !== null && categoryByLabel.size > 0) {
        const hitCategory = categoryByLabel.get(rawCategory);
        if (hitCategory === undefined) {
          unknownCategoryLabels.add(rawCategory);
          unknownCategoryRows += 1;
          category = null;
          pushError(
            rowNumber,
            'category',
            `「${rawCategory}」不在目前的商業分類設定裡,這一格已留空`,
          );
        } else {
          category = hitCategory;
        }
      }
      candidates.push({
        taxId,
        companyName,
        rowNumber,
        data: {
          taxId,
          companyName: companyName ?? '(未命名)',
          category,
          stage,
          contactName: this.s(r.contactName),
          contactPhone: this.s(r.contactPhone),
          note: this.s(r.note),
          // 地址三欄:沒有它們,這批客戶在拜訪地圖上等於不存在(見 ImportRowDto 的註解)
          actualAddress: this.s(r.actualAddress),
          registeredAddress: this.s(r.registeredAddress),
          contactAddress: this.s(r.contactAddress),
          ownerId: userId,
          importBatchId,
        },
      });
    }

    // 2. 一次查回既有的識別碼與公司名(只查這批會用到的值),建 Set 比對
    const taxIds = [
      ...new Set(candidates.map((c) => c.taxId).filter((v): v is string => v !== null)),
    ];
    const names = [
      ...new Set(candidates.map((c) => c.companyName).filter((v): v is string => v !== null)),
    ];
    const existing =
      taxIds.length || names.length
        ? await this.prisma.devCustomer.findMany({
            where: {
              // 查重要用「可見範圍」而不是「自己名下」。
              //
              // 用 ownerId: userId 的話,管理員與主管各自匯同一份名單,兩邊都查不到
              // 對方剛匯進來的那些,結果是一整套完整重複的客戶,只能靠查重一筆一筆收拾。
              // 業務的可見範圍本來就只有自己,對他來說行為完全沒變;主管與管理員
              // 則會擋到團隊 / 全公司既有的那些,這正是他們期待的。
              //
              // countableCustomerWhere():已被刪掉(與已被合併)的那些不算既有客戶。
              // 這一條是「匯錯 → 刪掉這一批 → 修好檔案 → 重新匯入」能不能走通的關鍵:
              // 不排掉的話,使用者刪乾淨之後重新匯入,每一列都會被判成「已經有這筆」而全數略過,
              // 畫面上寫著「略過 300 筆」,而清單裡一筆都沒有。
              ...countableCustomerWhere(),
              ...ownerFilter(view),
              OR: [
                ...(taxIds.length ? [{ taxId: { in: taxIds } }] : []),
                ...(names.length ? [{ companyName: { in: names } }] : []),
              ],
            },
            select: { taxId: true, companyName: true },
          })
        : [];
    const seenTaxIds = new Set(existing.map((e) => e.taxId).filter((v): v is string => v !== null));
    const seenNames = new Set(existing.map((e) => e.companyName));

    const toCreate: Record<string, unknown>[] = [];
    for (const c of candidates) {
      const dupTaxId = c.taxId !== null && seenTaxIds.has(c.taxId);
      const dupName = c.companyName !== null && seenNames.has(c.companyName);
      if (dupTaxId || dupName) {
        skipped += 1;
        pushError(
          c.rowNumber,
          dupTaxId ? 'taxId' : 'companyName',
          dupTaxId
            ? `已經有識別碼「${c.taxId}」的客戶,這一列略過`
            : `已經有名稱「${c.companyName}」的客戶,這一列略過`,
        );
        continue;
      }
      if (c.taxId) seenTaxIds.add(c.taxId);
      if (c.companyName) seenNames.add(c.companyName);
      toCreate.push(c.data);
    }

    // 3. 分段寫入;某一段失敗就停,前面已提交的段照實回報
    let created = 0;
    let failed = false;
    for (let i = 0; i < toCreate.length; i += IMPORT_CHUNK) {
      const chunk = toCreate.slice(i, i + IMPORT_CHUNK);
      try {
        const res = await this.prisma.devCustomer.createMany({ data: chunk as never });
        created += res.count;
      } catch (err) {
        // 只記錯誤 name:Prisma 的錯誤訊息會帶上這一段的欄位值(公司名、識別碼、地址),不進 log
        const name = err instanceof Error ? err.name : 'UnknownError';
        this.logger.warn(`[crm-import] 第 ${i / IMPORT_CHUNK + 1} 段寫入失敗(${name}),停止匯入`);
        failed = true;
        break;
      }
    }

    const notes: string[] = [];
    if (convertedAsInterested) {
      const wonLabel = catalog.find((st) => st.key === WON_STAGE_KEY)?.label ?? WON_STAGE_KEY;
      const toLabel = catalog.find((st) => st.key === fallbackForWon)?.label ?? fallbackForWon;
      notes.push(
        `有 ${convertedAsInterested} 筆標為「${wonLabel}」,已改為「${toLabel}」;成交請在客戶卡走「標記為成交」流程`,
      );
    }
    if (unknownStageRows) {
      const shown = [...unknownStageLabels].slice(0, UNKNOWN_STAGE_LABELS_SHOWN);
      const more = unknownStageLabels.size - shown.length;
      const firstLabel = catalog.find((st) => st.key === firstStage)?.label ?? firstStage;
      notes.push(
        `有 ${unknownStageRows} 筆的進度「${shown.join('、')}${more > 0 ? `」等 ${unknownStageLabels.size} 種` : '」'}` +
          `不在目前的階段設定裡,已先放在「${firstLabel}」;` +
          '請到系統設定確認階段名稱,或修正檔案後重新匯入這幾筆',
      );
    }
    if (unknownCategoryRows) {
      const shown = [...unknownCategoryLabels].slice(0, UNKNOWN_STAGE_LABELS_SHOWN);
      const more = unknownCategoryLabels.size - shown.length;
      notes.push(
        `有 ${unknownCategoryRows} 筆的分類「${shown.join('、')}${more > 0 ? `」等 ${unknownCategoryLabels.size} 種` : '」'}` +
          '不在目前的商業分類設定裡,那一格已留空;' +
          '請到系統設定確認分類名稱,或修正檔案後重新匯入這幾筆',
      );
    }
    if (failed) notes.push('部分資料寫入失敗,已匯入的筆數如上,請確認資料後再匯入其餘部分');
    const message = notes.length ? notes.join(';') : null;
    return {
      created,
      skipped,
      /** 這一批的識別碼:整批刪除(POST /api/admin/crm-trash/import-batch)用它 */
      importBatchId,
      /** 逐列逐欄的問題(最多 IMPORT_ERRORS_RETURNED 筆,總數看 errorCount) */
      errors: errors.slice(0, IMPORT_ERRORS_RETURNED),
      errorCount: errors.length,
      convertedAsInterested,
      unknownStageRows,
      unknownStageLabels: [...unknownStageLabels],
      unknownCategoryRows,
      unknownCategoryLabels: [...unknownCategoryLabels],
      message,
    };
  }
}

/**
 * 客戶卡(GET /api/admin/crm/:id)實際回應的型別必須符合共用契約。
 *
 * 刻意從方法本身的回傳型別推:那一支現在用 include(帶全部純量欄位),所以一定過。
 * 這一行的價值在日後有人把它改成 select 求效能的那一天 —— 少列一格就在這裡紅,
 * 而不是安靜地讓客戶卡少顯示一欄。
 * 這是型別層的宣告,沒有人讀它,編譯後不留任何程式碼。
 */
type _CustomerCardResponseMatchesContract = AssertAssignable<
  Awaited<ReturnType<CrmService['get']>>,
  CustomerCardRow
>;
