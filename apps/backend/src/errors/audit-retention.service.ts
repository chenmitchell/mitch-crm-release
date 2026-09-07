// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 稽核記錄(audit_logs)的保留期。
 *
 * 為什麼需要:這張表全 repo 有三處寫入(匯出、刪除、單一登入),**零處刪除**。
 * 錯誤記錄有 ERROR_LOG_RETENTION_DAYS 管著,稽核記錄什麼都沒有,只會一直長 ——
 * 六十人兩年估三十萬到一百萬列,而 metadata 是 JsonB(匯出那一支塞 count / offset /
 * days,刪除那一支塞公司名),實際大小會比列數估算大好幾倍。沒有上限的表最後
 * 不是「有點大」,是備份跑不完、vacuum 追不上、後台那一頁打不開。
 *
 * ── 為什麼這一支的設計要比錯誤記錄保守 ──────────────────────────
 * 稽核記錄不是日誌,是**安全性證據**。錯誤記錄刪早了只是少了除錯線索;稽核記錄
 * 刪早了是「要查的時候證據不見了」,而且不會有任何人在當下發現。所以:
 *
 *   1. 預設保留兩年,不是三十天。理由寫在 common/env.ts 的
 *      AUDIT_LOG_RETENTION_DAYS 那一段:追查通常在事情發生很久之後才開始。
 *   2. 保留天數有下限(90 天),手滑填 1 會在開機時被 env 驗證擋下來,
 *      不會安靜地把整條軌跡清成三天份。
 *   3. 填 0 = 永不刪除,給有法遵保留義務的部署一個明確的關閉開關。
 *   4. 刪除這件事本身也留痕:每一輪真的刪掉東西時,寫一列 action=audit.purge
 *      的稽核記錄,記下刪了幾列與截止時間。少了這一條,稽核軌跡上會出現
 *      一段沒有任何解釋的空白,而「空白是清理造成的」與「空白是有人動過手腳」
 *      在事後長得一模一樣。
 *   5. 分批刪,不一次 DELETE 拿整表行鎖(見 purge-in-batches.ts)。
 *   6. 一輪清不完就幾分鐘後再跑一輪,不要等到明天。分批有一輪五萬列的上限,
 *      配上一天一次的間隔,積欠幾十萬列的那一次(長期停機後重啟、或有人把保留
 *      天數改小)要十幾天才追得完,而那段期間表一直是超量的。
 *      見 AUDIT_PURGE_CATCHUP_DELAY_MS。
 *
 * ── 為什麼放在 errors 模組 ────────────────────────────────────
 * 這個模組管的就是「系統自己產生、只增不減的紀錄」。錯誤記錄的保留期已經在這裡,
 * 分批清除那一支也在這裡,稽核記錄的保留期跟它們是同一件事的第三份,
 * 另外開一個只有一支服務的模組只會讓下一個人找不到。
 *
 * ── 為什麼是計時器,不是搭在寫入路徑上 ─────────────────────────
 * 錯誤記錄可以搭寫入路徑,因為「有錯誤才會累積」。稽核記錄不一樣:它的三個寫入點
 * 分散在三個模組裡,而且一個平靜的月份可能一列都不寫,卻仍然有兩年前的列要清。
 * 所以這一支自己排一個低頻計時器(unref,不會拖住關機)。
 */
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { loadEnv } from '../common/env';
import { purgeInBatches } from './purge-in-batches';

/** 清理的間隔。稽核記錄是以「天」為單位的保留期,一天跑一次綽綽有餘 */
export const AUDIT_PURGE_INTERVAL_MS = 24 * 3_600_000;
/**
 * 服務起來之後隔多久跑第一輪。
 * 不在啟動當下就跑:開機那幾秒要留給遷移、seed 與第一批請求。
 */
export const AUDIT_PURGE_FIRST_DELAY_MS = 5 * 60_000;
/**
 * 積欠沒清完時,隔多久排下一輪。
 *
 * 為什麼需要這個:purgeInBatches 一輪的上限是 PURGE_MAX_BATCHES × PURGE_BATCH_SIZE
 * (五萬列),而正常間隔是一天。兩個湊在一起,積欠量大的那一次會以每天五萬列的
 * 速度慢慢消 —— 長期停機後重啟、或有人把保留天數從 730 改成 90 的那一次,
 * 積欠動輒幾十萬列,要用十幾天才追得完,而那段期間表一直是超量的。
 * hitLimit=true 就代表「這一輪撞到上限、還有沒刪完的」,那就不要等到明天,
 * 幾分鐘後再跑一輪。
 *
 * 為什麼是五分鐘而不是立刻接著跑:清理是搭在別人旁邊跑的家事,一輪 2.5 秒的
 * 刪除要讓得出位置給正常寫入。五分鐘一輪等於每天六十萬列的上限,
 * 積欠再大也是幾小時的事,而不是十幾天。
 */
export const AUDIT_PURGE_CATCHUP_DELAY_MS = 5 * 60_000;
/** 記在稽核軌跡上的動作代碼(刪除機制自己也要留痕) */
export const AUDIT_PURGE_ACTION = 'audit.purge';

