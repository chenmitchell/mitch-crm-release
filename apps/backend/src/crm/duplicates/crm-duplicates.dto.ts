/**
 * 客戶查重合併 API 的輸入驗證 DTO。
 * merge:keepId / mergeId 都要是 UUID(相同與否在 service 內檢查);
 * check:三個 query 都選填,各限長,避免拿超長字串做正規化比對;
 * groups:負責人與階段兩個篩選條件,都選填(見 DuplicateGroupsQueryDto)。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class MergeDuplicateDto {
  @IsUUID() keepId!: string;
  @IsUUID() mergeId!: string;
}

// 這三格是查詢參數,不會被寫進資料庫,所以不掛 @NoNulChar(規則見 common/no-control-chars.ts)
export class CheckDuplicateQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;
}

/**
 * 查重群組的篩選條件。
 *
 * 這一組是「超過掃描上限時請縮小範圍」那句話的另一半:沒有它,端點一個可以
 * 縮小範圍的參數都沒有,而錯誤訊息卻叫使用者去縮小範圍。
 *
 * ownerId 走 UUID 驗證,而且**只驗形狀**:這個人在不在呼叫者的可見範圍內
 * 由 service 判斷(見 CrmDuplicatesService.ownerScopeWhere),不在範圍就回空清單。
 * stage 是 dev_stages.key,長度跟著 schema 的 varchar(40)。
 */
export class DuplicateGroupsQueryDto {
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  stage?: string;
}
