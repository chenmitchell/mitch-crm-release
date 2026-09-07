// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 應用程式設定的輸入驗證。
 *
 * 全域 ValidationPipe 開了 whitelist + forbidNonWhitelisted,所以沒有宣告的欄位
 * 會被直接擋掉(而不是靜靜丟掉)。要新增一個可設定項目,這裡也要跟著加一行,
 * 不然後台送出去會收到 400 而不是「存好了但沒生效」。
 *
 * 重要:UpdateAppSettingsDto 的欄位名是**前端 AppSettings 的欄位名**,不是資料庫欄位名。
 *    兩者的對應寫在 app-settings.view.ts,那裡是唯一的換算點。
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import {
  KEY_FORMAT_MESSAGE,
  SETTINGS_KEY_PATTERN,
  STAGE_COLOR_NAMES,
  ZONE_NAMES,
  type StageColorName,
} from '../app-settings.view';
import { LOOKUP_URL_TEMPLATE_MAX } from '../../lookup/lookup-url';
import { NoNulChar, NoNulCharDeep } from '../../common/no-control-chars';

/** 一次能設多少個階段 / 照片種類。夠用又不至於讓人一次送一萬筆進來 */
const MAX_LIST_SIZE = 50;

export class StageItemDto {
  @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) key!: string;
  @IsString() @MaxLength(40) @NoNulChar('階段名稱') label!: string;
  @IsOptional() @IsIn(STAGE_COLOR_NAMES as unknown as string[]) color?: StageColorName;
  @IsOptional() @IsBoolean() board?: boolean;
  @IsOptional() @IsBoolean() form?: boolean;
  @IsOptional() @IsBoolean() terminal?: boolean;
}

/**
 * 互動管道 / 場所類型 / 商業分類的一列。三者的形狀相同(代碼 + 顯示名),
 * 排序由陣列順序決定,service 的 syncVocab 會換算成 sortOrder。
 */
export class VocabItemDto {
  @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) key!: string;
  @IsString() @MaxLength(40) @NoNulChar('名稱') label!: string;
}

export class PhotoCheckItemDto {
  @Matches(SETTINGS_KEY_PATTERN, { message: KEY_FORMAT_MESSAGE }) key!: string;
  @IsString() @MaxLength(40) @NoNulChar('照片項目名稱') label!: string;
  @IsOptional() @IsBoolean() required?: boolean;
  /** 只在這些場所類型要求;空陣列 = 所有場所 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @NoNulChar('場所類型', { each: true })
  placeTypes?: string[];
}

export class UpdateAppSettingsDto {
  // 這一整包最後都會落進 system_settings id=1 那一列的 jsonb。jsonb 跟 text 一樣
  // 不接受 U+0000,所以每一個字串欄位都擋 NUL,自由形狀的物件用 @NoNulCharDeep。
  @IsOptional() @IsString() @MaxLength(60) @NoNulChar('產品名稱') productName?: string;
  @IsOptional() @IsString() @MaxLength(60) @NoNulChar('標誌文字') logoText?: string;
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('組織名稱') organizationName?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @NoNulChar('組織顯示名稱')
  organizationDisplayName?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('電話') phone?: string;
  @IsOptional() @IsString() @MaxLength(300) @NoNulChar('通訊地址') mailingAddress?: string;

  /** IANA 時區字串,例如 Asia/Taipei */
  @IsOptional() @IsString() @MaxLength(64) @NoNulChar('時區') timezone?: string;
  /** BCP 47 地區,例如 zh-TW */
  @IsOptional() @IsString() @MaxLength(35) @NoNulChar('地區') locale?: string;

