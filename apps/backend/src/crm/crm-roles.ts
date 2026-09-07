// ref:3687 mc/陳彥輔/米球®
/**
 * CRM 的角色守衛。
 *
 * 為什麼要一支共用的:同一個判斷原本抄在七個 controller 裡
 * (crm / crm-checkin / crm-contacts / crm-daily-reports / crm-duplicates /
 *  crm-map / crm-visit-plans),角色清單寫死七次、拒絕訊息也重複七次,
 * 而且同一件事有兩種寫法 —— crm.controller.ts 的主管守衛回
 * 「僅訪查主管與系統管理員可執行此操作」,crm-stats.controller.ts 回
 * 「僅訪查主管與系統管理員可檢視戰情圖表」。
 *
 * 抄七份的代價是:哪天要多一個能用 CRM 的角色,漏改一處的症狀是
 * 「有些頁面進得去、有些回 403」,而使用者只會覺得系統壞了。
 *
 * users.service.ts 原本也自己寫了一份 CRM_ROLES(它用來擋「把人設成不能用 CRM
 * 的角色」),現在一併吃這一份 —— 那兩份走散的話,後台設得出一個角色,
 * 設完那個人卻進不了任何一頁。
 */
import { ForbiddenException } from '@nestjs/common';
import { CRM_FORBIDDEN_MESSAGE, CRM_MANAGER_FORBIDDEN_MESSAGE } from './crm-messages';

/** 可以使用 CRM 的角色 */
export const CRM_ROLES: readonly string[] = ['admin', 'sales', 'sales_manager'];

/**
 * 看得到別人資料、可以做主管級操作(審日報、看戰情圖表)的角色。
 * 實際「看得到誰」由 AccessScopeService 決定,這裡只管「能不能做這件事」。
 */
export const CRM_MANAGER_ROLES: readonly string[] = ['admin', 'sales_manager'];

export function isCrmRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && CRM_ROLES.includes(role);
}

export function isCrmManagerRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && CRM_MANAGER_ROLES.includes(role);
}

/** 不是 CRM 角色就 403。訊息共用一份,七個 controller 講同一句話 */
export function assertCrmRole(role: string | null | undefined): void {
  if (!isCrmRole(role)) throw new ForbiddenException(CRM_FORBIDDEN_MESSAGE);
}

/** 不是主管級角色就 403 */
export function assertCrmManagerRole(role: string | null | undefined): void {
  if (!isCrmManagerRole(role)) throw new ForbiddenException(CRM_MANAGER_FORBIDDEN_MESSAGE);
}
