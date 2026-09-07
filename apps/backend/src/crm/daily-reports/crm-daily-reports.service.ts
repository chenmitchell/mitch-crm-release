/**
 * 日報彙整服務:業務把外勤頁的日報文字送給主管,同人同日 upsert(覆蓋並重置已讀);
 * 主管/admin 可列全部、標已讀、寫批註,並查「今天誰交了、誰還沒」(status=active 且 role=sales)。
 * 日期一律以「組織設定的時區」的日曆日計(系統設定 → 地區與語系 → 時區),
 * 存進 report_date(@db.Date)時用 UTC 午夜表示該日。
 * 時區從 OrgTimeService 讀,計算在 @mitchcrm/shared 的 org-time —— 這裡不再自己算偏移。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { authorFilter, type ViewScope } from '../../scope/view-scope';
import { Prisma } from '@prisma/client';
import { addCalendarDays, orgToday } from '@mitchcrm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgTimeService } from '../../settings/org-time.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 查詢區間上限(天),避免一次撈太多 */
const MAX_RANGE_DAYS = 366;
/** stats 最多保留的 key 數 */
const MAX_STATS_KEYS = 30;
/** 日報可補交的天數:組織時區的今天往前 7 天到今天 */
const SUBMIT_BACKFILL_DAYS = 7;
/** list 只給 to 沒給 from 時,from 補成 to 往前這麼多天 */
const LIST_DEFAULT_SPAN_DAYS = 30;
const DAY_MS = 86400000;

export interface DailyReportRow {
  id: string;
  userId: string;
  userName: string;
  reportDate: string;
  content: string;
  stats: Record<string, number> | null;
  submittedAt: string;
  readAt: string | null;
  managerNote: string | null;
}

/**
 * 日報日期是否可送:組織時區的今天往前 SUBMIT_BACKFILL_DAYS 天到今天(含兩端)。
 * 字串比較就夠,因為兩邊都是 YYYY-MM-DD。
 * today 一律由呼叫端算好傳進來(它才知道組織時區),這裡不自己取現在時間。
 */
export function isSubmittableReportDate(dateStr: string, today: string): boolean {
  const earliest = addCalendarDays(today, -SUBMIT_BACKFILL_DAYS);
  return dateStr >= earliest && dateStr <= today;
}

