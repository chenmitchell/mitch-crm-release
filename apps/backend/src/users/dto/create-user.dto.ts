import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ASSIGNABLE_ROLES, type AssignableRole } from './update-user.dto';
import { normalizeEmail } from '../../common/email';
import { NoNulChar } from '../../common/no-control-chars';

export class CreateUserDto {
  /**
   * 一律轉小寫並去掉夾帶的空白(見 common/email.ts)。
   *
   * users.email 是區分大小寫的唯一索引,所以沒有這一步的話,同一個人可以被建成
   * `Alice@Example.com` 與 `alice@example.com` 兩個帳號,而且大小寫混雜的那一個
   * SSO 對帳時找不到 —— 開了自動建帳號的話,停用之後走 Microsoft 登入
   * 會再拿到一個全新的可用帳號。
   */
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'email 格式錯誤' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1, { message: '姓名不可為空' })
  @MaxLength(100)
  @NoNulChar('姓名')
  name!: string;

  // 可指派的角色清單只有一份,在 update-user.dto.ts。兩邊各寫一份的話,
  // 建立擋得住的角色會從編輯那一支溜進去。
  @IsIn(ASSIGNABLE_ROLES, { message: '角色必須是 admin、sales 或 sales_manager 其中之一' })
  role!: AssignableRole;

  // 訪查人員的聯絡資料。每一格都會寫進 users,所以都擋 NUL
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('電話') phone?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('手機') mobile?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('職稱') title?: string;
  @IsOptional() @IsString() @MaxLength(20) @NoNulChar('分機') extension?: string;
  // 部門名稱(自由輸入,相容既有資料與目錄同步)
  @IsOptional() @IsString() @MaxLength(100) @NoNulChar('部門') department?: string;
  // 組織部門(departments 表)。決定訪查主管的可見範圍,只有 admin 送得動。
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4', { message: '所屬部門必須是有效的部門 id' })
  departmentId?: string | null;
  // 所屬訪查主管。只有 admin 送得動 —— 訪查主管建帳號時後端一律覆寫成他自己,
  // 前端傳什麼都不採用(見 users.service.create)。
  @IsOptional() @IsUUID('4', { message: '所屬主管必須是有效的使用者 id' }) managerId?:
    string | null;
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
