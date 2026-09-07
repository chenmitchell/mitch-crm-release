// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';
import { NoNulChar } from '../../common/no-control-chars';

export class CreateDepartmentDto {
  // 會寫進 departments.name,所以擋 NUL(理由見 common/no-control-chars.ts)
  @IsString() @MaxLength(100) @NoNulChar('部門名稱') name!: string;
  /** 上層部門;null 或不帶 = 最上層 */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() parentId?: string | null;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('部門名稱') name?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() parentId?: string | null;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
