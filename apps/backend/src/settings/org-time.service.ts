// ref:3687 mc/陳彥輔/米球®
/**
 * 組織時區 / 地區的讀取點(後端唯一一份)。
 *
 * 日期計算本身在 @mitchcrm/shared 的 org-time(前後端共用),這裡只負責
 * 「時區從哪裡來」:系統設定的 timezone 欄位,快取比照 SettingsService(30 秒 TTL,
 * 由 SettingsService.get() 自己管,這裡不再存第二份,不然改設定之後兩層各過期一次)。
 *
 * SettingsService 用 @Optional:既有的單元測試很多是直接 new Service(prisma),
 * 沒帶設定就退回出廠時區,行為與可設定之前一致。
 */
import { Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  orgDayRange,
  orgDateKey,
  orgPeriodStart,
  orgToday,
  resolveLocale,
  resolveTimeZone,
  type OrgDayRange,
  type OrgPeriod,
} from '@mitchcrm/shared';
import { SettingsService } from './settings.service';

@Injectable()
export class OrgTimeService {
  constructor(@Optional() private readonly settings?: SettingsService) {}

  /** 組織設定的時區;讀不到設定就用出廠預設(不要讓一格設定讓打卡與日報整個停掉) */
  async timeZone(): Promise<string> {
    if (!this.settings) return resolveTimeZone(DEFAULT_TIME_ZONE);
    try {
      const s = await this.settings.get();
      return resolveTimeZone(s.timezone);
    } catch {
      return resolveTimeZone(DEFAULT_TIME_ZONE);
    }
  }

  /** 組織設定的地區(BCP 47)。要送進 HTTP 標頭,所以一律先過格式檢查 */
  async locale(): Promise<string> {
    if (!this.settings) return DEFAULT_LOCALE;
    try {
      const s = await this.settings.get();
      return resolveLocale(s.locale ?? s.defaultLanguage);
    } catch {
      return DEFAULT_LOCALE;
    }
  }

  /** 組織時區的今天('YYYY-MM-DD') */
  async today(now: Date = new Date()): Promise<string> {
    return orgToday(now, await this.timeZone());
  }

  /** 某個時間點在組織時區屬於哪一天 */
  async dateKey(instant: Date): Promise<string> {
    return orgDateKey(instant, await this.timeZone());
  }

  /** 組織時區「今天」的起訖時間點 */
  async dayRange(now: Date = new Date()): Promise<OrgDayRange> {
    return orgDayRange(now, await this.timeZone());
  }

  /** 統計期間(週 / 月 / 季)的起點,以組織時區計 */
  async periodStart(period: OrgPeriod, now: Date = new Date()): Promise<Date> {
    return orgPeriodStart(period, now, await this.timeZone());
  }
}
