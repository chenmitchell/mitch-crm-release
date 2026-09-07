/**
 * 拜訪排程 API(獨立前綴 admin/crm-visit-plans,避免被 CrmController 的 GET :id 吃掉)。
 * 可用角色同 CRM:業務 / 訪查主管 / admin;業務只能排自己的客戶,主管與 admin 可排任何客戶
 * (排程的 ownerId 一律用客戶的 ownerId)。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 *
 * 可見範圍由 AccessScopeService 一處算出來(業務看自己、訪查主管看自己團隊與部門子樹、
 * 系統管理員看全部),各 service 依 ViewScope 組 where,見 ../../scope/view-scope.ts。
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { CrmVisitPlansService } from './crm-visit-plans.service';
import { BulkVisitPlanDto, CreateVisitPlanDto, UpdateVisitPlanDto } from './dto/visit-plan.dto';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole } from '../crm-roles';

type AuthedRequest = Request & { user: JwtPayload };

@Controller('admin/crm-visit-plans')
@UseGuards(AuthGuard('jwt'))
export class CrmVisitPlansController {
  constructor(
    private readonly svc: CrmVisitPlansService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /** 區間內的排程;業務只回自己的,主管 / admin 可用 ownerId 篩 */
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('ownerId') ownerId?: string,
    @Query('customerId') customerId?: string,
  ) {
    assertCrmRole(req.user.role);
    const view = await this.scopeOf(req);
    return {
      rows: await this.svc.list(req.user.sub, view, {
        from,
        to,
        // 篩某一位業務由 service 再驗一次在不在可見範圍內,controller 不自行放行
        ownerId,
        customerId,
      }),
    };
  }

  /** 建立或覆蓋一筆排程(同客戶同天) */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() dto: CreateVisitPlanDto) {
    assertCrmRole(req.user.role);
    return this.svc.upsert(req.user.sub, await this.scopeOf(req), dto);
  }

  /** 一次排多天(例如連續一週) */
  @Post('bulk')
  async bulk(@Req() req: AuthedRequest, @Body() dto: BulkVisitPlanDto) {
    assertCrmRole(req.user.role);
    return this.svc.bulk(req.user.sub, await this.scopeOf(req), dto);
  }

  /** 取消排程(只有 planned 可取消) */
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateVisitPlanDto,
  ) {
    assertCrmRole(req.user.role);
    void dto.status; // DTO 已限定只能是 cancelled
    return this.svc.cancel(id, req.user.sub, await this.scopeOf(req));
  }
}
