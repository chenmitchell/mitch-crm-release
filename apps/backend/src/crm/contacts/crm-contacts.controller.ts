/**
 * 「我聯絡過的客戶」API(獨立前綴 admin/crm-contacts,避免被 CrmController 的 GET :id 吃掉)。
 * 可用角色同 CRM:業務 / 訪查主管 / admin;業務只看自己 ownerId 的客戶,主管與 admin 看全部。
 *
 * - GET /api/admin/crm-contacts?days=30&limit=100
 *   回 { days, rows: [{ customerId, companyName, taxId, stage, ownerName,
 *        lastChannel, lastAt, lastNote, nextAction, nextFollowUpAt }] },依 lastAt 由新到舊
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 *
 * 可見範圍由 AccessScopeService 一處算出來(業務看自己、訪查主管看自己團隊與部門子樹、
 * 系統管理員看全部),各 service 依 ViewScope 組 where,見 ../../scope/view-scope.ts。
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { CrmContactsService } from './crm-contacts.service';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole } from '../crm-roles';

@Controller('admin/crm-contacts')
@UseGuards(AuthGuard('jwt'))
export class CrmContactsController {
  constructor(
    private readonly svc: CrmContactsService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  @Get()
  async list(
    @Req() req: Request & { user: JwtPayload },
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    assertCrmRole(req.user.role);
    return this.svc.list(req.user.sub, await this.scopeOf(req), { days, limit });
  }
}
