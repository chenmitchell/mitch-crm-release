import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { MustChangePasswordGuard } from './must-change-password.guard';
import { SessionRefreshInterceptor } from './session-refresh.interceptor';
import { EntraController } from './entra.controller';
import { EntraService } from './entra.service';
import { EntraAdminController } from './entra-admin.controller';
import { EntraConfigService } from './entra-config.service';
import { EntraAuditService } from './entra-audit.service';
import { GraphProfileService } from './graph-profile.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionUserModule } from './session-user.module';
import { SettingsModule } from '../settings/settings.module';
import { loadEnv } from '../common/env';

const env = loadEnv();

@Module({
  imports: [
    PrismaModule,
    // JwtStrategy 每個請求回查一次帳號狀態(停用 / 降級 / 改密碼要立刻生效)
    SessionUserModule,
    // SSO 政策設定(允許網域 / 自動建帳號)存在 system_settings id=3,
    // 由 SettingsService 讀寫。SettingsModule 只依賴 PrismaModule,不會循環。
    SettingsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      secret: env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: env.JWT_ACCESS_TTL },
    }),
  ],
  // EntraController 放在 AuthController 後面:兩者路徑不重疊
  // (auth/login vs auth/entra/*),但順序固定比較好追
  // EntraAdminController 掛的是 admin/sso/*,給後台「單一登入設定」頁用
  controllers: [AuthController, EntraController, EntraAdminController],
  providers: [
    AuthService,
    JwtStrategy,
    /**
     * 滑動續期。掛成全域攔截器(APP_INTERCEPTOR 寫在哪個模組都是全域),
     * 放在 AuthModule 是因為它要 JwtService,而 JwtModule 註冊在這裡。
     * 掛在 controller 上的話,日後新增的模組會安靜地漏掉續期,
     * 症狀是「某幾頁待久了會被登出、某幾頁不會」。
     */
    { provide: APP_INTERCEPTOR, useClass: SessionRefreshInterceptor },
    /**
     * 「首次登入必須改密碼」的把關。註冊成全域守衛(APP_GUARD 寫在哪個模組都是全域),
     * 放在 AuthModule 是因為它要 JwtService,而 JwtModule 註冊在這裡 ——
     * 跟上面那個攔截器完全一樣的理由。
     * 掛在個別 controller 上的話,日後新增的模組會安靜地漏掉,
     * 而漏掉的症狀是「臨時密碼永久有效」,從畫面上完全看不出來。
     */
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    EntraService,
    EntraConfigService,
    EntraAuditService,
    // Microsoft Graph 的組織資料讀取器(職稱 / 部門 / 電話,見 graph-profile.service.ts)
    GraphProfileService,
  ],
  exports: [AuthService, EntraService, EntraConfigService],
})
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
export class AuthModule {}
