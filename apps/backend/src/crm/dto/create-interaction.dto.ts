import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { KEY_FORMAT_MESSAGE, SETTINGS_KEY_PATTERN } from '../../app-settings/app-settings.view';
import { NoNulChar } from '../../common/no-control-chars';

export class CreateInteractionDto {
  /**
   * 互動管道代碼。合法值以 dev_interaction_channels 資料表為準,不是寫死的清單 ——
   * 寫死的話,後台新增的管道會在這一行被擋成一句泛用的列舉錯誤。
   * 這裡只驗格式;visit 由 service 回「拜訪打卡請到外勤拜訪頁進行」,
   * 對不上主檔的代碼由 service 收斂成備註。
   */
  @IsOptional() @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) channel?: string;
  /** 不可以「【」開頭(保留給系統紀錄),由 service 檢查 */
  @IsOptional() @IsString() @MaxLength(2000) @NoNulChar('備註') note?: string;
  /** 不可晚於伺服器時間,由 service 檢查;沿用寬鬆的 IsISO8601,避免打壞舊前端 */
  @IsOptional() @IsISO8601() occurredAt?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('下一步') nextAction?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) gpsLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) gpsLng?: number;
}
