// ref:3687 mc/陳彥輔/米球®
/**
 * 客戶階段目錄:所有「階段語意」的單一查詢點。
 *
 * 為什麼要有這一支:階段清單是後台可以增減的資料(dev_stages),
 * 但程式裡到處都需要問「哪些算進行中」「哪些是終止」「這個中文標籤是哪一個代碼」。
 * 每個地方各自寫一份陣列的結果,就是管理員新增一個階段之後:
 *   漏斗少一欄、地圖把終止客戶當進行中畫上去、匯入查不到標籤還安靜降階。
 * 語意一律從 dev_stages 的 is_terminal 與 sort_order 推導,不從代碼字面推導。
 *
 * 唯一的例外是 WON_STAGE_KEY / LOST_STAGE_KEY 這兩個產品保留字,
 * 理由與範圍寫在 @mitchcrm/shared 的 dev-vocab.ts,全系統只有那一處寫死代碼。
 *
 * 快取只做「一個請求之內」的短時記憶(CACHE_TTL_MS):每個公開方法都各查一次表,
 * 一支 API 的一次 Promise.all 就會打三次一模一樣的 findMany。
 * 時間刻意壓得很短,因為「後台改了設定但前台要等快取過期才生效」正是這套系統
 * 最不該出現的症狀 —— 一秒之內的重複查詢合併掉,跨請求的行為維持原樣。
 */
import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_DEV_STAGES, LOST_STAGE_KEY, WON_STAGE_KEY } from '@mitchcrm/shared';
import { PrismaService } from '../prisma/prisma.service';

export { LOST_STAGE_KEY, WON_STAGE_KEY };

export interface StageCatalogEntry {
  key: string;
  label: string;
  sortOrder: number;
  isTerminal: boolean;
}

/**
 * 打卡到訪時要推進到第幾個進行中階段(0 起算)。
 *
 * 「到訪」在出廠設定裡是第三個進行中階段(名單 → 已接觸 → 已拜訪),
 * 所以用位置而不是代碼:後台把階段改名、插一階、或整套換掉,
 * 這個判斷都還在同一個位置上,不會因為找不到 `visited` 就整個失效。
 * 進行中階段不足三個時退到最後一個。
 */
const ARRIVAL_STAGE_INDEX = 2;

/** 出廠階段目錄:讀不到資料表時的保底值,也是單元測試直接 new 服務時的行為基準 */
export const DEFAULT_STAGE_CATALOG: StageCatalogEntry[] = DEFAULT_DEV_STAGES.map((s) => ({
  key: s.key,
  label: s.label,
  sortOrder: s.sortOrder,
  isTerminal: s.isTerminal,
}));

/**
 * 打卡到訪的階段推進(純函式,方便測試與在沒有目錄服務時共用同一套規則)。
 * target 是到訪階段,from 是「還停在它前面、應該被推上去」的那些;
 * 進行中階段少於兩個時回 null(沒有可推進的空間)。
 */
export function arrivalAdvanceOf(
  stages: readonly StageCatalogEntry[],
): { target: string; from: string[] } | null {
  const inProgress = stages.filter((s) => !s.isTerminal).map((s) => s.key);
  if (inProgress.length < 2) return null;
  const targetIndex = Math.min(ARRIVAL_STAGE_INDEX, inProgress.length - 1);
  const target = inProgress[targetIndex]!;
  const from = inProgress.slice(0, targetIndex);
  return from.length ? { target, from } : null;
}

/**
 * 目錄的短時快取存活時間。設成一秒是刻意的:目的只是把同一個請求裡的重複查詢
 * 合併掉,不是要省下跨請求的查詢。拉長到幾十秒就會變成「改了設定要等一下才生效」。
 */
export const STAGE_CATALOG_CACHE_TTL_MS = 1000;

