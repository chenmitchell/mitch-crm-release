import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SessionUserModule } from './auth/session-user.module';
import { LoginAttemptsModule } from './auth/login-attempts.module';
import { UsersModule } from './users/users.module';
import { InvitesModule } from './invites/invites.module';
import { SettingsModule } from './settings/settings.module';
import { ErrorsModule } from './errors/errors.module';
import { CrmModule } from './crm/crm.module';
import { AppSettingsModule } from './app-settings/app-settings.module';
import { DepartmentsModule } from './departments/departments.module';
import { SetupModule } from './setup/setup.module';
import { LookupModule } from './lookup/lookup.module';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { GlobalExceptionFilter } from './errors/global-exception.filter';
import { AttributionInterceptor } from './common/attribution.interceptor';
import { CrossSiteGuard } from './common/cross-site.guard';
import { JsonDepthMiddleware } from './common/json-depth.middleware';
import { loadEnv } from './common/env';

const env = loadEnv();

/**
 * 健康檢查不計入 rate limit。
 * 反向代理與平台的探針幾秒打一次 /healthz,而且來源就是那一台 proxy,
 * 一旦被算進同一個 IP 桶子,探針自己就會先把額度吃光然後 429,
 * 平台會誤判服務掛掉而重啟。
 * 這兩支只回靜態狀態、不碰資料,放行沒有風險。
 */
const HEALTH_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Rate limiting(OWASP A07 Identification and Authentication Failures)。
 * 原本整個服務沒有任何速率限制:後台登入雖然有失敗鎖定,但憑證類端點
 * 可以無限次嘗試。
 *
 * 預設值刻意寬鬆(每 60 秒 100 次),因為後台一個畫面就會連打十幾支 API;
 * 憑證類端點(/auth/login、邀請連結)再用 @Throttle 個別收緊。
 *
 * 儲存後端是 throttler 內建的記憶體儲存:單一 instance 夠用。
 * 之後若橫向擴充成多個 instance,額度會變成「每個 instance 各一份」,
 * 屆時要換成 Redis storage。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: env.THROTTLE_TTL_SECONDS * 1000, // throttler v6 的 ttl 單位是毫秒
          limit: env.THROTTLE_LIMIT_DEFAULT,
        },
      ],
      // 以「真實客戶端 IP」當計數 key。req.ip 已經由 main.ts 的
      // `app.set('trust proxy', ...)` 換算過,不是 Caddy 的位址。
      // 保留 socket fallback:trust proxy 設定異常時 req.ip 可能是 undefined,
      // 那會讓所有人共用 'undefined' 這個 key,等於全站互相拖累。
      getTracker: (req: Record<string, unknown>) => {
        const r = req as unknown as Request;
        return r.ip ?? r.socket?.remoteAddress ?? 'unknown';
      },
      skipIf: (context: ExecutionContext) => {
        if (context.getType() !== 'http') return false;
        const req = context.switchToHttp().getRequest<Request>();
        return HEALTH_PATHS.has(req.path);
      },
    }),
    PrismaModule,
    ErrorsModule,
    // 授權時回查帳號狀態用的全域服務。要在 AuthModule 之前,
    // 因為 JwtStrategy 是它的消費者(@Global 與註冊順序無關,擺前面只是好讀)
    SessionUserModule,
    // 登入失敗鎖定的計數(帳號 + 來源 IP)。同樣是行程內狀態,同樣要全域單一實例:
    // 登入寫入、使用者管理的解鎖與重設密碼清除,見 auth/login-attempts.service.ts
    LoginAttemptsModule,
    AuthModule,
    UsersModule,
    InvitesModule,
    SettingsModule,
    AppSettingsModule,
    DepartmentsModule,
    SetupModule,
    LookupModule,
    CrmModule,
  ],
  controllers: [HealthController],
  providers: [
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      // 跨站請求守衛。擺在 rate limit 之前:被判定成跨站的請求連額度都不該吃到。
      // 為什麼需要它(以及它擋不到什麼),見 common/cross-site.guard.ts 的檔頭
      provide: APP_GUARD,
      useClass: CrossSiteGuard,
    },
    {
      // 全域 rate limit guard。個別端點用 @Throttle / @SkipThrottle 覆寫。
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AttributionInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * 請求本體的巢狀深度檢查掛成全域中介層。
   *
   * 為什麼是中介層而不是 pipe:會爆堆疊的是 ValidationPipe 裡的 class-transformer,
   * 檢查必須跑在它之前。中介層的位置(body-parser 之後、守衛與 pipe 之前)剛好是
   * 唯一同時滿足「body 已經解析好」與「還沒開始深拷貝」的接縫。
   * 見 common/json-depth.ts 的說明。
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(JsonDepthMiddleware).forRoutes('*');
  }
}
