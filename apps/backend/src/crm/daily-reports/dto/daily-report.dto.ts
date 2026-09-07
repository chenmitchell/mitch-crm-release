/**
 * 日報彙整 DTO:送出日報(內容 ≤5000 字、日期 YYYY-MM-DD、可選統計物件)、主管批註/已讀。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NoNulChar, NoNulCharDeep } from '../../../common/no-control-chars';

export class SubmitDailyReportDto {
  /** 報告日期(組織時區的日曆日);省略則為組織時區的今天 */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '報告日期格式須為 YYYY-MM-DD' })
  reportDate?: string;

  @IsString()
  @MinLength(1, { message: '日報內容不可空白' })
  @MaxLength(5000, { message: '日報內容最多 5000 字' })
  @NoNulChar('日報內容')
  content!: string;

  /**
   * 統計數字(例如 interactions / visits / interested),原樣存進 Json 欄位。
   * jsonb 跟 text 一樣不接受 U+0000,所以這一格用遞迴版的檢查。
   */
  @IsOptional() @IsObject() @NoNulCharDeep('統計數字') stats?: Record<string, unknown>;
}

export class ReviewDailyReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: '批註最多 2000 字' })
  @NoNulChar('批註')
  managerNote?: string;
  @IsOptional() @IsBoolean() markRead?: boolean;
}
