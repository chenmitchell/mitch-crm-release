// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 安裝精靈的輸入驗證。
 *
 * 形狀與前端 apps/frontend/src/lib/setup.ts 的 SetupPayload 一字不差:
 * **每一段都可以整段省略**(精靈的每一步都能跳過),省略的那一段後端用預設值。
 *
 * 全域 ValidationPipe 開了 forbidNonWhitelisted,所以少宣告一段的後果不是
 * 「那一段被忽略」,而是整包 400 —— 使用者填完九步按送出,只看到一句安裝失敗。
 *
 * 每一個會被寫進資料庫的字串欄位都掛 @NoNulChar(見 common/no-control-chars.ts):
 * 精靈的欄位大多是從別的文件複製貼上來的,而 U+0000 一路走到 PostgreSQL 會變成
 * 500 加一列 error_logs —— 安裝這一步失敗最沒有下一步可以做。
 * 密碼不掛:存進去的是 argon2 雜湊,不是原文。
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { KEY_FORMAT_MESSAGE, SETTINGS_KEY_PATTERN } from '../../app-settings/app-settings.view';
import { SETUP_PASSWORD_MIN } from '../setup.service';
import { LOOKUP_URL_TEMPLATE_MAX } from '../../lookup/lookup-url';
import { NoNulChar, NoNulCharDeep } from '../../common/no-control-chars';

export class SetupOrganizationDto {
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('組織名稱') name?: string;
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('組織顯示名稱') displayName?: string;
  @IsOptional() @IsString() @MaxLength(60) @NoNulChar('產品名稱') productName?: string;
  @IsOptional() @IsString() @MaxLength(60) @NoNulChar('標誌文字') logoText?: string;
}

export class SetupAdminDto {
  @IsEmail() @MaxLength(255) email!: string;
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('姓名') name?: string;
  @IsString() @MinLength(SETUP_PASSWORD_MIN) @MaxLength(200) password!: string;
}

export class SetupLocaleDto {
  @IsOptional() @IsString() @MaxLength(64) @NoNulChar('時區') timezone?: string;
  @IsOptional() @IsString() @MaxLength(35) @NoNulChar('地區') locale?: string;
}

export class SetupDepartmentDto {
  @IsString() @MaxLength(100) @NoNulChar('部門名稱') name!: string;
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('主管姓名') managerName?: string;
  /** 對不到人就只建部門、不指派主管(精靈填的主管通常還沒有帳號) */
  @IsOptional() @IsString() @MaxLength(255) @NoNulChar('主管 email') managerEmail?: string;
}

export class SetupStageDto {
  @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) key!: string;
  @IsString() @MaxLength(40) @NoNulChar('階段名稱') label!: string;
  @IsOptional() @IsString() @MaxLength(20) @NoNulChar('顏色') color?: string;
  @IsOptional() @IsBoolean() board?: boolean;
  @IsOptional() @IsBoolean() form?: boolean;
  @IsOptional() @IsBoolean() terminal?: boolean;
}

export class SetupPhotoItemDto {
  @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) key!: string;
  @IsString() @MaxLength(40) @NoNulChar('照片項目名稱') label!: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @NoNulChar('場所類型', { each: true })
  placeTypes?: string[];
}

export class SetupMapDto {
  @IsOptional() @IsNumber() @Min(-90) @Max(90) defaultLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) defaultLng?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) defaultZoom?: number;
  @IsOptional() @IsIn(['nominatim', 'none']) geocodeProvider?: 'nominatim' | 'none';
  /** 逗號分隔的兩碼國碼,空字串 = 不限制國家。內容由 normalizeGeocodeCountryCodes 收斂 */
  @IsOptional() @IsString() @MaxLength(200) @NoNulChar('國碼') geocodeCountryCodes?: string;
}

export class SetupAppearanceDto {
  @IsOptional() @IsIn(['A', 'B']) themeScheme?: 'A' | 'B';
  @IsOptional() @IsIn(['dark', 'light']) themeSidebar?: 'dark' | 'light';
  @IsOptional() @IsIn(['light', 'dark', 'system']) themeDefaultMode?: 'light' | 'dark' | 'system';
  @IsOptional() @IsObject() @NoNulCharDeep('功能區識別色') areaColors?: Record<string, string>;
}

export class SetupLookupDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('查詢名稱') label?: string;
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_URL_TEMPLATE_MAX)
  @NoNulChar('查詢網址樣板')
  urlTemplate?: string;
  /** 內容由 normalizeLookupFieldMap 收斂(只留 name / address / phone) */
  @IsOptional() @IsObject() @NoNulCharDeep('查詢欄位對照') fieldMap?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(200) @NoNulChar('查詢格式') pattern?: string;
}

export class SetupDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => SetupOrganizationDto)
  organization?: SetupOrganizationDto;

  /**
   * 管理員那一段是唯一不能省略的。
   *
   * 後端判斷「這台裝好了沒」的依據是 users 表有沒有人,所以整包省略 admin 的請求
   * 會拿到 201,但一個帳號都沒建 —— 系統仍然是未初始化,而呼叫端看到的是成功。
   * 前端的精靈已經擋死這一步(見 lib/setup.ts 的 setupAdminError),但直接打 API
   * 繞得過去,所以後端這一半也要有。
   */
  @IsDefined({ message: '安裝時必須建立管理員帳號(admin)' })
  @ValidateNested()
  @Type(() => SetupAdminDto)
  admin!: SetupAdminDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SetupLocaleDto)
  locale?: SetupLocaleDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SetupDepartmentDto)
  departments?: SetupDepartmentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SetupStageDto)
  stages?: SetupStageDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SetupPhotoItemDto)
  photoChecklist?: SetupPhotoItemDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SetupMapDto)
  map?: SetupMapDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SetupAppearanceDto)
  appearance?: SetupAppearanceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SetupLookupDto)
  lookup?: SetupLookupDto;
}
