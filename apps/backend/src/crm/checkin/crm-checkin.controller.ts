/**
 * 拜訪打卡存證 API(獨立前綴 admin/crm-checkin,避免被 CrmController 的 GET :id 吃掉)。
 * 可用角色同 CRM:業務 / 訪查主管 / admin;業務只能對自己的客戶打卡,主管與 admin 看全部。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 *
 * 可見範圍由 AccessScopeService 一處算出來(業務看自己、訪查主管看自己團隊與部門子樹、
 * 系統管理員看全部),各 service 依 ViewScope 組 where,見 ../../scope/view-scope.ts。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CrmCheckinService } from './crm-checkin.service';
import { AddPhotosDto, CheckinDto } from './dto/checkin.dto';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole } from '../crm-roles';

type AuthedRequest = Request & { user: JwtPayload };

const RECENT_DAYS_DEFAULT = 7;
const RECENT_DAYS_MAX = 90;
/** 上傳類端點(打卡 / 補拍)比全域預設更緊:每 IP 每分鐘 10 次,因為 body 帶多張 base64 照片 */
const UPLOAD_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('admin/crm-checkin')
@UseGuards(AuthGuard('jwt'))
export class CrmCheckinController {
  constructor(
    private readonly svc: CrmCheckinService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /** 最近 N 天的 visit 互動(要放在 :customerId 之前,雖然 method 不同,仍避免路徑歧義) */
  @Get('recent')
  async recent(@Req() req: AuthedRequest, @Query('days') days?: string) {
    assertCrmRole(req.user.role);
    const n = Number.parseInt(days ?? '', 10);
    const safeDays =
      Number.isFinite(n) && n > 0 ? Math.min(n, RECENT_DAYS_MAX) : RECENT_DAYS_DEFAULT;
    return { rows: await this.svc.recent(req.user.sub, await this.scopeOf(req), safeDays) };
  }

  /** 回圖片 bytes(用照片 id);private no-store,inline,nosniff */
  @Get('photo/:photoId')
  async photo(
    @Req() req: AuthedRequest,
    @Param('photoId', new ParseUUIDPipe()) photoId: string,
    @Res() res: Response,
  ) {
    assertCrmRole(req.user.role);
    const { mime, bytes } = await this.svc.getPhoto(photoId, req.user.sub, await this.scopeOf(req));
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).end(bytes);
  }

  /** 刪照片:記錄者本人或主管 / admin,且客戶未結案(stage=converted 或已有 externalCaseRef 都擋) */
  @Delete('photo/:photoId')
  async deletePhoto(
    @Req() req: AuthedRequest,
    @Param('photoId', new ParseUUIDPipe()) photoId: string,
  ) {
    assertCrmRole(req.user.role);
    return this.svc.deletePhoto(photoId, req.user.sub, await this.scopeOf(req));
  }

  /** 客戶存證照片清單 + 依場所類型的必備 / 缺少 */
  @Get(':customerId/photos')
  async listPhotos(
    @Req() req: AuthedRequest,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ) {
    assertCrmRole(req.user.role);
    return this.svc.listPhotos(customerId, req.user.sub, await this.scopeOf(req));
  }

  /** 純補拍(不算打卡) */
  @Post(':customerId/photos')
  @Throttle(UPLOAD_THROTTLE)
  async addPhotos(
    @Req() req: AuthedRequest,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() dto: AddPhotosDto,
  ) {
    assertCrmRole(req.user.role);
    return this.svc.addPhotos(customerId, req.user.sub, await this.scopeOf(req), dto);
  }

  /** 打卡(可夾照片) */
  @Post(':customerId')
  @Throttle(UPLOAD_THROTTLE)
  async checkin(
    @Req() req: AuthedRequest,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() dto: CheckinDto,
  ) {
    assertCrmRole(req.user.role);
    return this.svc.checkin(customerId, req.user.sub, await this.scopeOf(req), dto);
  }
}
