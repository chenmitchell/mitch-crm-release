import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { loadEnv } from '../common/env';
import { errorFingerprint } from './error-fingerprint';
import { purgeInBatches } from './purge-in-batches';

/**
 * 錯誤記錄。
 *
 * 這張表原本只寫不刪也不合併,所以「能讓後端出錯的請求」等於「能無限灌大這張表」。
 * 審查抓到的那條路徑不需要任何憑證(深層巢狀 body → class-transformer 爆堆疊 → 500),
 * 一次請求一列,每列 message 1000 字加 stack 8000 字。深度檢查已經把那條路徑改成 400,
 * 但「同一種錯誤重複寫」這件事本身要有上限,不能靠「希望沒有下一個灌法」。
 *
 * 兩道:
 *   1. 同訊息合併:同一個指紋(見 error-fingerprint.ts)在合併窗內只留一列,
 *      重複的併進 seenCount 並更新 lastSeenAt。後台看到的是「這件事發生了 N 次」,
 *      比一千列一模一樣的內容有用。
 *   2. 保留期:超過保留天數的整列刪掉。清理搭在寫入路徑上,每隔一段時間跑一次,
 *      不另外開排程 —— 沒有錯誤就不需要清,有錯誤才會累積。清理本身分批而且不 await,
 *      理由見 purgeExpired 與 purge-in-batches.ts。
 *
 * 兩件事都失敗了也不能反過來把請求弄掛:整段包在 try / catch 裡,失敗只 console 一下。
 */
@Injectable()
export class ErrorsService {
  private readonly logger = new Logger(ErrorsService.name);

  /** 合併窗:同指紋在這段時間內只累加次數 */
  private readonly dedupeWindowMs: number;
  /** 保留期:超過就刪 */
  private readonly retentionMs: number;
  /** 保留天數,只用來寫 log */
  private readonly retentionDays: number;
  /** 清理的最短間隔。每一次寫入都掃一次過期資料太浪費,一小時一次就夠 */
  private readonly purgeIntervalMs = 3_600_000;
  private lastPurgeAt = 0;
  /** 正在跑的那一輪清理(沒有就是 null)。同時只跑一輪,而且不擋住寫入 */
  private purging: Promise<void> | null = null;

  // env 在建構時才讀,不在模組載入時讀:這一支被 GlobalExceptionFilter 匯入,
  // 模組層級的 loadEnv() 會讓任何 import 到 filter 的測試都得先備妥整組環境變數。
  constructor(private readonly prisma: PrismaService) {
    const env = loadEnv();
    this.dedupeWindowMs = env.ERROR_LOG_DEDUPE_WINDOW_MINUTES * 60_000;
    this.retentionMs = env.ERROR_LOG_RETENTION_DAYS * 86_400_000;
    this.retentionDays = env.ERROR_LOG_RETENTION_DAYS;
  }

