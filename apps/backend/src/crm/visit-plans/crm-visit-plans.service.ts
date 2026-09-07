/**
 * 拜訪排程服務:業務先把「哪天要去哪家」排好,打卡時自動核銷(見 visit-plan-done.ts)。
 * 一筆排程 = 客戶 + 組織時區的日曆日(@@unique),同客戶同天重排就是覆蓋。
 * 存取範圍與 CrmService 一致,由 ViewScope 決定(自己 / 團隊與部門子樹 / 全部);
 * 排程的 ownerId 一律用客戶的 ownerId(主管幫業務排,也是算在那位業務頭上)。
 * 授權一律以「客戶目前的 ownerId」為準(where customer: { ownerId }),不看排程列上的 ownerId 快照:
 * 客戶移交後,舊業務不能再從排程讀到公司名、識別碼、地址,也不能取消新業務的排程。
 * 過期:GET 時把「可見範圍內、planned 且日期已過」的順手改成 missed,一次最多 EXPIRE_BATCH 筆。
 * 「已過」是嚴格早於今天(lt)。用 lte 的話,今天早上排下午要去的拜訪,一打開清單就被
 * 標成「未完成」,而且改不回來 —— 邊界測試見 crm-visit-plans.service.spec.ts。
 * 「今天」以組織設定的時區計(OrgTimeService),不是伺服器時間也不是寫死的 UTC+8。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { VisitPlanStatus } from '@prisma/client';
import { addCalendarDays, orgToday } from '@mitchcrm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgTimeService } from '../../settings/org-time.service';
import { canSeeOwner, relatedOwnerFilter, type ViewScope } from '../../scope/view-scope';
import { lockCustomerRow } from '../lock';
import { CUSTOMER_NOT_FOUND_MESSAGE } from '../crm-messages';
import { pickAddress } from '../map/crm-geo.service';
import { DATE_RE } from './dto/visit-plan.dto';
import { dateOnlyToUtc, overdueVisitPlanWhere } from './visit-plan-done';
// UUID 格式的判準全後端共用一份(見 common/uuid.ts),不要在檔案裡再寫一條正規表示式
import { UUID_RE } from '../../common/uuid';

/** 那天已經打卡核銷,不可覆蓋 */
const PLAN_DONE_MESSAGE = '這天已完成拜訪,不需要再排';

/** 查詢區間上限(天) */
const MAX_RANGE_DAYS = 62;
/** 最多可以排到幾天後 */
const MAX_AHEAD_DAYS = 90;
/** GET 時順手標 missed 的批次上限 */
const EXPIRE_BATCH = 200;
/** 單次 list 回傳上限 */
const LIST_TAKE = 1000;

export interface VisitPlanRow {
  id: string;
  customerId: string;
  ownerId: string;
  ownerName: string;
  plannedDate: string;
  status: VisitPlanStatus;
  note: string | null;
  interactionId: string | null;
  companyName: string;
  taxId: string | null;
  address: string;
  stage: string;
}

export interface ListOpts {
  from?: string;
  to?: string;
  ownerId?: string;
  customerId?: string;
}

