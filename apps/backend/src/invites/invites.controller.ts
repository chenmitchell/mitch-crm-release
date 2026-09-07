/**
 * 業務邀請 API,兩支 controller:
 *   - InvitesAdminController(admin/crm-invites,需 JWT,訪查主管 / admin):產、列、撤銷
 *   - InvitesPublicController(invites,公開):查連結、用連結建帳號
 *
 * 路徑前綴刻意跟 admin/crm 分開:CrmController 有 `GET :id`,掛在底下會被吃掉。
 * 公開那兩支照專案既有做法用 @nestjs/throttler 依 IP 限流(見 customer.controller.ts)。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { InvitesService } from './invites.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import type { JwtPayload } from '../auth/auth.service';

type AuthedRequest = Request & { user: JwtPayload };

/**
 * 公開端點的每 IP 額度(覆寫全域 default 的每分鐘 100 次)。
 * 查詢 20/分:正常人開一次頁面打一次,20 次已經很寬鬆,但足以擋掉純暴力猜 token。
 * 建帳號 10/分:一個人只會成功一次,不需要更多。
 */
const CHECK_THROTTLE = { default: { limit: 20, ttl: 60_000 } };
const ACCEPT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('admin/crm-invites')
@UseGuards(AuthGuard('jwt'))
export class InvitesAdminController {
  constructor(private readonly invites: InvitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: AuthedRequest) {
    return this.invites.create(req.user.sub, req.user.role);
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.invites.listMine(req.user.sub, req.user.role);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async revoke(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.invites.revoke(req.user.sub, req.user.role, id);
  }
}

@Controller('invites')
export class InvitesPublicController {
  constructor(private readonly invites: InvitesService) {}

  // 無效 token 也回 200 + valid:false(不是 404):讓猜 token 的人拿不到區分訊號
  @Throttle(CHECK_THROTTLE)
  @Get(':token')
  async check(@Param('token') token: string) {
    return this.invites.check(token);
  }

  @Throttle(ACCEPT_THROTTLE)
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  async accept(@Param('token') token: string, @Body() dto: AcceptInviteDto) {
    return this.invites.accept(token, dto);
  }
}
