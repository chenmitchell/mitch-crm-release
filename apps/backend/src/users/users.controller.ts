import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { UsersService, type UserActor } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { JwtPayload } from '../auth/auth.service';

/**
 * 帳號管理 API。
 *
 * 角色範圍由 service 決定,controller 只負責把「呼叫者是誰」原封不動從 JWT 傳下去
 * (以前傳的是 controller 自己算的 isAdmin 布林,新增角色時很容易在這一行寫死)。
 *   admin          不受限
 *   sales_manager  只看 / 只能動自己團隊的 role=sales 帳號,建立時強制 sales + managerId=自己
 *   其他角色       service 一律 403
 */
@Controller('admin/users')
@UseGuards(AuthGuard('jwt'))
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** 呼叫者身分一律從 JWT 取,不接受 body / query 覆寫 */
  private actor(req: Request & { user: JwtPayload }): UserActor {
    return { sub: req.user.sub, role: req.user.role };
  }

  @Get()
  async list(@Req() req: Request & { user: JwtPayload }) {
    return this.users.list(this.actor(req));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() req: Request & { user: JwtPayload }, @Body() dto: CreateUserDto) {
    return this.users.create(this.actor(req), dto);
  }
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.resetPassword(this.actor(req), id);
  }

  /**
   * 解除登入鎖定。與重設密碼同一類操作(都是「這個人進不來,幫他一把」),
   * 差別在解鎖不動他的密碼。見 users.service 的 unlock。
   */
  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  async unlock(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.unlock(this.actor(req), id);
  }

  /**
   * 停用前的影響評估:名下客戶數、團隊成員數、會不會被硬擋。
   *
   * 為什麼是獨立一支 GET:停用不硬擋(離職是既成事實),但要先講清楚。
   * 前端在跳確認之前先問這一支,把「他名下還有 N 位客戶、底下還有 M 位成員,
   * 停用之後不會自動改派」寫進確認視窗;停用本身的回應也帶同一包,
   * 所以直接打 API 的人也一定看得到,不是只有走畫面的人才看得到。
   */
  @Get(':id/disable-impact')
  async disableImpact(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.disableImpact(this.actor(req), id);
  }

  @Patch(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.setStatus(this.actor(req), id, 'disabled');
  }

  @Patch(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.setStatus(this.actor(req), id, 'active');
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(this.actor(req), id, dto);
  }
}
