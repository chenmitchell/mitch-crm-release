import {
  Body,
  Controller,
  Get,
  Post,
  Res,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { loadEnv, isEntraConfigured } from '../common/env';
// cookie 的名字與屬性只有一份定義:登入、登出與滑動續期共用,
// 屬性各寫一份的話續期會寫出「瀏覽器當成另一個」的 cookie,見 session-cookie.ts
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  clearSessionCookieOptions,
} from './session-cookie';

const env = loadEnv();

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * 登入頁開場先問一次:這台後端開了哪些登入方式
   *
   * 不做這支的話,前端只能寫死「顯示 Microsoft 按鈕」,
   * 那 IT 還沒填 env var 的期間,使用者會按到一顆一定失敗的按鈕。
   */
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  @Get('providers')
  providers() {
    return {
      password: true,
      microsoft: isEntraConfigured(),
      microsoftStartUrl: isEntraConfigured() ? '/api/auth/entra/start' : null,
    };
  }

  /**
   * 🔒 密碼猜測的正面入口,套嚴格 rate limit(預設每 60 秒 10 次)。
   *
   * 現有的登入失敗鎖定是「鎖帳號」,擋的是針對單一帳號的猜密碼;
   * 這裡的 rate limit 是「鎖來源 IP」,補的是另一面:
   * 拿一組常見密碼去掃過所有帳號(password spraying),
   * 每個帳號各試一兩次,失敗次數永遠碰不到帳號鎖定門檻。
   */
  @Throttle({
    default: {
      limit: env.THROTTLE_LIMIT_STRICT,
      ttl: env.THROTTLE_TTL_SECONDS * 1000,
    },
  })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Req() req: Request,
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // 來源 IP 是登入失敗鎖定的一半 key(另一半是帳號),見 auth/login-attempts.service.ts。
    // req.ip 已經由 main.ts 的 trust proxy 換算成真實客戶端位址;
    // 取不到就退回 socket 位址,再取不到就空字串(所有來源共用一個桶子,從嚴)。
    const ip = req.ip ?? req.socket?.remoteAddress ?? '';
    const result = await this.auth.login(dto.email, dto.password, ip);
    res.cookie(SESSION_COOKIE_NAME, result.accessToken, sessionCookieOptions());
    return { user: result.user };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Res({ passthrough: true }) res: Response) {
    // 清除時的屬性必須跟寫入時一模一樣,否則跨網域部署(COOKIE_SAMESITE=none)
    // 的瀏覽器會拒收這個 Set-Cookie,畫面顯示已登出而 cookie 還在。
    // 理由寫在 session-cookie.ts 的 clearSessionCookieOptions 上面。
    res.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions());
    return { ok: true };
  }

  /**
   * 🔒 這一支也是憑證端點,套跟登入同一組嚴格額度。
   *
   * 原本只吃全域的每分鐘 100 次,而每一次呼叫都是一次 argon2.verify(目前密碼)——
   * 那是刻意設計成很慢、很吃記憶體的運算。一個登入中的帳號(包含被盜的那一個)
   * 用一支迴圈打滿全域額度,就是每分鐘一百次 argon2 壓在同一台後端上;
   * 同時它也是「猜目前密碼」的另一個入口,而這條路徑沒有帳號鎖定。
   * 正常人一分鐘不會改十次密碼,收緊沒有代價。
   */
  @Throttle({
    default: {
      limit: env.THROTTLE_LIMIT_STRICT,
      ttl: env.THROTTLE_TTL_SECONDS * 1000,
    },
  })
  @UseGuards(AuthGuard('jwt'))
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  async changePassword(
    @Req() req: Request & { user: { sub: string } },
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.changePassword(
      req.user.sub,
      dto.currentPassword,
      dto.newPassword,
    );
    // 換密碼會把「換之前簽出去的權杖」全部作廢(見 session-user.service.ts),
    // 包含使用者手上這一份。當場換上新的那一份,人不會被自己剛做的事踢出去,
    // 但別的裝置上那些舊 cookie 一樣立刻失效 —— 這正是重點。
    res.cookie(SESSION_COOKIE_NAME, result.accessToken, sessionCookieOptions());
    return { ok: result.ok };
  }

  /**
   * 「我是誰」。整站只有這一支:前端的 MeProvider(見 lib/me-context)打的就是它,
   * 而它同時是滑動續期的觸發點 —— 見 session-refresh.interceptor 與 cross-site.guard
   * 的說明,那兩支都是照 POST 這一個動詞寫的。
   *
   * 曾經還有一支同路徑的 GET,回的是沒有 user 外包的另一種形狀。前端從來沒有打過它
   * (MeProvider 一開始就是 POST),留著等於多一個沒有人測、沒有人看的登入者資料出口,
   * 所以拿掉。要再加回來的話,續期與 cross-site 那兩處要一起想。
   */
  @UseGuards(AuthGuard('jwt'))
  @Post('me')
  @HttpCode(HttpStatus.OK)
  async mePost(@Req() req: Request & { user: { sub: string } }) {
    // 從 DB 撈,回真實姓名(JWT 裡沒有 name);前端讀 d.user
    const profile = await this.auth.getProfile(req.user.sub);
    return { user: profile ?? { sub: req.user.sub } };
  }
}