/** 'YYYY-MM-DD' → @db.Date 用的 UTC 午夜 Date;格式或日期不合法丟 400 */
function parseDateOnly(s: string, label: string): Date {
  if (!DATE_RE.test(s)) throw new BadRequestException(`${label}格式須為 YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new BadRequestException(`${label}不是有效日期`);
  }
  return d;
}

/**
 * list 的日期區間補齊:只給 from → to = 組織時區的今天;只給 to → from = to - 30 天;
 * 都沒給或都有給就原樣回。to 不是合法日期時直接丟 400(迄日),不會拿壞掉的字串去算。
 */
export function completeDateRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
): { from?: string; to?: string } {
  if (from && !to) return { from, to: today };
  if (!from && to) {
    parseDateOnly(to, '迄日');
    return { from: addCalendarDays(to, -LIST_DEFAULT_SPAN_DAYS), to };
  }
  return { from, to };
}

/** 只保留有限數值的 key,其餘丟掉(stats 是給儀表板看的數字,不收任意物件) */
function sanitizeStats(input: unknown): Record<string, number> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_STATS_KEYS) break;
    if (typeof v === 'number' && Number.isFinite(v) && k.length <= 40) {
      out[k] = v;
      n += 1;
    }
  }
  return n ? out : null;
}

@Injectable()
export class CrmDailyReportsService {
  /**
   * OrgTimeService 用 @Optional:既有單元測試直接 new CrmDailyReportsService(prisma),
   * 沒帶就退回出廠時區,行為與可設定之前一致。
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /** 組織時區的今天;沒注入 OrgTimeService 時退回出廠時區 */
  private async today(now: Date = new Date()): Promise<string> {
    return this.orgTime ? this.orgTime.today(now) : orgToday(now);
  }

  private toRow(r: {
    id: string;
    userId: string;
    user?: { name: string } | null;
    reportDate: Date;
    content: string;
    stats: Prisma.JsonValue | null;
    submittedAt: Date;
    readAt: Date | null;
    managerNote: string | null;
  }): DailyReportRow {
    return {
      id: r.id,
      userId: r.userId,
      userName: r.user?.name ?? '(未知)',
      reportDate: r.reportDate.toISOString().slice(0, 10),
      content: r.content,
      stats: sanitizeStats(r.stats),
      submittedAt: r.submittedAt.toISOString(),
      readAt: r.readAt ? r.readAt.toISOString() : null,
      managerNote: r.managerNote,
    };
  }

  /**
   * 送出日報:同人同日覆蓋,更新 submittedAt、清掉 readAt/readById/managerNote
   * (主管要重新看)。
   * 日期只能是組織時區今天往前 7 天到今天,不能交未來或更早的日報。
   * upsert 在兩個請求同時建立同一筆時可能撞 unique(P2002),抓到就再 upsert 一次(第二次會走 update)。
   */
  async submit(userId: string, dto: { reportDate?: string; content: string; stats?: unknown }) {
    const today = await this.today();
    const dateStr = dto.reportDate ?? today;
    const reportDate = parseDateOnly(dateStr, '報告日期');
    if (!isSubmittableReportDate(dateStr, today)) {
      throw new BadRequestException(`報告日期只能是今天往前 ${SUBMIT_BACKFILL_DAYS} 天到今天`);
    }
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('日報內容不可空白');
    const stats = sanitizeStats(dto.stats);
    const statsValue: Prisma.InputJsonValue | typeof Prisma.JsonNull = stats ?? Prisma.JsonNull;
    const doUpsert = () =>
      this.prisma.devDailyReport.upsert({
        where: { userId_reportDate: { userId, reportDate } },
        create: { userId, reportDate, content, stats: statsValue },
        update: {
          content,
          stats: statsValue,
          submittedAt: new Date(),
          readAt: null,
          readById: null,
          /*
           * 批註也要一起清掉。
           *
           * 已讀狀態清了、批註沒清的話,重送之後畫面上那句主管的話仍然掛在
           * 這一列上,而它指的是已經被覆蓋掉的舊內容 —— 例如訪查人員把
           * 「今天跑了三家」改成「今天請假」,主管那句「這三家的後續呢?」
           * 還在原地,兩邊都看不出它是對舊版寫的。
           * 而且主管的下一次批註只有一格可以寫,不是新增一則,舊的一定會被蓋掉;
           * 留著它等於留一句沒有人能修正、也對不上內容的話。
           * 清掉之後這一列回到「已重送、等主管看」的狀態,語意跟 readAt 一致。
           */
          managerNote: null,
        },
        include: { user: { select: { name: true } } },
      });
    let row: Awaited<ReturnType<typeof doUpsert>>;
    try {
      row = await doUpsert();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        row = await doUpsert();
      } else {
        throw err;
      }
    }
    return this.toRow(row);
  }

  /**
   * 列表:可見範圍由 ViewScope 決定;看得到別人的才能再篩某一位。依 reportDate desc、userName asc。
   * 只給 from 就把 to 補成組織時區的今天;只給 to 就把 from 補成 to 往前 30 天;都不給就不限日期(仍有 take 上限)。
   */
  async list(
    userId: string,
    view: ViewScope,
    opts: { from?: string; to?: string; userId?: string } = {},
  ): Promise<DailyReportRow[]> {
    const where: Prisma.DevDailyReportWhereInput = {
      ...(authorFilter(view) as Prisma.DevDailyReportWhereInput),
    };
    // 指定某一位時,那個人也必須在可見範圍內,否則忽略指定(不越權)
    if (opts.userId && (view.viewAll || view.ownerIds.includes(opts.userId))) {
      where.userId = opts.userId;
    }

    const { from: fromStr, to: toStr } = completeDateRange(opts.from, opts.to, await this.today());
    const from = fromStr ? parseDateOnly(fromStr, '起日') : null;
    const to = toStr ? parseDateOnly(toStr, '迄日') : null;
    if (from && to) {
      if (from.getTime() > to.getTime()) throw new BadRequestException('起日不可晚於迄日');
      const days = (to.getTime() - from.getTime()) / DAY_MS;
      if (days > MAX_RANGE_DAYS) throw new BadRequestException(`查詢區間最多 ${MAX_RANGE_DAYS} 天`);
    }
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
      where.reportDate = range;
    }

    const rows = await this.prisma.devDailyReport.findMany({
      where,
      orderBy: [{ reportDate: 'desc' }, { user: { name: 'asc' } }],
      include: { user: { select: { name: true } } },
      take: 2000,
    });
    return rows.map((r) => this.toRow(r));
  }

  /**
   * 主管批註 / 標已讀(controller 已擋角色,這裡再擋可見範圍)。
   *
   * 角色守衛只回答「是不是主管」,回答不了「是不是**他的**團隊」。
   * 沒有這一段的話,調動過的主管手上留著調動前的日報 id,調動後仍然改得動
   * 別的團隊的批註與已讀狀態,而且回應會把日報全文一起帶回去。
   * 查不到與沒權限回同一句話:兩者分開講等於告訴呼叫者「這個 id 存在,只是不給你」。
   */
  async review(
    id: string,
    reviewerId: string,
    view: ViewScope,
    dto: { managerNote?: string; markRead?: boolean },
  ) {
    const exists = await this.prisma.devDailyReport.findFirst({
      where: { id, ...(authorFilter(view) as Prisma.DevDailyReportWhereInput) },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('找不到此日報');
    const data: Prisma.DevDailyReportUpdateInput = {};
    if (dto.managerNote !== undefined) {
      const note = dto.managerNote.trim();
      data.managerNote = note.length ? note : null;
    }
    if (dto.markRead === true) {
      data.readAt = new Date();
      data.readById = reviewerId;
    } else if (dto.markRead === false) {
      data.readAt = null;
      data.readById = null;
    }
    // 寫批註但沒明講已讀,視同主管已看過
    if (dto.managerNote !== undefined && dto.markRead === undefined) {
      data.readAt = new Date();
      data.readById = reviewerId;
    }
    const row = await this.prisma.devDailyReport.update({
      where: { id },
      data,
      include: { user: { select: { name: true } } },
    });
    return this.toRow(row);
  }

  /**
   * 今天(組織時區)誰交了、誰還沒:對象是 status=active 且 role=sales 的使用者,
   * 再依 ViewScope 限縮成呼叫者看得到的那些人。
   *
   * 沒有這一段的話,任何一位訪查主管打這一支就拿到全公司的在職業務名冊
   * 以及誰交了日報 —— 跨團隊、跨部門,而且畫面上完全正常,看不出多了誰。
   * 口徑與 CrmController 的 sales-users 一致(見那支的註解)。
   */
  async todayStatus(view: ViewScope) {
    const date = await this.today();
    const reportDate = parseDateOnly(date, '報告日期');
    const [sales, submittedRows] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          role: 'sales',
          status: 'active',
          ...(view.viewAll ? {} : { id: { in: [...view.ownerIds] } }),
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.devDailyReport.findMany({
        where: { reportDate, ...(authorFilter(view) as Prisma.DevDailyReportWhereInput) },
        select: { userId: true },
      }),
    ]);
    const done = new Set(submittedRows.map((r) => r.userId));
    const submitted: { userId: string; userName: string }[] = [];
    const missing: { userId: string; userName: string }[] = [];
    for (const u of sales) {
      (done.has(u.id) ? submitted : missing).push({ userId: u.id, userName: u.name });
    }
    return { date, submitted, missing };
  }
}
