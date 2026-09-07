/**
 * 客戶管理 CRM 模組註冊。
 *
 * 可見範圍:由 AccessScopeService(ScopeModule)一處算出 ViewScope,
 * 各 controller 從 JWT 取角色求出範圍後傳給 service,service 只依它組 where。
 * 口徑是 sales 看自己、sales_manager 看自己團隊(managerId 子樹)與所屬部門子樹、
 * admin 看全部,詳見 ../scope/view-scope.ts。
 */
import { Module } from '@nestjs/common';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ScopeModule } from '../scope/scope.module';
import { SettingsModule } from '../settings/settings.module';
import { StageCatalogModule } from '../app-settings/stage-catalog.module';
import { CrmMapController } from './map/crm-map.controller';
import { CrmGeoService } from './map/crm-geo.service';
import { CrmCheckinController } from './checkin/crm-checkin.controller';
import { CrmCheckinService } from './checkin/crm-checkin.service';
import { CrmDuplicatesController } from './duplicates/crm-duplicates.controller';
import { CrmDuplicatesService } from './duplicates/crm-duplicates.service';
import { CrmDailyReportsController } from './daily-reports/crm-daily-reports.controller';
import { CrmDailyReportsService } from './daily-reports/crm-daily-reports.service';
import { CrmStatsController } from './stats/crm-stats.controller';
import { CrmStatsService } from './stats/crm-stats.service';
import { CrmVisitPlansController } from './visit-plans/crm-visit-plans.controller';
import { CrmVisitPlansService } from './visit-plans/crm-visit-plans.service';
import { CrmContactsController } from './contacts/crm-contacts.controller';
import { CrmContactsService } from './contacts/crm-contacts.service';
import { CrmTrashController } from './deletion/crm-deletion.controller';
import { CrmDeletionService } from './deletion/crm-deletion.service';
import { CrmExportController } from './export/crm-export.controller';
import { CrmExportService } from './export/crm-export.service';
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

@Module({
  // StageCatalogModule:階段語意(進行中 / 終止 / 排序 / 標籤)一律查 dev_stages,不寫死代碼
  imports: [PrismaModule, ScopeModule, SettingsModule, StageCatalogModule],
  // 子功能各用獨立路徑前綴(admin/crm-*),避免被 CrmController 的 GET :id 吃掉
  controllers: [
    CrmController,
    CrmMapController,
    CrmCheckinController,
    CrmDuplicatesController,
    CrmDailyReportsController,
    CrmStatsController,
    CrmVisitPlansController,
    CrmContactsController,
    // 刪除 / 回收桶與匯出各用獨立前綴(admin/crm-trash、admin/crm-export),
    // 理由同上:掛在 admin/crm 底下會被 CrmController 的 GET :id 先接走
    CrmTrashController,
    CrmExportController,
  ],
  providers: [
    CrmService,
    CrmGeoService,
    CrmCheckinService,
    CrmDuplicatesService,
    CrmDailyReportsService,
    CrmStatsService,
    CrmVisitPlansService,
    CrmContactsService,
    CrmDeletionService,
    CrmExportService,
  ],
})
export class CrmModule {}
