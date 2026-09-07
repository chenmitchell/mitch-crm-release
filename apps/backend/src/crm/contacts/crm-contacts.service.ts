/**
 * 「我聯絡過的客戶」查詢服務。
 *
 * 定義:期間內有過任何互動紀錄(拜訪、電話、LINE、Email、報價、備註)的客戶,
 * 依「最近一次互動時間」由新到舊排序,給外勤頁當回訪清單用。
 *
 * 規則:
 * - 排除系統自己寫的紀錄(note 以「【」開頭:成交、移交、補拍照片等),那些不是業務真的去聯絡
 * - 排除已被查重合併掉的客戶(mergedIntoId 不為 null),資料都在保留的那一筆
 * - 可見範圍由 ViewScope 決定(自己 / 團隊與部門子樹 / 全部),controller 傳進來
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { Injectable } from '@nestjs/common';
import { relatedOwnerFilter, type ViewScope } from '../../scope/view-scope';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { humanInteractionWhere } from '../stats/crm-stats.service';

export const CONTACTS_DAYS_DEFAULT = 30;
export const CONTACTS_DAYS_MAX = 365;
export const CONTACTS_LIMIT_DEFAULT = 100;
export const CONTACTS_LIMIT_MAX = 200;

export interface ContactRow {
  customerId: string;
  companyName: string | null;
  taxId: string | null;
  stage: string;
  ownerName: string | null;
  /** 最近一次互動的管道與時間 */
  lastChannel: string;
  lastAt: string;
  lastNote: string | null;
  /** 最近一次互動留下的下一步(沒有就退回客戶卡上的下次跟進日) */
  nextAction: string | null;
  nextFollowUpAt: string | null;
}

/** 把使用者傳進來的數字參數夾在合理範圍內(非數字就用預設) */
export function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n =
    typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

@Injectable()
export class CrmContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    view: ViewScope,
    opts: { days?: unknown; limit?: unknown } = {},
  ): Promise<{ days: number; rows: ContactRow[] }> {
    const days = clampInt(opts.days, CONTACTS_DAYS_DEFAULT, 1, CONTACTS_DAYS_MAX);
    const limit = clampInt(opts.limit, CONTACTS_LIMIT_DEFAULT, 1, CONTACTS_LIMIT_MAX);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const where: Prisma.DevInteractionWhereInput = {
      occurredAt: { gte: since },
      // 排除系統紀錄要用 crm-stats 的 humanInteractionWhere():
      // NOT { startsWith } 在 note 為 NULL 時 SQL 判斷結果是 NULL,會把「沒寫備註的互動」整批濾掉
      ...humanInteractionWhere(),
      customer: {
        mergedIntoId: null,
        // 已刪除的客戶不進最近聯絡清單:客戶都刪了,聯絡紀錄卻還掛在畫面上會讓人以為刪失敗
        deletedAt: null,
        ...((relatedOwnerFilter(view).customer as Record<string, unknown>) ?? {}),
      },
    };

    // 先用 groupBy 取每個客戶的最近互動時間,排序取前 N 個客戶
    const grouped = await this.prisma.devInteraction.groupBy({
      by: ['customerId'],
      where,
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: 'desc' } },
      take: limit,
    });
    // groupBy 已經算出每個客戶的最近互動時間,直接用 (customerId, occurredAt) 配對精準取那一列:
    // 每個客戶剛好一列(同一秒有兩筆才會多,下面的 seen 會擋),不必 distinct、也不必猜筆數上限
    const pairs = grouped
      .filter((g): g is typeof g & { _max: { occurredAt: Date } } => g._max.occurredAt != null)
      .map((g) => ({ customerId: g.customerId, occurredAt: g._max.occurredAt }));
    if (pairs.length === 0) return { days, rows: [] };

    const details = await this.prisma.devInteraction.findMany({
      // 用 AND 包起來:where 自己就有一個 OR(排除系統紀錄),直接展開會被 pairs 的 OR 蓋掉
      where: { AND: [where, { OR: pairs }] },
      orderBy: { occurredAt: 'desc' },
      include: {
        customer: {
          select: {
            id: true,
            companyName: true,
            taxId: true,
            stage: true,
            nextFollowUpAt: true,
            owner: { select: { name: true } },
          },
        },
      },
    });

    const seen = new Set<string>();
    const rows: ContactRow[] = [];
    for (const d of details) {
      if (seen.has(d.customerId)) continue;
      seen.add(d.customerId);
      rows.push({
        customerId: d.customerId,
        companyName: d.customer.companyName,
        taxId: d.customer.taxId,
        stage: d.customer.stage,
        ownerName: d.customer.owner?.name ?? null,
        lastChannel: d.channel,
        lastAt: d.occurredAt.toISOString(),
        lastNote: d.note ?? null,
        nextAction: d.nextAction ?? null,
        nextFollowUpAt: d.customer.nextFollowUpAt ? d.customer.nextFollowUpAt.toISOString() : null,
      });
    }
    return { days, rows };
  }
}
