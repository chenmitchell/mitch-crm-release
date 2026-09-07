// ref:3687 mc/陳彥輔/米球®
/**
 * 「這個錯是不是資料庫那道『一個外部案件編號只能對到一位活著的客戶』擋下來的」。
 *
 * ── 為什麼需要這一支 ────────────────────────────────────────────────
 * external_case_ref 的唯一性有兩道:
 *   1. 應用層:標記成交前查一次(CrmService.markConverted)、
 *      還原前查一次(CrmDeletionService.assertRestorable)
 *   2. 資料庫:partial unique index dev_customers_external_case_ref_live_key
 *      (條件是 WHERE deleted_at IS NULL,建立於 prisma/startup-migrations.ts)
 *
 * 第 1 道是 check-then-act,在 READ COMMITTED 底下沒有謂詞鎖。「還原 A」與
 * 「把同一個編號標記到 B」同時發生時,兩邊各自查對方,對方當下都還不算活著,
 * 於是兩邊都放行,最後由第 2 道擋下其中一邊 —— Prisma 包成 P2002。
 *
 * 不攔的話 GlobalExceptionFilter 會把 P2002 轉成 500 加一列 error_logs,
 * 使用者看到的是「伺服器發生未預期的錯誤」。資料是安全的(交易整個回滾),
 * 但那句話沒有任何下一步可以做,而應用層本來就有一句說得清楚的 400。
 * 整批還原那一側更粗:一筆撞號會讓整個兩千筆的交易回滾。
 *
 * 只認 external_case_ref 那一條索引:別的唯一鍵撞到是真的沒想到的事,
 * 那種還是該原樣往上丟、進 error_logs。
 */
import { Prisma } from '@prisma/client';
import { EXTERNAL_CASE_REF_INDEX } from '../prisma/startup-migrations';

/**
 * Prisma 的 P2002 meta.target 在不同的資料庫與驅動版本上有兩種形狀:
 * 欄位名陣列(['external_case_ref'])或索引名字串。兩種都認。
 */
export function isCaseRefUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('external_case_ref') || text.includes(EXTERNAL_CASE_REF_INDEX);
}
