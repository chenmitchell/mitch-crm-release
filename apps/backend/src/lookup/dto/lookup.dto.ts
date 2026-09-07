// ref:3687 mc/陳彥輔/米球®
/**
 * 查詢參數。全域 ValidationPipe 開了 whitelist + forbidNonWhitelisted,
 * 所以多帶一個參數會被擋掉,不會靜靜被忽略。
 *
 * 這裡只擋「長度」與「有沒有填」;識別碼的格式由後台設定的 lookupPattern 決定,
 * 那是執行期才知道的規則,不能寫進 DTO 的裝飾器。
 */
import { IsString, MaxLength, MinLength } from 'class-validator';
import { LOOKUP_QUERY_MAX } from '../lookup-url';

// q 是查詢參數,不會被寫進資料庫,所以不掛 @NoNulChar(規則見 ../common/no-control-chars.ts)
export class LookupQueryDto {
  @IsString()
  @MinLength(1, { message: '請輸入要查詢的識別碼' })
  @MaxLength(LOOKUP_QUERY_MAX, { message: `識別碼最長 ${LOOKUP_QUERY_MAX} 個字` })
  q!: string;
}
