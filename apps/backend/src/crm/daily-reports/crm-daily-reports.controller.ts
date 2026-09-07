/**
 * 日報彙整 API(獨立前綴 admin/crm-daily-reports,避免被 CrmController 的 GET :id 吃掉)。
 * 可用角色同 CRM:業務 / 訪查主管 / admin;業務只看自己的日報,主管與 admin 看全部並可批註/標已讀。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
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
import { CrmDailyReportsService } from './crm-daily-reports.service';
import { ReviewDailyReportDto, SubmitDailyReportDto } from './dto/daily-report.dto';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
// UUID 格式的判準全後端共用一份(見 common/uuid.ts)
import { UUID_RE } from '../../common/uuid';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole, assertCrmManagerRole } from '../crm-roles';

type AuthedRequest = Request & { user: JwtPayload };

@Controller('admin/crm-daily-reports')
@UseGuards(AuthGuard('jwt'))
export class CrmDailyReportsController {
  constructor(
    private readonly svc: CrmDailyReportsService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /** 業務送出(或覆蓋)當日日報 */
  @Post()
  async submit(@Req() req: AuthedRequest, @Body() dto: SubmitDailyReportDto) {
    assertCrmRole(req.user.role);
    return this.svc.submit(req.user.sub, dto);
  }

  /**
   * 今天誰交了、誰還沒(主管/admin)。要放在 :id 之前。
   * 要傳 scope:角色守衛只回答「是不是主管」,不傳的話主管會拿到全公司在職業務名冊。
   */
  @Get('today-status')
  async todayStatus(@Req() req: AuthedRequest) {
    assertCrmManagerRole(req.user.role);
    return this.svc.todayStatus(await this.scopeOf(req));
  }

  /** 列表:業務只看自己;主管/admin 可篩 userId */
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId') userId?: string,
  ) {
    assertCrmRole(req.user.role);
    const view = await this.scopeOf(req);
    // 只有看得到別人的人才能指定 userId;一般業務指定了也一律忽略
    const canFilter = view.viewAll || view.ownerIds.length > 1;
    const filterUser = canFilter && userId && UUID_RE.test(userId) ? userId : undefined;
    return {
      rows: await this.svc.list(req.user.sub, view, {
        from: from || undefined,
        to: to || undefined,
        userId: filterUser,
      }),
    };
  }

  /** 主管批註 / 標已讀。同樣要傳 scope:主管只能批自己團隊的日報 */
  @Patch(':id')
  async review(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReviewDailyReportDto,
  ) {
    assertCrmManagerRole(req.user.role);
    return this.svc.review(id, req.user.sub, await this.scopeOf(req), dto);
  }
}