  @IsOptional() @IsIn(['A', 'B']) themeScheme?: 'A' | 'B';
  @IsOptional() @IsIn(['dark', 'light']) themeSidebar?: 'dark' | 'light';
  @IsOptional() @IsIn(['light', 'dark', 'system']) themeDefaultMode?: 'light' | 'dark' | 'system';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST_SIZE)
  @ValidateNested({ each: true })
  @Type(() => StageItemDto)
  stages?: StageItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST_SIZE)
  @ValidateNested({ each: true })
  @Type(() => PhotoCheckItemDto)
  photoChecklist?: PhotoCheckItemDto[];

  /**
   * 互動管道、場所類型、商業分類。
   *
   * 這三組與 mapTileUrl 一起漏掉過:後台設定頁存檔送的是整包 AppSettings,
   * 而這裡沒有宣告它們,於是 forbidNonWhitelisted 把整個請求擋成 400
   * (訊息是「property channels should not exist」),後台一格都存不了。
   * service 那一側一直讀得到 view.channels —— 只是永遠讀不到,因為請求根本進不來。
   * 前端送得出來的每一格,這裡都要有一行,對齊由 dto-covers-view.spec.ts 釘住。
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST_SIZE)
  @ValidateNested({ each: true })
  @Type(() => VocabItemDto)
  channels?: VocabItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST_SIZE)
  @ValidateNested({ each: true })
  @Type(() => VocabItemDto)
  premisesTypes?: VocabItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST_SIZE)
  @ValidateNested({ each: true })
  @Type(() => VocabItemDto)
  categories?: VocabItemDto[];

  /**
   * 功能區識別色。內容的合法性(色盤代碼存不存在)由 app-settings.view 的
   * normalizeAreaColors 收斂,這裡只擋型別。
   */
  @IsOptional() @IsObject() @NoNulCharDeep('功能區識別色') areaColors?: Record<string, string>;

  @IsOptional() @IsNumber() @Min(-90) @Max(90) mapDefaultLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) mapDefaultLng?: number;
  @IsOptional() @IsInt() @Min(1) @Max(20) mapDefaultZoom?: number;
  /**
   * 拜訪地圖的圖磚網址樣板。長度與型別擋在這裡,協定與 {z}/{x}/{y} 三個佔位符
   * 由 service 的 assertMapTileUrl 擋;留空 = 用出廠的公共圖磚。
   */
  @IsOptional() @IsString() @MaxLength(500) @NoNulChar('地圖圖磚網址') mapTileUrl?: string;
  @IsOptional() @IsIn(['nominatim', 'none']) geocodeProvider?: 'nominatim' | 'none';
  /**
   * 逗號分隔的兩碼國碼,空字串 = 不限制國家。
   * 這裡只擋型別與長度,實際內容由 normalizeGeocodeCountryCodes 逐段收斂
   * (不是兩個英文字母的段落一律丟掉),所以不合法的字元不會被存進去。
   */
  @IsOptional() @IsString() @MaxLength(200) @NoNulChar('國碼') geocodeCountryCodes?: string;

  /**
   * 明確設定為「不需照片存證」的場所類型代碼。
   * 內容由 normalizePhotoExemptPremises 收斂(只留合法代碼、去重、設上限)。
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @NoNulChar('免拍場所類型', { each: true })
  photoExemptPremises?: string[];

  // ── 外部查詢帶入 ────────────────────────────────────────
  // 網址樣板這一格只擋長度與型別,合不合法(https、不指向內網)由 lookup-url.ts
  // 的 checkLookupUrlTemplate 判斷,存檔時在 service 裡呼叫 ——
  // 那條規則是安全邊界,要有一份完整的測試釘著,不適合塞進裝飾器。
  @IsOptional() @IsBoolean() lookupEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('查詢名稱') lookupLabel?: string;
  @IsOptional()
  @IsString()
  @MaxLength(LOOKUP_URL_TEMPLATE_MAX)
  @NoNulChar('查詢網址樣板')
  lookupUrlTemplate?: string;
  /** 內容由 normalizeLookupFieldMap 收斂(只留 name / address / phone) */
  @IsOptional() @IsObject() @NoNulCharDeep('查詢欄位對照') lookupFieldMap?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(200) @NoNulChar('查詢格式') lookupPattern?: string;
}
