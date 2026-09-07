// ref:3687 mc/陳彥輔/米球®
/**
 * system_settings 單列的寫入鎖(PostgreSQL advisory lock)。
 *
 * 為什麼需要:system_settings 的每一列存的是一整包 JSON,所以「改一個欄位」在
 * 實作上一律是 read-modify-write —— 讀出整包、在記憶體 merge、再整包寫回。
 * 兩個請求同時做這件事的話,後寫的那個是拿**舊快照**覆蓋,前一個的變更整筆消失,
 * 而且不會有任何錯誤:資料庫收到的是一筆合法的 UPDATE。
 *
 * 為什麼不用 crm/lock.ts 那種列鎖(SELECT ... FOR UPDATE):
 *   那一支鎖的是「一定已經存在」的客戶列。system_settings 這幾列是 upsert 出來的,
 *   第一次寫入時列還不存在,SELECT ... FOR UPDATE 鎖不到任何東西,兩個請求會
 *   同時走到 create 那一邊。advisory lock 鎖的是一個數字,與列存不存在無關,
 *   所以連「第一次寫入」也擋得住。
 *
 * 用法與列鎖相同:只能在 prisma.$transaction(async (tx) => ...) 的 tx 上呼叫。
 * pg_advisory_xact_lock 綁交易,交易結束(commit 或 rollback)自動釋放,
 * 不會像 pg_advisory_lock 那樣在連線池裡留下沒人放掉的鎖。
 * 在交易外呼叫等於沒有鎖(單一語句的隱含交易結束就放掉),所以呼叫端一律要開交易。
 */
import type { PrismaService } from '../prisma/prisma.service';

/**
 * advisory lock 的命名空間。
 *
 * pg_advisory_xact_lock 的雙參數版本吃兩個 int4:第一個當命名空間、第二個當鍵。
 * 整個資料庫的 advisory lock 共用一個空間,所以命名空間要挑一個不太可能撞到的值,
 * 日後別的模組要用 advisory lock 時另外挑一個,不要沿用這一個。
 */
export const SETTINGS_ADVISORY_NAMESPACE = 0x5343_5447; // 'SCTG'

/** 能發原生查詢的客戶端(PrismaService 與 Prisma.TransactionClient 都符合) */
export type SettingsLockClient = Pick<PrismaService, '$queryRaw'>;

/**
 * 鎖住 system_settings 的某一列(用列的 id 當鍵)。
 * 不同 id 之間互不影響:SSO 設定(id=3)與 M365 快取(id=4)的寫入不會互相排隊。
 */
export async function lockSettingsRow(tx: SettingsLockClient, rowId: number): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SETTINGS_ADVISORY_NAMESPACE}::int, ${rowId}::int)`;
}
