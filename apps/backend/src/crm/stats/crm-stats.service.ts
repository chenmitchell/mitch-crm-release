/**
 * 主管戰情圖表 / 貢獻度分級服務(限訪查主管與 admin,由 controller 把關)。
 *
 * - bySales(range):每位業務的開發中 / 有意願 / 成交 / 拜訪 / 互動 / 逾期 / 新客戶,
 *   算貢獻分數並分 A/B/C 級。全部用 groupBy 一次撈完,沒有 N+1。
 * - funnel():各階段目前筆數。欄位與順序來自 dev_stages(後台排的順序),沒資料補 0。
 *
 * 期間起點以**組織設定的時區**計算(orgPeriodStart,同 crm.service.ts 的 report()):
 *   week = 本週一 00:00、month = 本月 1 日 00:00、quarter = 本季第一天 00:00,終點都是現在。
 *   「週一是一週的開始」這一條目前是寫死的,設在週日或週六起算的地區會差一天。
 *
 * 「成交」的計法:期間內 stage 變成 converted 的精準時間點 DB 沒有存,
 * 所以以期間內備註以「【已成交】」開頭的互動紀錄(markConverted 寫的)計數,歸給客戶目前的負責業務;
 * 另附 convertedTotal(目前 stage=converted 的總數)供對照,回應的 note 欄位有說明。
 * 「【」開頭的 note 只有系統會寫:crm.service 的備註驗證(SYSTEM_NOTE_PREFIX)擋掉使用者以【開頭的備註,
 * 所以這個前綴可以當系統紀錄的可靠識別。
 *
 * 排除規則(純函式在下面,見 crm-stats.service.spec.ts):
 * - interactions / visits 不算「【」開頭的系統紀錄(補拍、刪照片、移交、成交等都是系統寫的,不是業務的動作)
 * - visits 另排除 gpsSuspicious=true 的打卡(假定位 / 地址剛變更等),這些另計在 suspiciousVisits 供主管看;
 *   interactions 仍含可疑打卡(互動確實發生了,只是位置存疑)
 * - 每一個客戶數(inDev / interested / convertedTotal / overdue / newCustomers)都不算
 *   已被查重合併掉的客戶(mergedIntoId 不為 null),口徑同清單、看板與漏斗
 * - 停用(離職)帳號**照樣進榜**,名下的客戶照樣算,該列標 active: false。
 *   理由見 crm-scope-filters.ts 的 crmSalesUserWhere:少算一個人會讓同一頁的
 *   各訪查人員狀態表、漏斗、貢獻度分級三個數字互相對不上,而客戶並沒有因此消失
 *
 * 階段語意全部問 StageCatalogService(讀 dev_stages):進行中 / 終止由 is_terminal 決定,
 * 「有意願」是進行中階段裡排最後的那一階。這裡不寫死階段代碼清單 ——
 * 後台新增一個階段,寫死的清單不會跟著長,那些客戶就一筆都不算。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Injectable, Optional } from '@nestjs/common';
import { CONVERTED_NOTE_PREFIX as SHARED_CONVERTED_NOTE_PREFIX } from '../crm-messages';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgTimeService } from '../../settings/org-time.service';
import { StageCatalogService, WON_STAGE_KEY } from '../../app-settings/stage-catalog.service';
import { authorFilter, ownerFilter, type ViewScope } from '../../scope/view-scope';
import {
  countableCustomerWhere,
  convertedInteractionWhere,
  crmSalesUserWhere,
  humanInteractionWhere,
  liveCustomerFilter,
  newCustomerWhere,
  overdueCustomerWhere,
  relatedLiveCustomerFilter,
  suspiciousVisitWhere,
} from '../crm-scope-filters';
import { VISIT_CHANNEL_KEY, orgPeriodStart } from '@mitchcrm/shared';

export const STAT_RANGES = ['week', 'month', 'quarter'] as const;
export type StatRange = (typeof STAT_RANGES)[number];

/**
 * 這幾個 where 片段搬到 ../crm-scope-filters:本週工作報告(CrmService.report)
 * 與這支戰情圖表必須用同一份排除規則,各留一份的結果是同一週兩個數字。
 * 這裡 re-export,既有的 import 路徑與測試不用全改。
 */
export {
  SYSTEM_NOTE_PREFIX,
  countableCustomerWhere,
  crmSalesUserWhere,
  convertedInteractionWhere,
  humanInteractionWhere,
  isSystemNote,
  liveCustomerFilter,
  newCustomerWhere,
  notDeletedWhere,
  overdueCustomerWhere,
  relatedLiveCustomerFilter,
  suspiciousVisitWhere,
} from '../crm-scope-filters';