@Injectable()
export class StageCatalogService {
  private readonly logger = new Logger(StageCatalogService.name);
  private cached: StageCatalogEntry[] | null = null;
  private cachedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** 後台存檔後可以呼叫,讓下一次讀取一定去查資料表 */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * 啟用中的階段,依後台排序。
   *
   * 讀不到資料表(遷移還沒跑完、資料庫暫時不通)或表是空的就退回出廠預設:
   * 讓整個 CRM 因為讀不到階段清單而停擺,比用一份保底清單先撐著更糟。
   */
  async all(): Promise<StageCatalogEntry[]> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < STAGE_CATALOG_CACHE_TTL_MS) return this.cached;
    let entries: StageCatalogEntry[] = [...DEFAULT_STAGE_CATALOG];
    try {
      const rows = await this.prisma.devStage.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true, isTerminal: true },
      });
      if (rows.length > 0) entries = rows as StageCatalogEntry[];
    } catch (e) {
      this.logger.warn(
        `[stage-catalog] 讀不到階段主檔,改用出廠預設(${e instanceof Error ? e.name : 'UnknownError'})`,
      );
      // 讀失敗的那一份不放進快取:下一次呼叫要再試一次資料庫,不然一秒內的重試也拿不到真值
      return entries;
    }
    this.cached = entries;
    this.cachedAt = now;
    return entries;
  }

  /** 全部階段代碼,依流程順序 */
  async keys(): Promise<string[]> {
    return (await this.all()).map((s) => s.key);
  }

  /** 終止階段代碼(is_terminal=true)。成交、放棄,以及後台自己加的終止階段 */
  async terminalKeys(): Promise<string[]> {
    return (await this.all()).filter((s) => s.isTerminal).map((s) => s.key);
  }

  /** 進行中的階段代碼(沒有標終止的那些),依流程順序 */
  async inProgressKeys(): Promise<string[]> {
    return (await this.all()).filter((s) => !s.isTerminal).map((s) => s.key);
  }

  /** 流程第一個階段的代碼:新客戶與「填錯就退到這裡」的落點 */
  async firstStageKey(): Promise<string> {
    const keys = await this.keys();
    return keys[0] ?? DEFAULT_STAGE_CATALOG[0]!.key;
  }

  /**
   * 進行中階段裡排最後的那一個,也就是「離終點最近、最值得算 KPI」的一階。
   * 出廠設定下就是「有意願」;後台把流程改長改短,這個判斷跟著走。
   */
  async nearestToWonKey(): Promise<string | null> {
    const inProgress = await this.inProgressKeys();
    return inProgress.length ? inProgress[inProgress.length - 1]! : null;
  }

  /**
   * 打卡到訪後的階段推進:target 是到訪階段,from 是「還停在它前面、應該被推上去」的那些。
   * 進行中階段少於兩個時回 null(沒有可推進的空間)。
   */
  async arrivalAdvance(): Promise<{ target: string; from: string[] } | null> {
    return arrivalAdvanceOf(await this.all());
  }

  /**
   * 流程前進的名次(合併查重時比較誰比較前面)。
   * 名次就是後台排的順序,終止階段不參與比較(成交由保留字另外處理)。
   */
  async rankByKey(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    (await this.all()).forEach((s, i) => {
      if (!s.isTerminal) out.set(s.key, i);
    });
    return out;
  }

  /**
   * 中文標籤 → 階段代碼。匯入的「進度」欄填的是標籤,不是代碼。
   * 對照表由資料表現況產生,所以後台把「報價中」改名「議價中」之後,
   * 匯入立刻認得新名字,而舊名字會被當成查無此階段回報出來(不是安靜降階)。
   * 同名標籤以排序在前的那一個為準。
   */
  async keyByLabel(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const s of await this.all()) {
      const label = s.label.trim();
      if (label && !out.has(label)) out.set(label, s.key);
    }
    return out;
  }

  /** 某一階段的顯示標籤;查不到就回代碼本身 */
  async labelOf(key: string): Promise<string> {
    return (await this.all()).find((s) => s.key === key)?.label ?? key;
  }
}
