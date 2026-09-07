// ref:3687 mc/陳彥輔/米球®
/**
 * 刪除 / 整批刪除的 body。
 *
 * 一定要用 DTO class:型別註記(interface 或行內型別)不會產生 class-validator
 * 的 metadata,全域 ValidationPipe 就等於沒作用,force 之類的旗標會照單全收。
 */
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DELETE_REASON_MAX } from '../crm-deletion-rules';
import { NoNulChar } from '../../../common/no-control-chars';

export class DeleteCustomerDto {
  /**
   * 為什麼刪(匯錯、測試資料、重複)。選填,但回收桶會顯示它,鼓勵填。
   * 會原樣寫進 dev_customers.delete_reason,所以照樣要擋 NUL。
   */
  @IsOptional() @IsString() @MaxLength(DELETE_REASON_MAX) @NoNulChar('刪除原因') reason?: string;

  /** 已成交 / 已有紀錄的客戶要刪,必須明確帶 true,而且只有系統管理員可以 */
  @IsOptional() @IsBoolean() force?: boolean;
}

export class DeleteImportBatchDto {
  /** 匯入回應帶回來的批次識別碼 */
  @IsUUID() importBatchId!: string;

  @IsOptional() @IsString() @MaxLength(DELETE_REASON_MAX) @NoNulChar('刪除原因') reason?: string;

  @IsOptional() @IsBoolean() force?: boolean;
}

export class RestoreImportBatchDto {
  @IsUUID() importBatchId!: string;
}
