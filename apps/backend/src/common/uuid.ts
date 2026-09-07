// ref:3687 mc/陳彥輔/米球®
/**
 * UUID 字串格式的單一判準。
 *
 * 這條規則原本在後端有三份:crm-visit-plans.service.ts 一份嚴格版(檢查版本位與
 * variant 位),crm.service.ts 與 crm-daily-reports.controller.ts 各一份寬鬆版
 * (三十二個十六進位字元加四個減號就過)。實測差異看得到:全零的
 * 00000000-0000-0000-0000-000000000000 與 UUIDv7 在寬鬆版是合法值、在嚴格版被擋掉。
 *
 * 統一採嚴格版。理由是這條規則的用途只有一種:把使用者送進來的字串
 * (query 的 ownerId、cursor、userId)擋在查詢之前,免得那些值變成
 * Postgres 的 uuid 轉型錯誤或無意義的全表掃描。而這個系統寫進資料庫的 id
 * 一律是 Prisma 的 uuid()(第 4 版),所以嚴格版不會擋掉任何一個真實存在的 id,
 * 卻能把「看起來像 uuid 的亂填值」提早擋下來。
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 寬鬆版:三十二個十六進位字元加四個減號就過,不檢查版本位與 variant 位。
 *
 * 這一條**刻意**跟嚴格版 UUID_RE 不同,不要盲目換成嚴格版。它唯一的用途是
 * crm.service.ts 的 markConverted 檢查 `externalCaseRef` —— 那是**外部系統**的案件
 * 編號,由對方系統產生,不保證是 UUIDv4:全零、UUIDv7、或別種 variant 都可能是
 * 對方的合法編號。用嚴格版會把對方系統送來的合法編號擋成「格式錯誤」。
 *
 * 反過來,凡是「本系統自己寫進資料庫的 id」(ownerId、cursor、userId 這類)一律用
 * 嚴格版 UUID_RE:那些 id 全是 Prisma 的 uuid()(第 4 版),用嚴格版不會擋掉任何
 * 真實存在的 id,還能把亂填值提早擋下來。判準是「這個值是誰產生的」:
 * 我們自己產生的用 UUID_RE,外部系統產生的用 LOOSE_UUID_RE。
 */
export const LOOSE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
