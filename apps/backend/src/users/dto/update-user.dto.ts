import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { NoNulChar } from '../../common/no-control-chars';

/**
 * 可以指派的登入角色。
 *
 * 這一份跟 prisma schema 的 UserRole 一字不差,是刻意的:列舉曾經多出三個前身系統
 * 留下來的產業角色,而這一份白名單把它們擋在門外。擋得住不代表該留著 ——
 * 資料庫列舉裡放三個這套產品沒有任何功能對應的值,只會讓讀 schema 的人以為
 * 有對應的權限模型。0.1.0 把它們從列舉刪掉了,兩邊因此對齊。
 *
 * 白名單本身留著:role 是從 JSON 進來的字串,沒有這一層就會靠資料庫的列舉去擋,
 * 而那會變成 500 而不是 400。
 * 要新增角色的話,「四處」是不夠的,而且型別檢查一處都抓不到 —— 底下這些地方
 * 比對的都是字串常值,不是 UserRole 列舉,少改一處只會在執行期變成
 * 「有些頁面進得去、有些回 403」:
 *
 *   apps/backend/prisma/schema.prisma            UserRole 列舉
 *   apps/backend/src/users/dto/update-user.dto.ts ASSIGNABLE_ROLES(這一份)
 *   apps/backend/src/crm/crm-roles.ts             CRM_ROLES / CRM_MANAGER_ROLES
 *   apps/backend/src/scope/access-scope.service.ts resolve() 的角色分支
 *   apps/backend/src/users/users.service.ts        isAdmin / isManager 與角色變更規則
 *   apps/backend/src/invites/invites.service.ts    INVITER_ROLES 與 assertManager
 *   apps/frontend/src/lib/roles.ts                 UserRole 型別、標籤、下拉選項
 *   apps/frontend/src/lib/crm-shared.ts            canUseCrm / isViewAllRole
 *   apps/frontend/src/app/admin/layout.tsx         每一條選單的 roles
 *   apps/frontend/src/app/login/page.tsx           登入後的落點
 *   apps/frontend/src/app/admin/page.tsx           /admin 的轉址落點
 *
 * 會紅的只有 assignable-roles.spec.ts 裡「只剩 admin / sales / sales_manager」
 * 那一行;把它改掉之後,上面漏掉的任何一處都不會再有第二道關卡。
 */
export const ASSIGNABLE_ROLES = ['admin', 'sales', 'sales_manager'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * 更新使用者資料(姓名 + 聯絡資料 + 角色 + 組織歸屬)
 * email 不開放在這邊改 — 改 email 要動 audit log。
 * role 只有系統管理員能改,而且服務層會擋掉會造成資料孤兒的變更(見 users.service 的 update)。
 */
export class UpdateUserDto {
  // 每一格都會寫進 users,所以都擋 NUL(理由見 common/no-control-chars.ts)
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) @NoNulChar('姓名') name?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('電話') phone?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('手機') mobile?: string;
  @IsOptional() @IsString() @MaxLength(40) @NoNulChar('職稱') title?: string;
  @IsOptional() @IsString() @MaxLength(20) @NoNulChar('分機') extension?: string;
  // 登入角色。只有 admin 可以改。
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES, { message: '角色不正確' })
  role?: AssignableRole;
  // 所屬訪查主管(團隊歸屬)。只有 admin 可以改;null = 拿掉歸屬。
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4', { message: '所屬主管必須是有效的使用者 id' })
  managerId?: string | null;
  // 組織部門(departments 表)。只有 admin 可以改;null = 拿掉歸屬。
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4', { message: '所屬部門必須是有效的部門 id' })
  departmentId?: string | null;
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
