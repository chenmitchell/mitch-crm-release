import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { OrgTimeService } from './org-time.service';
import { PublicSettingsController } from './public-settings.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  // 這個模組只剩一支 controller:免登入的 PublicSettingsController,只回
  // getPublicDisplay() 那三個展示欄位。
  //
  // 曾經還有一支 SettingsController(GET / PATCH /api/admin/settings),收的是
  // system_settings 的資料庫欄位名。前端從來沒有打過它 —— 設定頁只打
  // /api/admin/app-settings,那一支收的是畫面上的欄位名,再由 app-settings.view
  // 換算成資料庫欄位名。同一列設定有兩條寫入路徑、兩套欄位名、兩套驗證,
  // 而其中一條沒有任何呼叫端,所以整支拿掉。內部要寫這一列的仍然走
  // SettingsService.update()(setup 精靈與 app-settings 都是),
  // 未知 key 由 pickWritableSettings 擋。
  controllers: [PublicSettingsController],
  providers: [SettingsService, OrgTimeService],
  // OrgTimeService:日期計算要用的組織時區,凡是算「今天」的模組都從這裡拿
  exports: [SettingsService, OrgTimeService],
})
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
export class SettingsModule {}
