import { IsISO8601, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { KEY_FORMAT_MESSAGE, SETTINGS_KEY_PATTERN } from '../../app-settings/app-settings.view';
import { NoNulChar } from '../../common/no-control-chars';

/**
 * 手動建檔 / 編輯客戶。
 *
 * 每一個會被寫進資料庫的字串欄位都掛 @NoNulChar:U+0000 是合法的 UTF-8 但
 * PostgreSQL 的 text / varchar 不接受,漏掉的話它會一路走到驅動層變成 500
 * 加一列 error_logs,而那是輸入問題,該回 400 並指出是哪一欄。
 * 匯入那條路(ImportRowDto)一直有,手動建檔這條沒有 —— 從壞掉的檔案複製一段
 * 文字貼進公司名或備註,走的就是這一條。
 * stage / premisesType 不用掛:@Matches 的樣式本身就不允許 NUL。
 */
export class CreateDevCustomerDto {
  @IsOptional() @IsString() @MaxLength(16) @NoNulChar('識別碼') taxId?: string;
  @IsOptional() @IsString() @MaxLength(200) @NoNulChar('公司名稱') companyName?: string;
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('公司負責人') representative?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('登記地址') registeredAddress?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('實際營業地址') actualAddress?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('聯絡地址') contactAddress?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('網站') website?: string;
  @IsOptional() @IsString() @MaxLength(200) @NoNulChar('社群連結') social?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('商業分類') category?: string;
  /**
   * 階段代碼。合法值以 dev_stages 資料表為準,不是寫死的清單 ——
   * 寫死的話,後台新增的階段會被這一行擋掉,而且錯誤訊息看不出原因。
   * 這裡只驗格式,值存不存在由 CrmService 對照資料表。
   */
  @IsOptional() @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) stage?: string;
  /**
   * 場所類型代碼。結案前必填,決定必備存證照片清單。
   * 合法值以 dev_premises_types 資料表為準,理由同上面的 stage:
   * 寫死清單的話,後台新增的場所類型會被這一行擋掉。這裡只驗格式,
   * 對不對得上主檔由 CrmService 判斷(對不上視為未填)。
   * 空字串代表「清掉」(表單下拉的未選項),略過驗證,service 端視為 null。
   */
  @ValidateIf(
    (o: CreateDevCustomerDto) =>
      o.premisesType !== undefined && o.premisesType !== null && o.premisesType !== '',
  )
  @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE })
  premisesType?: string;
  @IsOptional() @IsString() @MaxLength(60) @NoNulChar('來源') source?: string;
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('聯絡人') contactName?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('聯絡電話') contactPhone?: string;
  /** 上限 8000:成交時會把最近 20 筆互動歷程附進備註,2000 不夠放 */
  @IsOptional() @IsString() @MaxLength(8000) @NoNulChar('備註') note?: string;
  @IsOptional() @IsISO8601() nextFollowUpAt?: string;
}
