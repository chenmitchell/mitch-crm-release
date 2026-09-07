import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizeEmail } from '../../common/email';

// 密碼不掛 @NoNulChar:不會被寫進資料庫(規則見 ../../common/no-control-chars.ts)
export class LoginDto {
  /**
   * 大小寫與夾帶的空白在驗證之前就正規化(見 common/email.ts)。
   * 沒有這一步的話,登入是大小寫敏感的:管理員建的 `Alice@Example.com`
   * 用 `alice@example.com` 登入永遠失敗,而回的訊息跟密碼打錯完全一樣。
   * service 那一層也有一次 normalizeEmail —— 不是重複,那一層擋的是
   * 繞過 DTO 的呼叫端(單元測試、日後新增的內部呼叫)。
   */
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'email 格式錯誤' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1, { message: '密碼必填' })
  @MaxLength(256)
  password!: string;
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
