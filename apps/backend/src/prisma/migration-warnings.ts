// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 開機後的「防線盤點」:哪一道資料庫層的約束沒有建起來,以及為什麼。
 *
 * 為什麼需要這一支:startup-migrations 裡那幾道 `有重複就不建索引` 的步驟
 * (users.email 忽略大小寫、dev_customers.external_case_ref 只算未刪除的)
 * 用的是 `RAISE WARNING`,而 RAISE WARNING 只會進 PostgreSQL 的 server log。
 * 大部分部署方看不到那份 log(受管資料庫、平台把 stdout 收走、沒有人訂閱),
 * 於是實際情況是:系統少了一道防線,而唯一知道這件事的地方沒有人讀。
 * 症狀是「一切正常」直到某天真的出現兩筆掛同一個編號的客戶。
 *
 * 所以這裡在啟動時**自己去問資料庫**索引在不在,不在就把原因寫成一列
 * error_logs(level=warn),管理員在後台的錯誤記錄頁看得到,訊息裡直接附上
 * 找重複的 SQL,而且說得出「處理完重複之後下次重啟會自動補上」。
 *
 * 三件事刻意不做:
 *   1. 不動任何一列業務資料(這裡只有 SELECT 與一列 error_logs)
 *   2. 不擋啟動(整支包在 try / catch 裡,查不到就算了)
 *   3. 不重複洗版:同一件事的指紋固定,已經有一列還在保留期內就只累加次數,
 *      做法與 ErrorsService.record 一致。不然每重啟一次就多一列一模一樣的。
 *
 * 併發啟動:兩個容器同時開機時,另一邊可能正在建同一個索引而交易還沒 commit,
 * 這時候查到的「索引不存在」是空窗裡的快照。所以真的要寫進 error_logs 之前
 * 會再讀一次索引狀態,只有兩次都讀不到才寫。互斥的主力在
 * startup-migrations 的 advisory lock(它會等對方跑完),這裡是第二道。
 */
import { Logger } from '@nestjs/common';
import { errorFingerprint } from '../errors/error-fingerprint';
import { EXTERNAL_CASE_REF_INDEX } from './startup-migrations';

