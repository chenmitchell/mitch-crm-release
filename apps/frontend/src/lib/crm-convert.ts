// 標記成交流程的純邏輯(客戶卡的「標記為成交」用)。
//
// 對應的後端端點:
//   GET  /api/admin/crm/:id/convert-check  回 { ok: boolean, reason: string | null }
//        reason 由後端 convertBlockReason 產生,已經是給人看的中文句子。
//        三種擋下的情況:場所類型沒選、該場所類型還沒設必拍清單、必拍照片缺件。
//   POST /api/admin/crm/:id/convert        body { externalRef?: string }(UUID,選填)
//
// 這個檔只放不碰 DOM、不碰 fetch 的判斷,測試在 tests/crm-convert.spec.ts。
// 這裡刻意不重寫任何一條「能不能成交」的規則:能不能成交一律由後端回答,
// 前端只做兩件事 —— 把後端說不出中文的訊息換成看得懂的句子,
// 以及決定「補件按鈕」要指向畫面上的哪一區。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { WON_STAGE_KEY } from '@mitchcrm/shared/vocab';

/** GET :id/convert-check 的回應 */
export interface ConvertCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * 客戶卡上已經知道的事實(來自存證照片清單 GET /api/admin/crm-checkin/:id/photos)。
 * 只拿來挑「補件入口指向哪一區」,不拿來自己判斷能不能成交。
 */
export interface ConvertFacts {
  /** 場所類型還沒選 */
  premisesTypeMissing: boolean;
  /** 必拍清單裡還缺幾張 */
  missingCount: number;
}

/** 補件入口:指向場所類型那一格、指向存證照片那一區,或兩者都不是 */
export type ConvertFixTarget = 'premises' | 'photos' | null;

export const CONVERT_CHECK_FALLBACK = '無法確認這筆客戶能不能標記成交,請稍後再試';
export const CONVERT_FAILED_FALLBACK = '標記成交失敗,請稍後再試';
/** 後端擋下來但說不出中文原因時的替代句(至少要說得出下一步) */
export const CONVERT_BLOCKED_FALLBACK = '目前還不能標記成交,請先補齊場所類型與存證照片,再重新檢查';
export const CONVERT_READY_TEXT = '條件已齊備,可以標記為成交';
export const EXTERNAL_REF_BLOCK_MESSAGE = '案件編號要是 UUID 格式,沒有就留空不填';

/** 已成交的判定,與後端 isConvertedCustomer 同一條:階段是成交,或已經有外部案件編號 */
export function isConvertedCustomer(c: {
  stage: string;
  externalCaseRef: string | null | undefined;
}): boolean {
  return c.stage === WON_STAGE_KEY || (c.externalCaseRef ?? null) !== null;
}

/** 這段字裡有沒有中日韓文字。沒有就代表它是英文或框架訊息,不能直接端給使用者看 */
export function hasChinese(text: string | null | undefined): boolean {
  return typeof text === 'string' && /[\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

/**
 * 把後端回的訊息收斂成一句看得懂的中文:講得出中文就原樣用,
 * 空的、英文的、技術性的(例如 Internal Server Error)一律換成 fallback。
 */
export function humanizeMessage(raw: string | null | undefined, fallback: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return hasChinese(text) ? text : fallback;
}

/** 把 convert-check 的回應收斂成固定形狀;形狀不對就回 null,由呼叫端顯示載入失敗 */
export function parseConvertCheck(raw: unknown): ConvertCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { ok?: unknown; reason?: unknown };
  if (typeof body.ok !== 'boolean') return null;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
  // ok 與 reason 互斥:後端說可以成交就不該有原因,反過來也一樣。
  // 兩者不一致時以 ok 為準(它才是送不送得出去的那一格)。
  return { ok: body.ok, reason: body.ok ? null : reason };
}

/** 被擋下來時要顯示的那句話 */
export function convertBlockText(check: ConvertCheck): string {
  if (check.ok) return CONVERT_READY_TEXT;
  return humanizeMessage(check.reason, CONVERT_BLOCKED_FALLBACK);
}

/**
 * 補件入口指向哪一區。
 *
 * 依據只有客戶卡上已經顯示的事實:場所類型沒選就指場所類型那一格,
 * 必拍照片缺件就指存證照片那一區。兩者都不成立(例如後台還沒設必拍清單)
 * 回 null —— 那是管理員要去後台設的,客戶卡上沒有補得起來的入口,
 * 這種時候只顯示後端那句話,不要給一顆按下去沒有用的按鈕。
 */
export function convertFixTarget(check: ConvertCheck, facts: ConvertFacts): ConvertFixTarget {
  if (check.ok) return null;
  if (facts.premisesTypeMissing) return 'premises';
  if (facts.missingCount > 0) return 'photos';
  return null;
}

/** UUID v4(與後端 ConvertDto 的 @IsUUID('4') 同一條);空字串代表不帶這個欄位 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 外部案件編號的格式檢查;通過(含留空)回 null,不通過回一句中文 */
export function externalRefBlockReason(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return UUID_V4_RE.test(v) ? null : EXTERNAL_REF_BLOCK_MESSAGE;
}
