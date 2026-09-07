/**
 * 拜訪排程 DTO:單筆建立/更新(客戶 + 台北日期 + 可選備註)、一次排多天、取消。
 * 日期只驗格式,是否為有效日期、是否過期由 service 檢查並回中文 400。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { NoNulChar } from '../../../common/no-control-chars';

const DATE_MSG = '排程日期格式須為 YYYY-MM-DD';
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 一次最多排幾天(排一週用 7,留一點餘裕) */
export const BULK_MAX_DATES = 14;

export class CreateVisitPlanDto {
  @IsUUID('4', { message: '客戶 id 格式錯誤' }) customerId!: string;
  @Matches(DATE_RE, { message: DATE_MSG }) plannedDate!: string;
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '備註最多 200 字' })
  @NoNulChar('備註')
  note?: string;
}

export class BulkVisitPlanDto {
  @IsUUID('4', { message: '客戶 id 格式錯誤' }) customerId!: string;
  @IsArray()
  @ArrayMinSize(1, { message: '至少要選一天' })
  @ArrayMaxSize(BULK_MAX_DATES, { message: `一次最多排 ${BULK_MAX_DATES} 天` })
  @Matches(DATE_RE, { each: true, message: DATE_MSG })
  dates!: string[];
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '備註最多 200 字' })
  @NoNulChar('備註')
  note?: string;
}

export class UpdateVisitPlanDto {
  @IsIn(['cancelled'], { message: '目前只能把排程改為取消' }) status!: 'cancelled';
}
