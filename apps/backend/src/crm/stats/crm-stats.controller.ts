/**
 * 主管戰情圖表 API(獨立前綴 admin/crm-stats,避免被 CrmController 的 GET :id 吃掉)。
 * 只有訪查主管與 admin 可用,其餘角色一律 403。
 *
 * 角色擋掉之後還要限縮可見範圍:訪查主管看的是自己團隊,不是全公司。
 * 兩支都把 AccessScopeService 算出來的 ViewScope 傳下去,口徑見 ../../scope/view-scope.ts。
 *
 * - GET by-sales?range=week|month|quarter  各業務戰情 + 貢獻度分級(range 不合法時當 week)
 * - GET funnel                              各階段目前筆數
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { CrmStatsService } from './crm-stats.service';
import { AccessScopeService } from '../../scope/access-scope.service';
import type { JwtPayload } from '../../auth/auth.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmManagerRole } from '../crm-roles';

@Controller('admin/crm-stats')
@UseGuards(AuthGuard('jwt'))
export class CrmStatsController {
  constructor(
    private readonly stats: CrmStatsService,
    private readonly access: AccessScopeService,
  ) {}

  /** 可見範圍一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: Request & { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  @Get('by-sales')
  async bySales(@Req() req: Request & { user: JwtPayload }, @Query('range') range?: string) {
    assertCrmManagerRole(req.user.role);
    return this.stats.bySales(this.stats.normalizeRange(range), await this.scopeOf(req));
  }

  @Get('funnel')
  async funnel(@Req() req: Request & { user: JwtPayload }) {
    assertCrmManagerRole(req.user.role);
    return this.stats.funnel(await this.scopeOf(req));
  }
}
