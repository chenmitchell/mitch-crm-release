/**
 * 業務拜訪地圖 API(獨立前綴 admin/crm-map,避免被 CrmController 的 GET :id 吃掉)。
 * 可用角色與 CRM 相同:業務 / 訪查主管 / admin;業務只拿得到自己 ownerId 的客戶。
 *
 * - GET  customers?lat=&lng=&scope=today|all  附近客戶(依距離排序)+ 待地理編碼數
 * - POST geocode                               對待編碼客戶做地理編碼(每次最多 10 筆,每人 30 秒一次)
 * - POST route                                 最近鄰拜訪順序(純計算)
 * - GET  reverse?lat=&lng=                     反查路名(Nominatim /reverse,結果快取 10 分鐘;每人 2 秒一次)
 *                                              回 { road, district, city, display },查不到四個都是 null,不回外部錯誤
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { CrmGeoService } from './crm-geo.service';
import { MapCustomersQueryDto, ReverseQueryDto, RouteBodyDto } from './crm-map.dto';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole } from '../crm-roles';

/**
 * 每位使用者兩次地理編碼之間的最短間隔(記憶體 Map,重啟即清空)。
 * 單一實例前提:這個 Map 只存在本程序記憶體,橫向擴充成多個 instance 時每個 instance 各算各的,
 * 額度會變成 N 倍;屆時要跟 app.module.ts 的 ThrottlerModule 一起改成共用儲存(例如 Redis)。
 */
const GEOCODE_PER_USER_INTERVAL_MS = 30_000;
const GEOCODE_MAP_SWEEP_SIZE = 1000;
/** 反查路名:每位使用者兩次之間最短間隔(同一座標命中快取的不算) */
const REVERSE_PER_USER_INTERVAL_MS = 2_000;

@Controller('admin/crm-map')
@UseGuards(AuthGuard('jwt'))
export class CrmMapController {
  private readonly lastGeocodeAt = new Map<string, number>();
  private readonly lastReverseAt = new Map<string, number>();

  constructor(
    private readonly geo: CrmGeoService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  private assertGeocodeInterval(userId: string) {
    const now = Date.now();
    const last = this.lastGeocodeAt.get(userId);
    if (last !== undefined && now - last < GEOCODE_PER_USER_INTERVAL_MS) {
      const waitS = Math.ceil((GEOCODE_PER_USER_INTERVAL_MS - (now - last)) / 1000);
      throw new HttpException(`地理編碼請稍候 ${waitS} 秒後再試`, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastGeocodeAt.set(userId, now);
    if (this.lastGeocodeAt.size > GEOCODE_MAP_SWEEP_SIZE) {
      for (const [k, t] of this.lastGeocodeAt) {
        if (now - t >= GEOCODE_PER_USER_INTERVAL_MS) this.lastGeocodeAt.delete(k);
      }
    }
  }

  private assertReverseInterval(userId: string) {
    const now = Date.now();
    const last = this.lastReverseAt.get(userId);
    if (last !== undefined && now - last < REVERSE_PER_USER_INTERVAL_MS) {
      throw new HttpException('反查路名太頻繁,請稍候再試', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastReverseAt.set(userId, now);
    if (this.lastReverseAt.size > GEOCODE_MAP_SWEEP_SIZE) {
      for (const [k, t] of this.lastReverseAt) {
        if (now - t >= REVERSE_PER_USER_INTERVAL_MS) this.lastReverseAt.delete(k);
      }
    }
  }

  @Get('customers')
  async customers(@Req() req: Request & { user: JwtPayload }, @Query() q: MapCustomersQueryDto) {
    assertCrmRole(req.user.role);
    const out = await this.geo.customers(req.user.sub, await this.scopeOf(req), {
      lat: q.lat,
      lng: q.lng,
      scope: q.scope ?? 'all',
    });
    // 把「一次幾筆」與「兩次之間要等多久」一起回給畫面。
    // 少了這兩個數字,畫面只能說「還有 1980 筆」,說不出「大概還要按 198 次、跨 99 分鐘」,
    // 而那正是使用者按了三次之後最想知道的事。前端不能寫死,這兩個上限只有後端知道。
    return { ...out, geocodeIntervalMs: GEOCODE_PER_USER_INTERVAL_MS };
  }

  /**
   * 補齊地址座標。
   * retry=1 表示使用者明確要求重試(清掉失敗退避)。外部服務暫時不通時,不給這個出口
   * 就只能等 24 小時,而且畫面會看起來像功能沒做。
   */
  @Post('geocode')
  @HttpCode(HttpStatus.OK)
  async geocode(@Req() req: Request & { user: JwtPayload }, @Query('retry') retry?: string) {
    assertCrmRole(req.user.role);
    this.assertGeocodeInterval(req.user.sub);
    const out = await this.geo.geocodePending(req.user.sub, await this.scopeOf(req), retry === '1');
    return { ...out, geocodeIntervalMs: GEOCODE_PER_USER_INTERVAL_MS };
  }

  @Get('reverse')
  async reverse(@Req() req: Request & { user: JwtPayload }, @Query() q: ReverseQueryDto) {
    assertCrmRole(req.user.role);
    this.assertReverseInterval(req.user.sub);
    return this.geo.reverseGeocode(q.lat, q.lng);
  }

  @Post('route')
  @HttpCode(HttpStatus.OK)
  async route(@Req() req: Request & { user: JwtPayload }, @Body() body: RouteBodyDto) {
    assertCrmRole(req.user.role);
    return this.geo.route(
      req.user.sub,
      await this.scopeOf(req),
      { lat: body.lat, lng: body.lng },
      body.ids,
    );
  }
}