  async record(opts: {
    level?: 'error' | 'warn';
    message: string;
    stack?: string;
    path?: string;
    method?: string;
    statusCode?: number;
    userId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const now = new Date();
      const fingerprint = errorFingerprint({
        level: opts.level,
        statusCode: opts.statusCode,
        method: opts.method,
        path: opts.path,
        message: opts.message,
      });

      // 合併窗內已經有同一件事的話,只累加次數,不新增列
      const existing = await this.prisma.errorLog.findFirst({
        where: {
          fingerprint,
          createdAt: { gte: new Date(now.getTime() - this.dedupeWindowMs) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      if (existing) {
        await this.prisma.errorLog.update({
          where: { id: existing.id },
          data: { seenCount: { increment: 1 }, lastSeenAt: now },
        });
      } else {
        await this.prisma.errorLog.create({
          data: {
            level: opts.level ?? 'error',
            message: opts.message.slice(0, 1000),
            stack: opts.stack ? opts.stack.slice(0, 8000) : null,
            path: opts.path ?? null,
            method: opts.method ?? null,
            statusCode: opts.statusCode ?? null,
            userId: opts.userId ?? null,
            ip: opts.ip ?? null,
            userAgent: opts.userAgent ? opts.userAgent.slice(0, 500) : null,
            metadata: opts.metadata ? (opts.metadata as object) : undefined,
            fingerprint,
            seenCount: 1,
            lastSeenAt: now,
          },
          // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
        });
      }

      // 清理**不 await**:它是順帶做的家事,而正在等這一支回來的是「現在正在出錯」
      // 的那個請求。await 的話,累積量大的那一次會讓那個請求一起等好幾秒。
      this.schedulePurge(now);
    } catch (e) {
      // 寫入 error_log 本身失敗時不要再炸,只 console 一下
      this.logger.error(`[ErrorsService] failed to record: ${(e as Error).message}`);
    }
  }

  /**
   * 排一輪清理。搭在寫入路徑上,但不 await、有最短間隔、同時只跑一輪。
   *
   * 三件事缺一不可:不 await 才不會讓正在出錯的那個請求等清理;最短間隔才不會
   * 每寫一列就掃一次;單一輪才不會在錯誤連發時同時開出幾十輪一起刪同一批列。
   */
  private schedulePurge(now: Date): void {
    if (this.purging) return;
    if (now.getTime() - this.lastPurgeAt < this.purgeIntervalMs) return;
    this.lastPurgeAt = now.getTime();
    this.purging = this.purgeExpired(now)
      .catch((e) => {
        this.logger.warn(`[ErrorsService] 清理過期錯誤記錄失敗:${(e as Error).message}`);
      })
      .finally(() => {
        this.purging = null;
      });
  }

  /**
   * 等目前這一輪清理跑完。只給測試與關機流程用,正常路徑不需要等它。
   */
  async flushPurge(): Promise<void> {
    await this.purging;
  }

  /**
   * 刪掉超過保留期的整列,分批。
   *
   * 為什麼要分批:原本這裡是一句 deleteMany,平常只刪幾列看不出問題,而它真的
   * 有事做的那一次恰好是最壞的那一次 —— 升級到有保留期的第一次、或長期停機後
   * 重新啟動,累積的全部列會在同一句裡刪掉,整張表的列鎖一次拿滿。
   * 而這一支掛在寫入路徑上,排在後面等的正是那一刻正在發生的那個錯誤。
   * 分批的細節與批數上限見 purge-in-batches.ts。
   */
  private async purgeExpired(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - this.retentionMs);
    const { deleted, hitLimit } = await purgeInBatches<bigint>({
      findIds: async (limit) => {
        const rows = await this.prisma.errorLog.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: limit,
        });
        return rows.map((r) => r.id);
      },
      // 刪除仍然帶著 created_at 的條件:id 是上一句讀到的,而兩句之間那一列
      // 不可能變年輕 —— 這一段是保險,確保任何情況下都不會刪到保留期內的列
      deleteByIds: async (ids) => {
        const { count } = await this.prisma.errorLog.deleteMany({
          where: { id: { in: ids }, createdAt: { lt: cutoff } },
        });
        return count;
      },
    });
    if (deleted > 0) {
      this.logger.log(
        `[ErrorsService] 清掉 ${deleted} 列超過保留期(${this.retentionDays} 天)的錯誤記錄` +
          (hitLimit ? ',還有沒清完的,下一輪繼續' : ''),
      );
    }
  }

  async list(limit = 100) {
    const items = await this.prisma.errorLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        level: true,
        message: true,
        path: true,
        method: true,
        statusCode: true,
        userId: true,
        ip: true,
        createdAt: true,
        stack: true,
        seenCount: true,
        lastSeenAt: true,
      },
    });
    // BigInt id 不能直接 JSON.stringify
    return {
      errors: items.map((e) => ({
        ...e,
        id: e.id.toString(),
      })),
    };
  }
}
