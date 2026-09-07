// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 應用程式設定 API。整支只有兩條路:讀一包、寫一包。
 *
 * 讀(GET /)只給 admin:那一包含外部查詢的網址樣板、地理編碼服務位址與地圖服務
 * 聯絡信箱,不是每個登入者都該看的東西。一般使用者需要的展示用設定走免登入的
 * GET /api/public/settings(逐欄白名單,見 settings/public-settings.controller.ts)。
 *
 * 寫(PATCH /)一律 admin,守衛寫在 AppSettingsService 裡(見那支的 assertAdmin),
 * controller 只負責把 JWT 裡的角色原封不動傳下去。
 *
 * ── 為什麼沒有階段 / 照片種類的逐筆 CRUD ────────────────────────────
 * 曾經有八支(stages 與 photo-kinds 各四支:列表、新增、修改、刪除)。前端從來
 * 沒有打過任何一支 —— 後台設定頁編的是整包 AppSettings,存檔送一次 PATCH /,
 * service 在**同一筆交易加 advisory lock** 裡把五處主檔一起寫完(見
 * updateAppSettings 的說明)。逐筆那八支各自成一筆交易、沒有那把鎖,
 * 拿它們改主檔會出現「階段改了、照片種類還是舊的」這種從畫面上看不出來的中間狀態。
 * 一套主檔留兩條寫入路徑而其中一條沒有人用、沒有人測,所以整組拿掉。
 */
import { Body, Controller, ForbiddenException, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { AppSettingsService } from './app-settings.service';
import { UpdateAppSettingsDto } from './dto/app-settings.dto';
import type { JwtPayload } from '../auth/auth.service';

type Authed = Request & { user: JwtPayload };

@Controller('admin/app-settings')
@UseGuards(AuthGuard('jwt'))
export class AppSettingsController {
  constructor(private readonly svc: AppSettingsService) {}

  /**
   * { settings, stageUsage }。settings 是前端 AppSettings 的形狀,不是資料庫原樣。
   *
   * 這一支是**完整**設定,含 lookupUrlTemplate(實務上金鑰就寫在它的 query string)、
   * geocoderBaseUrl(可能是內網位址)與 nominatimEmail,所以只給 admin。
   * 前端也確實只從 /admin/settings 這一頁打這裡。
   */
  @Get()
  async get(@Req() req: Authed) {
    if (req.user.role !== 'admin') {
      throw new ForbiddenException('只有系統管理員可以讀取完整設定');
    }
    return this.svc.getAll();
  }

  /**
   * 後台存檔。動詞是 PATCH 不是 PUT:前端送的是「畫面上這一份設定」,
   * 沒帶到的欄位(例如聯絡信箱)要維持原值,不是被清空。
   */
  @Patch()
  async patch(@Req() req: Authed, @Body() dto: UpdateAppSettingsDto) {
    return this.svc.updateAppSettings(req.user.role, req.user.sub, dto);
  }
}