export interface SalesStatRow {
  userId: string;
  userName: string;
  /**
   * 這個帳號目前還啟用嗎。停用(離職)的帳號一樣列出來,名下的客戶一樣算 ——
   * 口徑見 crm-scope-filters.ts 的 crmSalesUserWhere;畫面負責標示「已停用」。
   */
  active: boolean;
  inDev: number;
  interested: number;
  converted: number;
  convertedTotal: number;
  /** 期間內的拜訪打卡,不含 gpsSuspicious=true 的 */
  visits: number;
  /** 期間內被標可疑的拜訪打卡(不計分,只給主管看) */
  suspiciousVisits: number;
  interactions: number;
  overdue: number;
  newCustomers: number;
  score: number;
  grade: 'A' | 'B' | 'C';
}

export type SalesStatTotals = Omit<SalesStatRow, 'userId' | 'userName' | 'active' | 'grade'>;

export interface BySalesResult {
  range: StatRange;
  from: string;
  to: string;
  note: string;
  rows: SalesStatRow[];
  totals: SalesStatTotals;
}

/** 分數公式:成交 ×10 + 有意願 ×3 + 拜訪 ×1 + 新客戶 ×0.5 */
export function contributionScore(r: {
  converted: number;
  interested: number;
  visits: number;
  newCustomers: number;
}): number {
  return (
    Math.round((r.converted * 10 + r.interested * 3 + r.visits * 1 + r.newCustomers * 0.5) * 10) /
    10
  );
}

/**
 * 依分數排序分級:前 25% A、前 60% B、其餘 C;人數 < 3 全部 B。
 *
 * 同分者一定拿同一等級,而且用**該分數最後面**的名次決定,不是最前面的。
 * 用最前面的名次會有一個很難發現的後果:所有人同分時,每一個人的名次都算 0,
 * 於是全部落在前 25% —— 全新安裝、五位訪查人員都還沒有任何動作,
 * 畫面上就是五個 A 級;[10,10,10,0] 也會變成 A、A、A、C,一個 B 都沒有,
 * 與 API 自己的說明完全對不上。用末位名次的話,同分的一群人要整群都落在
 * 前 25% 之內才拿 A,分不出高下時就往下靠,不會憑空發獎。
 *
 * 全部同分時直接全給 B:那個情況沒有任何排名資訊可言,給誰 A 都是假的。
 *
 * 輸入須已依 score 由高到低排好。
 */
export function assignGrades(sortedScores: number[]): Array<'A' | 'B' | 'C'> {
  const n = sortedScores.length;
  if (n < 3) return sortedScores.map(() => 'B');
  // 全部同分:沒有高下可分,一律 B
  if (sortedScores.every((s) => s === sortedScores[0])) return sortedScores.map(() => 'B');
  const aCut = Math.ceil(n * 0.25);
  const bCut = Math.ceil(n * 0.6);
  const lastIndexOfScore = new Map<number, number>();
  sortedScores.forEach((s, i) => lastIndexOfScore.set(s, i));
  return sortedScores.map((s) => {
    const i = lastIndexOfScore.get(s) ?? n - 1;
    if (i < aCut) return 'A';
    if (i < bCut) return 'B';
    return 'C';
  });
}

/**
 * 期間起點(UTC 時間點),以組織設定時區的週一 / 月初 / 季初 00:00 為準。
 * 實際算法在 @mitchcrm/shared 的 orgPeriodStart(用 Intl 查時區資料庫,夏令時間也對)。
 */
export function rangeStart(range: StatRange, now: Date, tz?: string | null): Date {
  return orgPeriodStart(range, now, tz);
}