@Injectable()
export class AuditRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetentionService.name);
  /** 保留天數;0 = 永不刪除 */
  private readonly retentionDays: number;
  private timer: NodeJS.Timeout | null = null;
  /** 第一輪的延後計時器。跟 interval 一樣要在關機時清掉,不然關機之後還會醒來打一次資料庫 */
  private firstTimer: NodeJS.Timeout | null = null;
  /** 積欠沒清完時的追加輪次計時器。同樣要在關機時清掉 */
  private catchUpTimer: NodeJS.Timeout | null = null;
  private running = false;

  // env 在建構時才讀,不在模組載入時讀(理由同 ErrorsService)
  constructor(private readonly prisma: PrismaService) {
    this.retentionDays = loadEnv().AUDIT_LOG_RETENTION_DAYS;
  }

  /** 保留期是否啟用。0 = 關閉,一列都不刪 */
  get enabled(): boolean {
    return this.retentionDays > 0;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('[audit] AUDIT_LOG_RETENTION_DAYS=0,稽核記錄不設保留期,一列都不會刪');
      return;
    }
    this.logger.log(`[audit] 稽核記錄保留 ${this.retentionDays} 天,每天清理一次`);
    // 第一輪延後跑,之後每天一次。unref 讓這個計時器不會擋住行程結束
    this.timer = setInterval(() => void this.runOnce(), AUDIT_PURGE_INTERVAL_MS);
    this.timer.unref?.();
    this.firstTimer = setTimeout(() => void this.runOnce(), AUDIT_PURGE_FIRST_DELAY_MS);
    this.firstTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 開機後五分鐘內就關掉的話(重啟、健康檢查失敗被換掉),第一輪那個計時器
    // 還排在那裡;不清掉它會在模組已經拆掉之後醒來,對著斷線的 Prisma 送查詢
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.firstTimer = null;
    // 追加輪次同理:撞到上限之後排的那一個可能還在等,關機之後醒來一樣是對著斷線的
    // Prisma 送查詢
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
  }

  /**
   * 跑一輪清理。任何失敗只記一行 warn:清不掉稽核記錄不是事故,
   * 而讓它把整個行程弄掛才是。同時只跑一輪。
   */
  async runOnce(now: Date = new Date()): Promise<{ deleted: number; hitLimit: boolean }> {
    if (!this.enabled || this.running) return { deleted: 0, hitLimit: false };
    this.running = true;
    let result: { deleted: number; hitLimit: boolean };
    try {
      result = await this.purgeExpired(now);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`[audit] 稽核記錄清理未完成(${name}),下一輪再試`);
      result = { deleted: 0, hitLimit: false };
    } finally {
      this.running = false;
    }
    if (result.hitLimit) this.scheduleCatchUp();
    return result;
  }

  /**
   * 排一個追加輪次。同時只排一個:已經有一個在等就不重排,
   * 不然連續幾輪都撞上限會疊出一堆計時器,變成同一時間好幾輪一起醒來。
   * unref 的理由與另外兩個計時器相同,不擋行程結束。
   */
  private scheduleCatchUp(): void {
    if (!this.enabled || this.catchUpTimer) return;
    this.logger.log(
      `[audit] 這一輪撞到批數上限,還有沒清完的,${Math.round(AUDIT_PURGE_CATCHUP_DELAY_MS / 60_000)} 分鐘後再跑一輪`,
    );
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      void this.runOnce();
    }, AUDIT_PURGE_CATCHUP_DELAY_MS);
    this.catchUpTimer.unref?.();
  }

  private async purgeExpired(now: Date): Promise<{ deleted: number; hitLimit: boolean }> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    // 已經真的刪掉幾列。分批刪到一半失敗時,這個數字是唯一還知道「刪了多少」的地方:
    // purgeInBatches 的回傳值在那條路徑上根本不會產生(例外直接往外拋)
    let deletedSoFar = 0;
    let deleted: number;
    let hitLimit: boolean;
    try {
      ({ deleted, hitLimit } = await purgeInBatches<bigint>({
        findIds: async (limit) => {
          const rows = await this.prisma.auditLog.findMany({
            where: { createdAt: { lt: cutoff } },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: limit,
          });
          return rows.map((r) => r.id);
        },
        // created_at 的條件在刪除這一句也再寫一次:id 是上一句讀到的,
        // 這一段是保險,確保任何情況下都不會刪到保留期內的列
        deleteByIds: async (ids) => {
          const { count } = await this.prisma.auditLog.deleteMany({
            where: { id: { in: ids }, createdAt: { lt: cutoff } },
          });
          deletedSoFar += count;
          return count;
        },
      }));
    } catch (err) {
      // 中途失敗(資料庫斷線、逾時)時,前面幾批是真的刪掉了,已經倒不回去。
      // 這一段一定要留痕:少了它,軌跡上那幾千列的空白跟「有人動過手腳」長得一模一樣,
      // 而這正是整支保留期唯一必須守住的東西(見檔頭第 4 點)。
      if (deletedSoFar > 0) {
        this.logger.log(`[audit] 清理中途失敗,已刪掉 ${deletedSoFar} 列,先把這一段記進稽核軌跡`);
        await this.recordPurge(deletedSoFar, cutoff);
      }
      throw err;
    }
    if (deleted > 0) {
      this.logger.log(
        `[audit] 清掉 ${deleted} 列超過保留期(${this.retentionDays} 天)的稽核記錄` +
          (hitLimit ? ',還有沒清完的,下一輪繼續' : ''),
      );
      await this.recordPurge(deleted, cutoff);
    }
    return { deleted, hitLimit };
  }

  /**
   * 把「清理本身」寫進稽核軌跡。
   *
   * 沒有這一列的話,兩年前那一段軌跡憑空消失,而事後看不出那是保留期造成的
   * 還是有人動過手腳。userId 留空:這不是任何人操作的,是系統自己做的家事。
   * 寫失敗只記 log —— 該刪的已經刪掉了,不能倒回去。
   */
  private async recordPurge(deleted: number, cutoff: Date): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: null,
          action: AUDIT_PURGE_ACTION,
          metadata: {
            deleted,
            cutoff: cutoff.toISOString(),
            retentionDays: this.retentionDays,
          },
        },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`[audit] 清理紀錄寫不進稽核軌跡(${name}),已刪除 ${deleted} 列`);
    }
  }
}
