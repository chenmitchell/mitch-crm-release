/**
 * 拜訪地圖 API 的輸入驗證 DTO(query / body)。
 * lat 限 -90..90、lng 限 -180..180、ids 必須是 UUID 陣列(最多 30 筆)。
 * ReverseQueryDto 的 lat / lng 為必填(反查路名)。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** query string 的 `lat=` 空值視為沒傳;其餘轉數字(非數字會被 IsNumber 擋下)。 */
const toOptionalNumber = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value.trim());
  return Number.NaN;
};

export class MapCustomersQueryDto {
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsIn(['today', 'all'])
  scope?: 'today' | 'all';
}

export class RouteBodyDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsUUID('all', { each: true })
  ids!: string[];
}

/** GET reverse?lat=&lng= 的 query:兩個都必填 */
export class ReverseQueryDto {
  @Transform(toOptionalNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat!: number;

  @Transform(toOptionalNumber)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng!: number;
}