@Injectable()
export class CrmStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stageCatalog: StageCatalogService,
    /** 期間起點要用組織設定的時區;沒注入(單元測試直接 new)就退回出廠時區 */
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /** 組織時區的期間起點 */
  private async periodStart(range: StatRange, now: Date): Promise<Date> {
    return this.orgTime ? this.orgTime.periodStart(range, now) : rangeStart(range, now);
  }

  normalizeRange(v: unknown): StatRange {
    return (STAT_RANGES as readonly string[]).includes(v as string) ? (v as StatRange) : 'week';
  }

  async bySales(range: StatRange, view: ViewScope): Promise<BySalesResult> {
    const now = new Date();
    const from = await this.periodStart(range, now);

    // 階段語意一律問 dev_stages:哪些算進行中、哪些是終止,由後台的 is_terminal 決定。
    // 寫死代碼清單的話,管理員新增一個階段之後,那些客戶不算在任何一個數字裡,
    // 總數跟看板對不上,而畫面上看不出少了誰。
    const [inProgressKeys, terminalKeys, nearestToWonKey] = await Promise.all([
      this.stageCatalog.inProgressKeys(),
      this.stageCatalog.terminalKeys(),
      this.stageCatalog.nearestToWonKey(),
    ]);
    const inDevStages = new Set(inProgressKeys);

    // 五個彙總查詢 + 一個使用者清單,一次 Promise.all 併發;都不是逐人查。
    const [users, byStage, overdueRows, newRows, interRows, suspiciousRows, convertedRows] =
      await Promise.all([
        this.prisma.user.findMany({
          where: crmSalesUserWhere(view),
          select: { id: true, name: true, status: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.devCustomer.groupBy({
          by: ['ownerId', 'stage'],
          // 合併掉的那一筆不算(口徑同清單、看板與漏斗,見 countableCustomerWhere)
          where: { ...countableCustomerWhere(), ...ownerFilter(view) },
          _count: { _all: true },
        }),
        this.prisma.devCustomer.groupBy({
          by: ['ownerId'],
          // 逾期只算還在跑的客戶:終止階段(成交、放棄,以及後台自己加的)不算逾期。
          // 片段來自 ../crm-scope-filters,與本週工作報告共用同一份
          where: { ...overdueCustomerWhere(now, terminalKeys), ...ownerFilter(view) },
          _count: { _all: true },
        }),
        // 新客戶:排除查重合併掉的那些(mergedIntoId 不為 null)
        this.prisma.devCustomer.groupBy({
          by: ['ownerId'],
          where: { ...newCustomerWhere(from), ...ownerFilter(view) },
          _count: { _all: true },
        }),
        // 互動 / 拜訪:排除「【」開頭的系統紀錄(補拍、刪照片、移交、成交)
        this.prisma.devInteraction.groupBy({
          by: ['userId', 'channel'],
          where: {
            occurredAt: { gte: from },
            ...humanInteractionWhere(),
            // 客戶被刪掉之後,他身上的互動也不該再算進任何人的績效
            ...liveCustomerFilter(),
            ...authorFilter(view),
          },
          _count: { _all: true },
        }),
        // 可疑打卡:visits 要扣掉、另回 suspiciousVisits
        this.prisma.devInteraction.groupBy({
          by: ['userId'],
          where: { ...suspiciousVisitWhere(from), ...liveCustomerFilter(), ...authorFilter(view) },
          _count: { _all: true },
        }),
        // 期間內的【已成交】紀錄:歸給客戶「目前」的負責業務(不是按下成交的人),筆數少,一次撈完即可。
        // 這個前綴只有系統(markConverted)會寫,使用者備註不能以【開頭。
        this.prisma.devInteraction.findMany({
          where: { ...convertedInteractionWhere(from), ...relatedLiveCustomerFilter(view) },
          select: { customer: { select: { ownerId: true } } },
        }),
      ]);

    type Acc = Omit<SalesStatRow, 'score' | 'grade'>;
    const acc = new Map<string, Acc>();
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const statusOf = new Map(users.map((u) => [u.id, u.status]));
    const get = (userId: string): Acc => {
      let a = acc.get(userId);
      if (!a) {
        a = {
          userId,
          userName: nameOf.get(userId) ?? '(未知)',
          active: statusOf.get(userId) !== 'disabled',
          inDev: 0,
          interested: 0,
          converted: 0,
          convertedTotal: 0,
          visits: 0,
          suspiciousVisits: 0,
          interactions: 0,
          overdue: 0,
          newCustomers: 0,
        };
        acc.set(userId, a);
      }
      return a;
    };

    for (const r of byStage) {
      const a = get(r.ownerId);
      const n = r._count._all;
      if (inDevStages.has(r.stage)) a.inDev += n;
      // 「有意願」= 進行中階段裡排最後的那一階(離終點最近的一階),不是寫死的代碼
      if (nearestToWonKey !== null && r.stage === nearestToWonKey) a.interested += n;
      if (r.stage === WON_STAGE_KEY) a.convertedTotal += n;
    }
    for (const r of overdueRows) get(r.ownerId).overdue += r._count._all;
    for (const r of newRows) get(r.ownerId).newCustomers += r._count._all;
    for (const r of interRows) {
      const a = get(r.userId);
      a.interactions += r._count._all;
      if (r.channel === VISIT_CHANNEL_KEY) a.visits += r._count._all;
    }
    for (const r of suspiciousRows) {
      const a = get(r.userId);
      a.suspiciousVisits += r._count._all;
      a.visits = Math.max(0, a.visits - r._count._all);
    }
    for (const r of convertedRows) get(r.customer.ownerId).converted += 1;

    /*
     * 有資料的負責人一律進榜,停用帳號也一樣(active 旗標標在該列上)。
     *
     * 原本這裡是 filter(salesIds.has(...)),把停用帳號與非業務角色留下的資料整列丟掉,
     * 於是同一頁上「各訪查人員狀態表合計 4、漏斗 4、貢獻度分級 1」。三個數字要相等,
     * 這一張表就不能自己少算一個人;要表達「這個人已經離職」用旗標,不是用消失。
     * 口徑的理由寫在 crm-scope-filters.ts 的 crmSalesUserWhere。
     *
     * users 清單只用來補名字與狀態;有客戶卻不在清單裡的(例如管理員自己建的客戶)
     * 補查一次名字,查不到才顯示「(未知)」—— 但數字一定算進去。
     */
    const missingIds = [...acc.keys()].filter((id) => !nameOf.has(id));
    if (missingIds.length > 0) {
      const extra = await this.prisma.user.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, name: true, status: true },
      });
      for (const u of extra as Array<{ id: string; name: string; status: string }>) {
        const a = acc.get(u.id);
        if (!a) continue;
        a.userName = u.name;
        a.active = u.status !== 'disabled';
      }
    }
    const rowsUnsorted = [...acc.values()];

    const scored = rowsUnsorted
      .map((a) => ({ ...a, score: contributionScore(a) }))
      .sort(
        (x, y) =>
          y.score - x.score ||
          y.converted - x.converted ||
          x.userName.localeCompare(y.userName, 'zh-Hant'),
      );
    const grades = assignGrades(scored.map((r) => r.score));
    const rows: SalesStatRow[] = scored.map((r, i) => ({ ...r, grade: grades[i] ?? 'B' }));

    const totals: SalesStatTotals = {
      inDev: 0,
      interested: 0,
      converted: 0,
      convertedTotal: 0,
      visits: 0,
      suspiciousVisits: 0,
      interactions: 0,
      overdue: 0,
      newCustomers: 0,
      score: 0,
    };
    for (const r of rows) {
      totals.inDev += r.inDev;
      totals.interested += r.interested;
      totals.converted += r.converted;
      totals.convertedTotal += r.convertedTotal;
      totals.visits += r.visits;
      totals.suspiciousVisits += r.suspiciousVisits;
      totals.interactions += r.interactions;
      totals.overdue += r.overdue;
      totals.newCustomers += r.newCustomers;
      totals.score += r.score;
    }
    totals.score = Math.round(totals.score * 10) / 10;

    return {
      range,
      from: from.toISOString(),
      to: now.toISOString(),
      note:
        'converted 為期間內「【已成交】」互動紀錄筆數(此前綴只有系統會寫,歸給客戶目前負責業務);convertedTotal 為目前 stage=converted 總數。' +
        'interactions / visits 不含「【」開頭的系統紀錄;visits 另不含 gpsSuspicious=true 的可疑打卡(另計在 suspiciousVisits);客戶數一律不含已被合併掉的客戶。' +
        '停用(離職)帳號一樣列出、名下客戶一樣算,該列 active=false —— 與客戶清單、看板、漏斗同一個口徑。' +
        '分數 = 成交×10 + 有意願×3 + 拜訪×1 + 新客戶×0.5;前 25% A、前 60% B、其餘 C(同分者以該分數末位名次判定,整群都拿同一級);人數少於 3、或所有人同分時全部 B。',
      rows,
      totals,
    };
  }

  /**
   * 各階段目前筆數。同樣吃 ViewScope,不然主管的漏斗會把全公司的量算進來。
   *
   * 欄位順序來自 dev_stages(後台排的順序),不是寫死的七個代碼:
   * 寫死的話,管理員新增的階段整欄不見,而那些客戶一筆都不算,漏斗的總數
   * 跟看板對不上,使用者只會覺得「數字是錯的」,查不出原因。
   *
   * 最後再補上「資料裡有、目錄裡沒有」的階段(例如後台把某一階段停用、
   * 但還有客戶停在上面):寧可多一欄也不要讓總數對不上。
   *
   * 停用帳號名下的客戶一樣算(口徑見 crm-scope-filters.ts 的 crmSalesUserWhere),
   * 這樣漏斗的合計才會等於各訪查人員狀態表與貢獻度分級的合計。
   */
  async funnel(view: ViewScope): Promise<{ stages: Array<{ stage: string; count: number }> }> {
    const [grouped, catalogKeys] = await Promise.all([
      this.prisma.devCustomer.groupBy({
        by: ['stage'],
        // 被合併掉的那一筆不算:它的 stage 是 dropped,不排掉的話合併三筆之後
        // 漏斗的「無效/放棄」就多三筆、每一階的百分比跟著偏,而看板同一欄是 0。
        // 清單(list)一直都排除它,這裡跟上同一份 countableCustomerWhere。
        where: { ...countableCustomerWhere(), ...ownerFilter(view) },
        _count: { _all: true },
      }),
      this.stageCatalog.keys(),
    ]);
    const countOf = new Map<string, number>(grouped.map((g) => [g.stage, g._count._all]));
    const extra = [...countOf.keys()].filter((k) => !catalogKeys.includes(k)).sort();
    return {
      stages: [...catalogKeys, ...extra].map((stage) => ({
        stage,
        count: countOf.get(stage) ?? 0,
      })),
    };
  }
}
