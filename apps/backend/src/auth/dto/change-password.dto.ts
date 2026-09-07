import { IsString, MinLength, MaxLength } from 'class-validator';
// 長度規則全系統一份(見 packages/shared/src/password.ts):
// 這裡、邀請註冊、安裝精靈以前各寫一個數字,設定新密碼的規則因此形同虛設。
import { PASSWORD_MIN } from '@mitchcrm/shared';

// 密碼不掛 @NoNulChar:存進資料庫的是 argon2 雜湊,不是原文(規則見 ../../common/no-control-chars.ts)
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN, { message: `新密碼至少 ${PASSWORD_MIN} 字元` })
  @MaxLength(256)
  newPassword!: string;
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