/** 這支只需要兩件事:查一句 SQL、寫一列 error_logs。測試好接,不綁 PrismaService 全型別 */
export interface MigrationWarningDeps {
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
  errorLog: {
    findFirst(args: unknown): Promise<{ id: bigint } | null>;
    update(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
  };
}

/** 要盤點的每一道防線:索引名、怎麼數重複、寫給管理員看的那句話 */
export interface GuardCheck {
  /** 索引名(pg 的 relname) */
  readonly index: string;
  /** 這道防線在守什麼,寫進訊息裡 */
  readonly what: string;
  /** 數「現在還有幾組重複」的 SQL,回一列一欄 dup_count */
  readonly dupCountSql: string;
  /** 管理員要自己查時可以直接抄的 SQL */
  readonly findDupSql: string;
}

export const GUARD_CHECKS: readonly GuardCheck[] = [
  {
    index: 'users_email_lower_key',
    what: 'email 忽略大小寫的唯一性(少了它,同一個人可以有兩個只差在大小寫的帳號)',
    dupCountSql: `SELECT count(*)::int AS dup_count FROM (
      SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
    ) d`,
    findDupSql: 'SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;',
  },
  {
    index: EXTERNAL_CASE_REF_INDEX,
    what: '外部案件編號的唯一性(少了它,兩筆還活著的客戶可以掛同一個編號,對帳時分不出是哪一位)',
    dupCountSql: `SELECT count(*)::int AS dup_count FROM (
      SELECT external_case_ref FROM dev_customers
      WHERE deleted_at IS NULL AND external_case_ref IS NOT NULL
      GROUP BY external_case_ref HAVING count(*) > 1
    ) d`,
    findDupSql:
      'SELECT external_case_ref, count(*) FROM dev_customers WHERE deleted_at IS NULL AND external_case_ref IS NOT NULL GROUP BY 1 HAVING count(*) > 1;',
  },
];

/** 同一件事在保留期內只留一列,重複的累加次數。跟 error_logs 的合併窗同一個量級 */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 寫給管理員看的那一句。純函式,測試直接比字串。
 *
 * 要說三件事:少了哪一道、為什麼(有幾組重複)、下一步怎麼做。
 * 只寫「索引未建立」的話,看到的人不知道那代表什麼,也不知道要做什麼。
 */
export function guardWarningMessage(check: GuardCheck, dupCount: number): string {
  return (
    `資料庫少了一道防線:${check.index} 沒有建立,因為目前有 ${dupCount} 組重複的資料。` +
    `這道索引守的是${check.what}。` +
    `請先用這句 SQL 找出重複並處理掉:${check.findDupSql} ` +
    `處理完之後下一次重新啟動會自動把索引補上,這一則警告也會停止出現。`
  );
}

/** 索引在不在。to_regclass 查不到時回 NULL,不會丟例外 */
function indexExistsSql(index: string): string {
  // 索引名由 GUARD_CHECKS 這份常數決定,不是外部輸入;仍然只允許識別碼字元,
  // 免得日後有人把它接成參數之後這一句變成注入點
  const safe = index.replace(/[^a-z0-9_]/gi, '');
  return `SELECT (to_regclass('public.${safe}') IS NOT NULL) AS present`;
}

function firstRow(rows: unknown): Record<string, unknown> | null {
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
}

/**
 * 盤點一輪,回傳「這一次寫了幾則警告」。
 * 任何一步失敗都只記 log:這是一支報告用的檢查,不該自己變成啟動失敗的新原因。
 */
export async function reportMigrationWarnings(
  db: MigrationWarningDeps,
  checks: readonly GuardCheck[] = GUARD_CHECKS,
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('MigrationWarnings'),
): Promise<{ warned: number }> {
  let warned = 0;
  for (const check of checks) {
    try {
      const present = firstRow(await db.$queryRawUnsafe(indexExistsSql(check.index)));
      if (present?.present === true) continue;
      const dup = firstRow(await db.$queryRawUnsafe(check.dupCountSql));
      const dupCount = Number(dup?.dup_count ?? 0);
      // 索引不在、重複也是 0:資料表可能還沒建好,或這一輪的遷移還沒跑到。
      // 下一次重啟會補上,沒有什麼要管理員做的,不必為它寫一列警告。
      if (!Number.isFinite(dupCount) || dupCount <= 0) continue;
      // ── 寫進 error_logs 之前再讀一次索引狀態 ──────────────────────
      // 併發啟動時,另一個實例可能正在同一個索引上做 CREATE UNIQUE INDEX,
      // 而它的交易還沒 commit:上面第一次讀到的「不存在」是那個空窗裡的快照。
      // 這中間我們還跑了一句數重複的查詢,空窗又拉長了一點。
      // 這一列是要給管理員看的、會停在後台錯誤記錄頁上的東西,寧可多花一次
      // to_regclass 也不要留一則查下去什麼都查不到的假警報。
      // 主要的互斥在 startup-migrations 的 advisory lock(那一支會等對方跑完),
      // 這裡是第二道:等鎖等到上限而跳過的那一輪,仍然會走到這裡。
      const stillMissing = firstRow(await db.$queryRawUnsafe(indexExistsSql(check.index)));
      if (stillMissing?.present === true) {
        logger.log(`防線盤點:${check.index} 在這一輪稍晚已經建立,不寫警告`);
        continue;
      }
      const message = guardWarningMessage(check, dupCount);
      const fingerprint = errorFingerprint({ level: 'warn', message: `guard:${check.index}` });
      const now = new Date();
      const existing = await db.errorLog.findFirst({
        where: { fingerprint, createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) {
        await db.errorLog.update({
          where: { id: existing.id },
          data: { seenCount: { increment: 1 }, lastSeenAt: now, message: message.slice(0, 1000) },
        });
      } else {
        await db.errorLog.create({
          data: {
            level: 'warn',
            message: message.slice(0, 1000),
            metadata: { index: check.index, duplicates: dupCount },
            fingerprint,
            seenCount: 1,
            lastSeenAt: now,
          },
        });
      }
      warned += 1;
      logger.warn(message);
    } catch (err) {
      const kind = err instanceof Error ? err.name : 'UnknownError';
      logger.warn(`防線盤點未完成:${check.index}(${kind})`);
    }
  }
  if (warned === 0) logger.log('資料庫防線盤點完成,沒有待處理的重複資料');
  return { warned };
}
