/**
 * 匯入名單的 DTO。原本 controller 收的是 `{ rows?: unknown }`,型別註記不會產生
 * class-validator metadata,全域 ValidationPipe 等於整段跳過:欄位超長會一路撞到
 * PostgreSQL 的 VarChar 限制變成 500。這裡每一欄的長度都對齊 schema.prisma 的
 * DevCustomer 欄位定義,超長就回 400 並指出是哪一欄。
 *
 * 每一個字串欄位另外掛 @NoNulChar:U+0000 是合法的 UTF-8 但 PostgreSQL 的
 * text / varchar 不接受,漏掉的話它會一路走到驅動層變成 500 加一列 error_logs,
 * 而那是輸入問題。前端的匯入解析已經擋過一次(csv-import.ts 的 hasNulChar),
 * 但直接打這支 API 的程式繞得過去 —— 前端的檢查是體驗,後端的才是防線。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { NoNulChar } from '../../common/no-control-chars';

/** 一次匯入上限;service 端也會再切掉多的,兩邊用同一個常數 */
export const IMPORT_MAX_ROWS = 1000;

export class ImportRowDto {
  /**
   * 這一列在來源檔案裡的列號(試算表看到的那個號碼,標題是第 1 列)。
   * 純粹用來回報「第幾列第幾欄有問題」,不會寫進資料庫。
   * 沒帶也收:直接打這支 API 的程式不一定有列號的概念。
   */
  @IsOptional() @IsInt() @IsPositive() rowNumber?: number;
  @IsOptional()
  @IsString()
  @MaxLength(16, { message: '識別碼最多 16 字' })
  @NoNulChar('識別碼')
  taxId?: string;
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '公司名稱最多 200 字' })
  @NoNulChar('公司名稱')
  companyName?: string;
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: '商業分類最多 40 字' })
  @NoNulChar('商業分類')
  category?: string;
  /** 中文標籤(例如「名單/陌生」)或英文階段值,對照表在 crm.service.ts */
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: '進度最多 20 字' })
  @NoNulChar('進度')
  stage?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '聯絡人最多 100 字' })
  @NoNulChar('聯絡人')
  contactName?: string;
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: '聯絡電話最多 40 字' })
  @NoNulChar('聯絡電話')
  contactPhone?: string;
  /** note 在 DB 是 Text,這裡的上限與 CreateDevCustomerDto 一致,避免匯入塞進超大字串 */
  @IsOptional()
  @IsString()
  @MaxLength(8000, { message: '備註最多 8000 字' })
  @NoNulChar('備註')
  note?: string;
  /*
   * 三個地址。上限 300 對齊 schema.prisma 的 VarChar(300) 與 CreateDevCustomerDto。
   *
   * 沒有這三欄的時候,匯入進來的客戶三個地址全空:CrmGeoService 的 hasAddress() 為假,
   * 那批客戶不計入 pendingGeocode、永遠不會被補座標、lat 永遠是 null,結果是
   * 拜訪地圖上完全看不到它們;打卡的 distanceM 也一律 null,假定位偵測對它們等於關閉。
   * 兩件事正好是這套產品跟一般 CRM 的差別所在,所以匯入這條路一定要收得到地址。
   */
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: '實際營業地址最多 300 字' })
  @NoNulChar('實際營業地址')
  actualAddress?: string;
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: '登記地址最多 300 字' })
  @NoNulChar('登記地址')
  registeredAddress?: string;
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: '聯絡地址最多 300 字' })
  @NoNulChar('聯絡地址')
  contactAddress?: string;
}

export class ImportRowsDto {
  /**
   * 這一次匯入的批次識別碼,由呼叫端產生並且**整次匯入共用同一個值**。
   *
   * 為什麼要讓前端帶進來:前端會把大檔切成每批最多 100 筆逐批 POST,
   * 一次 300 列的匯入就是三次請求。如果批次識別碼在這裡每次自己 randomUUID(),
   * 那一次匯入會長出三個識別碼,而「刪掉這一批」一次只收得回其中 100 筆,
   * 回收桶的下拉也會出現三個標籤與時間戳完全一樣、分不出誰是誰的選項。
   *
   * 沒帶就自己生一個(直接打這支 API 的程式不一定有批次的概念),
   * 行為與舊版一致,所以這是相容的擴充而不是破壞性改動。
   */
  @IsOptional()
  @IsUUID('4', { message: '匯入批次識別碼必須是 UUID' })
  importBatchId?: string;

  @IsArray()
  @ArrayMaxSize(IMPORT_MAX_ROWS, { message: `一次最多匯入 ${IMPORT_MAX_ROWS} 筆,請分批` })
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows!: ImportRowDto[];
}
