/**
 * 公開的邀請接受表單。長度上限一律明寫 —— 這支不需要登入,是外部輸入的入口。
 * 密碼長度規則來自 packages/shared/src/password.ts(全系統一份),實際檢查在 service,
 * 因為錯誤訊息要跟其他失敗原因講同一句(避免透露是哪一項不合格)。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NoNulChar } from '../../common/no-control-chars';

export class AcceptInviteDto {
  // name / mobile 會寫進 users;擋 NUL(密碼不用,存進去的是 argon2 雜湊不是原文)
  @IsString()
  @MinLength(1, { message: '姓名不可為空' })
  @MaxLength(100)
  @NoNulChar('姓名')
  name!: string;

  @IsEmail({}, { message: 'email 格式錯誤' })
  @MaxLength(254)
  email!: string;

  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('手機') mobile?: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}
