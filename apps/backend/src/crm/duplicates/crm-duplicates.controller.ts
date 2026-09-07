/**
 * 客戶查重合併 API(獨立前綴 admin/crm-duplicates,避免被 CrmController 的 GET :id 吃掉)。
 * 角色:admin / sales / sales_manager 可用;可見範圍由 AccessScopeService 決定,
 * 合併時兩筆都必須在範圍內(見 CrmDuplicatesService.mergeOnce)。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { CrmDuplicatesService } from './crm-duplicates.service';
import {
  CheckDuplicateQueryDto,
  DuplicateGroupsQueryDto,
  MergeDuplicateDto,
} from './crm-duplicates.dto';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole } from '../crm-roles';

@Controller('admin/crm-duplicates')
@UseGuards(AuthGuard('jwt'))
export class CrmDuplicatesController {
  constructor(
    private readonly dupes: CrmDuplicatesService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /**
   * 疑似重複群組。
   *
   * 收得下負責人與階段兩個篩選條件:比對有掃描上限(DUPLICATE_SCAN_LIMIT),
   * 而超過上限時服務會回一句「請縮小範圍」—— 這一支原本一個 query 參數都不收,
   * 那句話等於叫使用者做一件做不到的事,五萬筆的部署每次打開查重都只拿得到那一句。
   * 篩選條件不會放寬可見範圍:ownerId 要通過 canSeeOwner 才算數(見 service)。
   */
  @Get()
  async groups(@Req() req: Request & { user: JwtPayload }, @Query() q: DuplicateGroupsQueryDto) {
    assertCrmRole(req.user.role);
    return this.dupes.groups(req.user.sub, await this.scopeOf(req), {
      ownerId: q.ownerId,
      stage: q.stage,
    });
  }

  @Get('check')
  async check(@Req() req: Request & { user: JwtPayload }, @Query() q: CheckDuplicateQueryDto) {
    assertCrmRole(req.user.role);
    return this.dupes.check(req.user.sub, await this.scopeOf(req), q);
  }

  // 合併:兩筆都必須在呼叫者的可見範圍內(service 內檢查)
  @Post('merge')
  async merge(@Req() req: Request & { user: JwtPayload }, @Body() dto: MergeDuplicateDto) {
    assertCrmRole(req.user.role);
    return this.dupes.merge(dto.keepId, dto.mergeId, req.user.sub, await this.scopeOf(req));
  }
}
