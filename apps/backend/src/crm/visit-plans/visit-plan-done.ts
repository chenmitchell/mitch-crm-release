/**
 * 打卡成功後把該客戶「組織時區的今天」的 planned 排程標成 done 並掛上互動 id。
 * 做成純函式(吃交易物件)讓 CrmCheckinService 在同一筆交易內呼叫,不需要注入 VisitPlansService。
 * 沒有排程就什麼都不做(updateMany 影響 0 筆)。
 * today 由呼叫端(CrmCheckinService)算好傳進來 —— 只有它拿得到組織設定的時區,
 * 這支要能在交易內同步呼叫,不適合自己去讀設定。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { dateKeyToUtcMidnight } from '@mitchcrm/shared';
import type { PrismaService } from '../../prisma/prisma.service';

/** 'YYYY-MM-DD' → @db.Date 用的 UTC 午夜 Date */
export function dateOnlyToUtc(dateStr: string): Date {
  return dateKeyToUtcMidnight(dateStr);
}

/**
 * 「已經過期、該標成 missed」的排程條件(純函式,方便測試)。
 *
 * 比較一定是 lt(嚴格早於今天),不是 lte:今天的排程還沒過期,
 * 用 lte 的話使用者一早打開拜訪排程頁,今天要跑的每一筆已經被標成「錯過」,
 * 而且是 GET 就改掉的,重整也回不來。這個差別只有一個字母,不會有型別錯誤,
 * 畫面上也不會有錯誤訊息,所以只能靠測試釘住。
 */
export function overdueVisitPlanWhere(today: string): {
  status: 'planned';
  plannedDate: { lt: Date };
} {
  return { status: 'planned', plannedDate: { lt: dateOnlyToUtc(today) } };
}

export async function markVisitPlanDone(
  tx: Pick<PrismaService, 'devVisitPlan'>,
  customerId: string,
  interactionId: string,
  today: string,
): Promise<number> {
  const r = await tx.devVisitPlan.updateMany({
    where: { customerId, plannedDate: dateOnlyToUtc(today), status: 'planned' },
    data: { status: 'done', interactionId },
  });
  return r.count;
}
