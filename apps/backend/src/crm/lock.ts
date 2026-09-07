/**
 * 客戶列鎖(SELECT ... FOR UPDATE):打卡 / 補拍 / 刪照片 / 標記成交都在交易開頭先鎖同一客戶列,
 * 同一客戶的併發請求就會排隊,配額、已成交、重複標記的檢查才不會在「讀完到寫入之間」被繞過。
 * 只能在 prisma.$transaction(async (tx) => ...) 的 tx 上呼叫,交易結束鎖自動釋放。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export async function lockCustomerRow(
  tx: Pick<PrismaService, '$queryRaw'>,
  customerId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM dev_customers WHERE id = ${customerId}::uuid FOR UPDATE`;
}

/**
 * 一次鎖住多筆客戶列(整批刪除 / 整批還原用)。
 *
 * 為什麼不是「迴圈呼叫 lockCustomerRow」:整批一次動兩千筆,兩千次往返本身就慢,
 * 而且逐筆取鎖的順序由呼叫端的陣列順序決定 —— 兩個整批操作的清單交錯時就會反向互等。
 * 這裡一句 SQL 取完,並且 **ORDER BY id**,取鎖順序固定,兩個整批之間不可能成環
 * (與 crm-duplicates 合併時鎖兩筆的做法同一個理由)。
 *
 * 空陣列直接返回:`IN ()` 不是合法的 SQL。
 */
export async function lockCustomerRows(
  tx: Pick<PrismaService, '$queryRaw'>,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM dev_customers WHERE id IN (${Prisma.join(
      ids.map((id) => Prisma.sql`${id}::uuid`),
    )}) ORDER BY id FOR UPDATE`,
  );
}

/**
 * 永久刪除用:一次鎖住「這一筆客戶」與「所有 merged_into_id 指著它的客戶」。
 *
 * 為什麼不是 lockCustomerRow(target) 之後再去動別的列:purge 會把指向它的那幾筆的
 * merged_into_id 清掉並改寫備註,那些 UPDATE 各自取的列鎖順序由查詢回來的順序決定,
 * 而 lockCustomerRows(整批刪除 / 整批還原用)是照 id 序取鎖的 —— 兩種順序交錯時
 * 就有成環的機會,Postgres 會中止其中一筆,使用者拿到的是一個看不懂的 500。
 *
 * 一句 SQL 把要碰的列全部取完,而且 **ORDER BY id**,與 lockCustomerRows 同一個順序,
 * 兩條路徑之間不可能反向互等。
 * ref:3687 mc/陳彥輔/米球®
 */
export async function lockCustomerAndMergedSources(
  tx: Pick<PrismaService, '$queryRaw'>,
  customerId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM dev_customers WHERE id = ${customerId}::uuid OR merged_into_id = ${customerId}::uuid ORDER BY id FOR UPDATE`;
}

/**
 * 每人每日上傳配額用的建議鎖(advisory lock)的命名空間。
 * 與後台存檔的 APP_SETTINGS_LOCK_KEY、安裝精靈的 SETUP_LOCK_KEY 是同一套做法,
 * 不同的鍵值:共用一把只會讓互不相干的兩件事互相等。
 */
export const UPLOAD_QUOTA_LOCK_NS = 3687_0003;

/**
 * 把「這位使用者的上傳」序列化。
 *
 * 為什麼客戶列鎖不夠:每人每日上傳配額算的是「這位使用者今天寫進去的總量」,
 * 而客戶列鎖是**以客戶為單位**的。同一位使用者同時對兩個不同的客戶上傳,
 * 兩筆交易鎖的是兩列不同的客戶,兩邊各自讀到「今天還沒超過」而各自寫入,
 * 總量因此可以超出上限(速率限制只把可超出的量壓小,沒有把它變成不可能)。
 * 這裡改成以使用者為單位再鎖一次,檢查與寫入之間就沒有別人插得進來。
 *
 * 順序:這一把要在 lockCustomerRow **之前**拿。
 * 反過來的話,同一位使用者的兩筆交易可能各自先握住不同的客戶列、再一起搶這把鎖,
 * 而別的路徑(標記成交、移交)只拿客戶列鎖 —— 兩種順序混在一起就有成環的機會。
 * 先拿使用者鎖、再拿客戶列鎖,只拿客戶列鎖的那些路徑永遠不會反過來等這把鎖,
 * 環就構不成。
 *
 * hashtext 把 uuid 字串壓成 int4;不同 uuid 極少數會撞同一個雜湊值,
 * 後果只是那兩位使用者的上傳偶爾互相等一下,不影響正確性。
 * xact 版:交易結束自動釋放,不必自己 unlock。
 */
export async function lockUserUploadQuota(
  tx: Pick<PrismaService, '$queryRaw'>,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${UPLOAD_QUOTA_LOCK_NS}::int, hashtext(${userId})::int)`;
}
