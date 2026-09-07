/**
 * 拜訪打卡存證 DTO:GPS 座標、客戶端時間、備註、下一步,以及可選的多張存證照片(base64 + 類型)。
 * 照片內容長度只在這裡擋「明顯超大」的字串與張數;實際大小、總量、mime、magic bytes 由 service 解碼後再驗。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PHOTOS_MAX_COUNT, type VisitPhotoKindValue } from '../checkin-rules';
import { NoNulChar } from '../../../common/no-control-chars';

export const PHOTO_MIMES = ['image/jpeg', 'image/webp', 'image/png'] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];

/** 600KB 二進位 → base64 約 800KB;多留一點餘裕給換行/padding,超過就直接拒收 */
const BASE64_MAX_CHARS = 900_000;

export class CheckinPhotoDto {
  /**
   * 照片類型代碼。這裡只驗格式,不驗「是不是允許清單裡的那幾種」——
   * 類型已經改成後台可增減的資料表(visit_photo_kinds),寫死在 DTO 的話,
   * 新增的類型會在進 service 之前就被 400 擋掉,而錯誤訊息看不出原因。
   * 存不存在由 CrmCheckinService.assertKindsExist 對資料表檢查。
   */
  @Matches(/^[a-z][a-z0-9_]{0,39}$/, { message: '照片類型代碼格式錯誤' })
  kind!: VisitPhotoKindValue;
  @IsIn(PHOTO_MIMES) mime!: PhotoMime;
  @IsString() @MaxLength(BASE64_MAX_CHARS, { message: '照片超過大小上限(600KB)' }) base64!: string;
  /** 拍攝時間;service 另檢查須含時區、且落在伺服器時間 ±24 小時內 */
  @IsISO8601({ strict: true }) takenAt!: string;
}

export class CheckinDto {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  /** 定位精度(公尺),必填:速度 / 精度規則都靠它;手機拿不到精度就不能打卡 */
  @IsNumber({}, { message: '缺少定位精度' })
  @Min(0, { message: '定位精度不可為負數' })
  @Max(100_000, { message: '定位精度超出範圍' })
  accuracy!: number;
  /** 手機時間;service 另檢查須含時區(Z 或 ±hh:mm) */
  @IsISO8601({ strict: true }) clientTime!: string;
  // note / nextAction 會原樣寫進 dev_interactions,所以與匯入那條路一樣要擋 NUL:
  // 從壞掉的檔案複製一段文字貼進打卡備註,不掛的話會變成 500 加一列 error_logs
  @IsOptional() @IsString() @MaxLength(2000) @NoNulChar('備註') note?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('下一步') nextAction?: string;
  @IsOptional() @IsISO8601({ strict: true }) nextFollowUpAt?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PHOTOS_MAX_COUNT, { message: '一次最多上傳 8 張照片' })
  @ValidateNested({ each: true })
  @Type(() => CheckinPhotoDto)
  photos?: CheckinPhotoDto[];
}

/**
 * 純補拍:不跑速度 / 距離等假定位規則、不改 stage、不動 lastContactAt;有座標就照打卡一樣寫 GPS 欄位。
 * clientTime(手機時間)有給且與伺服器相差超過 5 分鐘時,service 會把該筆互動標成 gpsSuspicious 並寫理由。
 */
export class AddPhotosDto {
  @IsArray()
  @ArrayMaxSize(PHOTOS_MAX_COUNT, { message: '一次最多上傳 8 張照片' })
  @ValidateNested({ each: true })
  @Type(() => CheckinPhotoDto)
  photos!: CheckinPhotoDto[];
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @IsNumber() @Min(0) accuracy?: number;
  @IsOptional() @IsISO8601({ strict: true }) clientTime?: string;
}
