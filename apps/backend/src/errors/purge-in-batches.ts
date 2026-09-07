// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 分批清除。錯誤記錄與稽核記錄的保留期都走這一支。
 *
 * 為什麼不是一句 `DELETE FROM ... WHERE created_at < cutoff`:
 * 那一句在正常狀態下只刪掉幾列,看起來沒有問題,而它真正會被執行的時機恰好是
 * 最壞的那一種 —— 升級到「有保留期」的第一次、或長期停機後重新啟動 ——
 * 那一刻要刪的是累積了整段期間的全部列。PostgreSQL 的 DELETE 會對每一列取列鎖
 * 並且持有到交易結束,一次刪幾十萬列等於把整張表鎖住好幾秒到好幾分鐘,
 * 期間任何一筆寫入都在後面排隊。錯誤記錄那一支還更糟:清理掛在寫入路徑上,
 * 排隊的正是「現在正在發生的那個錯誤」的請求。
 *
 * 分批的做法:先讀一批 id(讀不取鎖),再用 id 刪掉這一批。每一句交易只握住
 * 一批的列鎖,中間讓得出位置給正常寫入。一輪跑不完也沒關係,下一輪接著跑。
 *
 * 這一支不碰 Prisma 也不碰 Nest:兩張表的欄位名與型別都不一樣,共用的只有
 * 「怎麼分批」這件事,所以介面收兩個 callback,測試直接餵假的。
 */

/** 一批的預設大小。一千列的列鎖持有時間在實測上是毫秒等級 */
export const PURGE_BATCH_SIZE = 1_000;
/**
 * 一輪最多跑幾批。跑滿就停下來,剩下的留給下一輪。
 *
 * 有上限的理由:沒有上限的話,累積了一百萬列要刪的那一次會在單一次呼叫裡
 * 跑上幾分鐘,而清理是搭在別的工作旁邊跑的,不該把那個工作綁住那麼久。
 * 預設 50 批 = 一輪最多五萬列,對一天新增幾千列的表來說遠遠夠用,
 * 而積欠的量再大也只是多花幾輪。
 *
 * ★ 「多花幾輪」只有在呼叫端真的會很快再跑一輪時才成立。回傳值裡的 hitLimit
 *   就是給呼叫端判斷的:true 代表這一輪是被上限截斷的、還有沒刪完的,
 *   呼叫端應該排一個短間隔的追加輪次,不要等到下一次正常間隔。
 *   稽核記錄那一支的正常間隔是 24 小時,少了追加輪次的話積欠會以每天五萬列的
 *   速度慢慢消(見 audit-retention.service.ts 的 AUDIT_PURGE_CATCHUP_DELAY_MS)。
 */
export const PURGE_MAX_BATCHES = 50;

export interface BatchPurgeOptions {
  /** 一批幾列 */
  readonly batchSize?: number;
  /** 一輪最多幾批 */
  readonly maxBatches?: number;
}

export interface BatchPurgeDeps<Id> {
  /** 讀出最多 limit 筆「該刪的」id。回空陣列表示沒有了 */
  findIds(limit: number): Promise<Id[]>;
  /** 刪掉這些 id,回實際刪掉幾列 */
  deleteByIds(ids: Id[]): Promise<number>;
}

export interface BatchPurgeResult {
  /** 這一輪總共刪掉幾列 */
  readonly deleted: number;
  /** 跑了幾批 */
  readonly batches: number;
  /** true = 撞到一輪的批數上限,還有沒刪完的,下一輪會接著跑 */
  readonly hitLimit: boolean;
}

/**
 * 分批刪到沒有東西可刪、或撞到批數上限為止。
 *
 * 任何一批丟出例外都直接往外拋:呼叫端各自決定要不要吞掉(兩個呼叫端都會吞,
 * 清理失敗不該連累它搭著跑的那件事),但這一支不要自己把失敗吃掉,
 * 不然「清理其實一直在失敗」會完全沒有訊號。
 */
export async function purgeInBatches<Id>(
  deps: BatchPurgeDeps<Id>,
  opts: BatchPurgeOptions = {},
): Promise<BatchPurgeResult> {
  const batchSize = Math.max(1, opts.batchSize ?? PURGE_BATCH_SIZE);
  const maxBatches = Math.max(1, opts.maxBatches ?? PURGE_MAX_BATCHES);
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const ids = await deps.findIds(batchSize);
    if (ids.length === 0) return { deleted, batches, hitLimit: false };
    deleted += await deps.deleteByIds(ids);
    batches += 1;
    // 讀回來的比一批少 = 已經是最後一批,不必再多跑一次空的往返
    if (ids.length < batchSize) return { deleted, batches, hitLimit: false };
  }
  return { deleted, batches, hitLimit: true };
}