/** 'YYYY-MM-DD' 驗格式與有效性;不合法丟 400 */
function parseDateOnly(s: string, label: string): string {
  if (!DATE_RE.test(s)) throw new BadRequestException(`${label}格式須為 YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new BadRequestException(`${label}不是有效日期`);
  }
  return s;
}

const planSelect = {
  id: true,
  customerId: true,
  ownerId: true,
  plannedDate: true,
  status: true,
  note: true,
  interactionId: true,
  owner: { select: { name: true } },
  customer: {
    select: {
      companyName: true,
      taxId: true,
      stage: true,
      actualAddress: true,
      registeredAddress: true,
      contactAddress: true,
    },
  },
} as const;

type PlanRecord = {
  id: string;
  customerId: string;
  ownerId: string;
  plannedDate: Date;
  status: VisitPlanStatus;
  note: string | null;
  interactionId: string | null;
  owner: { name: string };
  customer: {
    companyName: string;
    taxId: string | null;
    stage: string;
    actualAddress: string | null;
    registeredAddress: string | null;
    contactAddress: string | null;
  };
};

function toRow(p: PlanRecord): VisitPlanRow {
  return {
    id: p.id,
    customerId: p.customerId,
    ownerId: p.ownerId,
    ownerName: p.owner.name,
    plannedDate: p.plannedDate.toISOString().slice(0, 10),
    status: p.status,
    note: p.note,
    interactionId: p.interactionId,
    companyName: p.customer.companyName,
    taxId: p.customer.taxId,
    address: pickAddress(p.customer),
    stage: p.customer.stage,
  };
}

@Injectable()
export class CrmVisitPlansService {
  /**
   * OrgTimeService 用 @Optional:既有單元測試直接 new CrmVisitPlansService(prisma),
   * 沒帶就退回出廠時區,行為與可設定之前一致。
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /** 組織時區的今天 */
  private async today(now: Date = new Date()): Promise<string> {
    return this.orgTime ? this.orgTime.today(now) : orgToday(now);
  }

  /** 找客戶並套用可見範圍;不存在與無權限都回 404,不洩漏客戶是否存在;已合併的回 400 */
  private async loadCustomer(customerId: string, userId: string, view: ViewScope) {
    const c = await this.prisma.devCustomer.findUnique({
      where: { id: customerId },
      select: { id: true, ownerId: true, mergedIntoId: true, deletedAt: true },
    });
    // 已刪除的客戶跟不存在一樣回 404:不能再排新的拜訪
    if (!c || c.deletedAt || !canSeeOwner(view, c.ownerId))
      throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    if (c.mergedIntoId)
      throw new BadRequestException('此客戶已合併到另一筆,請到保留的那筆客戶卡排程');
    return c;
  }

  /** 排程日期要在組織時區的今天到 MAX_AHEAD_DAYS 天後之間 */
  private assertPlannableDate(dateStr: string, today: string) {
    if (dateStr < today) throw new BadRequestException('排程日期不能早於今天');
    if (dateStr > addCalendarDays(today, MAX_AHEAD_DAYS)) {
      throw new BadRequestException(`最多只能排到 ${MAX_AHEAD_DAYS} 天後`);
    }
  }

  /**
   * 列鎖之後在交易內重讀客戶目前的負責人與合併狀態。
   * 鎖外的 loadCustomer 只做「看得到嗎」的存取檢查,它讀到的 ownerId 是舊快照;
   * 排程要落地的 ownerId 必須是鎖內這一份,不然與 transfer 併發時會寫進已經不負責的業務。
   */
  private async reloadOwnerInTx(
    tx: Pick<PrismaService, 'devCustomer'>,
    customerId: string,
  ): Promise<string> {
    const c = await tx.devCustomer.findUnique({
      where: { id: customerId },
      select: { ownerId: true, mergedIntoId: true, deletedAt: true },
    });
    if (!c || c.deletedAt) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    if (c.mergedIntoId)
      throw new BadRequestException('此客戶已合併到另一筆,請到保留的那筆客戶卡排程');
    return c.ownerId;
  }

  /**
   * 在交易內寫一筆排程。前提:呼叫端已經 lockCustomerRow(與打卡同一把列鎖),
   * 所以這裡的「更新不到就新增」不會跟併發的打卡 / 另一個排程請求交錯。
   * 條件式 updateMany(status not done)是第二道保險:即使沒鎖到,也不會把已核銷的
   * 排程打回 planned、把 interactionId 清掉。
   */
  private async writePlanInTx(
    tx: Pick<PrismaService, 'devVisitPlan'>,
    customerId: string,
    ownerId: string,
    plannedDate: Date,
    note: string | null,
  ): Promise<PlanRecord> {
    // 取消 / 錯過的重排就回到 planned;ownerId 跟著客戶目前的負責人(轉派後重排也會對)
    const updated = await tx.devVisitPlan.updateMany({
      where: { customerId, plannedDate, status: { not: 'done' } },
      data: { note, status: 'planned', ownerId, interactionId: null },
    });
    if (updated.count === 0) {
      // 更新不到:不是「還不存在」就是「已經 done」,查一次分辨
      const existing = await tx.devVisitPlan.findUnique({
        where: { customerId_plannedDate: { customerId, plannedDate } },
        select: { id: true },
      });
      if (existing) throw new BadRequestException(PLAN_DONE_MESSAGE);
      return tx.devVisitPlan.create({
        data: { customerId, ownerId, plannedDate, note, status: 'planned' },
        select: planSelect,
      });
    }
    const row = await tx.devVisitPlan.findUnique({
      where: { customerId_plannedDate: { customerId, plannedDate } },
      select: planSelect,
    });
    if (!row) throw new NotFoundException('找不到此拜訪排程');
    return row;
  }

  /** 單筆建立 / 覆蓋;那天已經 done 的不覆蓋(回 400) */
  async upsert(
    userId: string,
    view: ViewScope,
    dto: { customerId: string; plannedDate: string; note?: string },
  ): Promise<VisitPlanRow> {
    const today = await this.today();
    const dateStr = parseDateOnly(dto.plannedDate, '排程日期');
    this.assertPlannableDate(dateStr, today);
    const customer = await this.loadCustomer(dto.customerId, userId, view);
    const note = dto.note?.trim() || null;
    const plannedDate = dateOnlyToUtc(dateStr);

    return this.prisma.$transaction(async (tx) => {
      await lockCustomerRow(tx, customer.id);
      // ownerId 一定要在列鎖之後於交易內重讀(同 crm.service.markConverted 的做法):
      // 鎖外讀到的是快照,與 transfer 併發時排程會用舊業務落地,舊業務還看得到 / 能取消新業務的排程
      const ownerId = await this.reloadOwnerInTx(tx, customer.id);
      const row = await this.writePlanInTx(tx, customer.id, ownerId, plannedDate, note);
      return toRow(row);
    });
  }

  /** 一次排多天(例如連續一週);已 done 的那幾天跳過,回在 skipped 裡 */
  async bulk(
    userId: string,
    view: ViewScope,
    dto: { customerId: string; dates: string[]; note?: string },
  ): Promise<{ rows: VisitPlanRow[]; skipped: string[] }> {
    const today = await this.today();
    const dates = [...new Set(dto.dates.map((d) => parseDateOnly(d, '排程日期')))].sort();
    for (const d of dates) this.assertPlannableDate(d, today);
    const customer = await this.loadCustomer(dto.customerId, userId, view);
    const note = dto.note?.trim() || null;

    // 已 done 的判斷也放進交易(並在列鎖之後才算),不然「算 skipped」與「寫入」中間
    // 被打卡插進來,那天的核銷結果就會被覆蓋掉
    return this.prisma.$transaction(async (tx) => {
      await lockCustomerRow(tx, customer.id);
      // 同 upsert:ownerId 在鎖內重讀,不用鎖外那份快照
      const ownerId = await this.reloadOwnerInTx(tx, customer.id);
      const doneRows = await tx.devVisitPlan.findMany({
        where: {
          customerId: customer.id,
          status: 'done',
          plannedDate: { in: dates.map(dateOnlyToUtc) },
        },
        select: { plannedDate: true },
      });
      const skipped = new Set(doneRows.map((r) => r.plannedDate.toISOString().slice(0, 10)));
      const rows: VisitPlanRow[] = [];
      for (const d of dates) {
        if (skipped.has(d)) continue;
        const row = await this.writePlanInTx(tx, customer.id, ownerId, dateOnlyToUtc(d), note);
        rows.push(toRow(row));
      }
      return { rows, skipped: [...skipped].sort() };
    });
  }

  /**
   * 可見範圍的 where 片段。一律以客戶目前的 ownerId 判斷(join customer),
   * 不看排程列上的 ownerId 快照 —— 客戶移交後那個快照可能還是舊業務。
   */
  private visibleWhere(view: ViewScope, ownerId?: string) {
    // 指定某一位業務時,那個人也必須在可見範圍內,否則忽略指定(不越權)
    // deletedAt: null 一定要帶:客戶刪掉之後,他名下的排程還留在資料表裡,
    // 不排掉的話今日拜訪清單上會出現一筆點不進去的客戶
    if (ownerId && (view.viewAll || view.ownerIds.includes(ownerId))) {
      return { customer: { ownerId, deletedAt: null } };
    }
    const related = relatedOwnerFilter(view).customer as Record<string, unknown> | undefined;
    return { customer: { ...(related ?? {}), deletedAt: null } };
  }

  /**
   * 可見範圍內、日期已過仍是 planned 的排程 → missed,一次最多 EXPIRE_BATCH 筆。
   * 比較用 lt(嚴格早於今天):今天的排程還沒過期,把它標成 missed 等於一早就宣告錯過。
   */
  private async expireOverdue(view: ViewScope, today: string): Promise<void> {
    const stale = await this.prisma.devVisitPlan.findMany({
      where: { ...overdueVisitPlanWhere(today), ...this.visibleWhere(view) },
      select: { id: true },
      orderBy: { plannedDate: 'asc' },
      take: EXPIRE_BATCH,
    });
    if (stale.length === 0) return;
    await this.prisma.devVisitPlan.updateMany({
      where: { id: { in: stale.map((s) => s.id) }, status: 'planned' },
      data: { status: 'missed' },
    });
  }

  /**
   * 區間內的排程(from / to 皆為組織時區的日曆日,含兩端;預設今天到今天)。
   * 回傳範圍依 ViewScope;主管與 admin 可再用 ownerId 篩到某一位;customerId 可再縮到單一客戶。
   */
  async list(userId: string, view: ViewScope, opts: ListOpts): Promise<VisitPlanRow[]> {
    const today = await this.today();
    const from = opts.from ? parseDateOnly(opts.from, '起日') : today;
    const to = opts.to ? parseDateOnly(opts.to, '迄日') : from;
    if (to < from) throw new BadRequestException('迄日不能早於起日');
    if (to > addCalendarDays(from, MAX_RANGE_DAYS))
      throw new BadRequestException(`查詢區間最多 ${MAX_RANGE_DAYS} 天`);
    if (opts.ownerId !== undefined && !UUID_RE.test(opts.ownerId)) {
      throw new BadRequestException('訪查人員 id 格式錯誤');
    }
    if (opts.customerId !== undefined && !UUID_RE.test(opts.customerId)) {
      throw new BadRequestException('客戶 id 格式錯誤');
    }

    await this.expireOverdue(view, today);

    const rows = await this.prisma.devVisitPlan.findMany({
      where: {
        plannedDate: { gte: dateOnlyToUtc(from), lte: dateOnlyToUtc(to) },
        ...this.visibleWhere(view, opts.ownerId),
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
      },
      orderBy: [{ plannedDate: 'asc' }, { createdAt: 'asc' }],
      take: LIST_TAKE,
      select: planSelect,
    });
    return rows.map(toRow);
  }

  /**
   * 取消:只有 planned 能取消;看不到的回 404。
   *
   * 客戶在回收桶裡的排程也是 404,理由跟 loadCustomer 那一段一樣而且更實際:
   * 軟刪除不會順手把排程收掉,所以刪掉一筆排了明天的客戶之後,那一列會永遠停在
   * planned —— 清單看不到它(visibleWhere 帶 deletedAt: null),expireOverdue 也
   * 掃不到它,可是這一支照樣改得動,而且成功的回應會把那筆客戶的公司名、識別碼
   * 與地址一起帶回去(見 planSelect / toRow)。等於「刪掉的東西真的看不見」在這
   * 一條路徑上不成立:客戶卡 404、照片 404、清單查不到,舊的排程 id 卻讀得出內容。
   */
  async cancel(id: string, userId: string, view: ViewScope): Promise<VisitPlanRow> {
    // 授權看客戶目前的負責人,不看排程上的 ownerId 快照(移交後舊業務不能取消新業務的排程)
    const p = await this.prisma.devVisitPlan.findUnique({
      where: { id },
      select: { status: true, customer: { select: { ownerId: true, deletedAt: true } } },
    });
    if (!p || p.customer.deletedAt || !canSeeOwner(view, p.customer.ownerId))
      throw new NotFoundException('找不到此拜訪排程');
    if (p.status !== 'planned') throw new BadRequestException('只有尚未完成的排程可以取消');
    // 條件式 updateMany:避免讀到 planned 之後、寫入之前剛好被打卡標成 done
    const r = await this.prisma.devVisitPlan.updateMany({
      where: { id, status: 'planned' },
      data: { status: 'cancelled' },
    });
    if (r.count === 0) throw new BadRequestException('只有尚未完成的排程可以取消');
    const row = await this.prisma.devVisitPlan.findUnique({ where: { id }, select: planSelect });
    if (!row) throw new NotFoundException('找不到此拜訪排程');
    return toRow(row);
  }
}
