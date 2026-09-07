import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { loadEnv } from '../common/env';

const env = loadEnv();

/**
 * 免登入的公開設定端點。
 *
 * ── 為什麼需要它 ────────────────────────────────────────────────
 * 登入頁、邀請連結頁與初始化精靈都要顯示公司名稱、標誌文字與配色,
 * 而那些值在後台是可設定的(system_settings id=1)。這些畫面沒有登入者,
 * 拿不到 /api/admin/settings。前端只好把名稱寫死,於是「管理員改了設定」與
 * 「使用者看到的畫面」永遠分家,而且不會有任何錯誤。
 *
 * ── 邊界 ────────────────────────────────────────────────────────
 * 只回 SettingsService.getPublicDisplay() 逐欄組出來的那幾個展示欄位。
 * id=1 那一列裡面還有地圖服務的聯絡信箱與自訂 geocoder 位址,
 * 那些不能經過這條路徑出去。白名單由測試釘住
 * (public-settings.controller.spec.ts 比對回傳的 key 集合)。
 */
@Controller('public/settings')
export class PublicSettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * rate limit 用寬鬆額度(預設 60 秒 100 次),不是憑證類端點那組嚴格值。
   *
   * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
   * 理由:這支不是憑證端點,擋它擋不到暴力破解,但它是全站的共同前置 ——
   * 登入頁、邀請頁、初始化精靈、聯絡頁與整個 admin 外框都會打。
   * 一間辦公室十幾個人共用同一個對外 IP,早上同時開頁面就會撞到嚴格額度,
   * 拿到 429 之後前端只能退回出廠設定,而使用者完全看不出發生什麼事。
   *
   * 額度是「每個 handler 各自一個桶子」(throttler 的 key 含 class + handler 名),
   * 所以這支跟登入端點不會互相吃額度,放寬它不會鬆到登入。
   *
   * 這支背後有 SettingsService 的 30 秒記憶體快取,不會每次都打 DB。
   */
  @Throttle({
    default: {
      limit: env.THROTTLE_LIMIT_DEFAULT,
      ttl: env.THROTTLE_TTL_SECONDS * 1000,
    },
  })
  @Get()
  async get(): Promise<{
    settings: Awaited<ReturnType<SettingsService['getPublicDisplay']>>;
    serverTime: string;
  }> {
    // serverTime:伺服器時間(ISO),給照片浮水印的時鐘用;放在最外層,不進白名單、不快取
    return {
      settings: await this.settings.getPublicDisplay(),
      serverTime: new Date().toISOString(),
    };
  }
}
