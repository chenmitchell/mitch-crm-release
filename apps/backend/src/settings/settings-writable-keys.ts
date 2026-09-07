// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * system_settings id=1 那一列的「可寫欄位」白名單。
 *
 * ── 為什麼是一份獨立的清單,而不是一支 DTO ──────────────────────────
 * 這一列曾經有兩條 HTTP 寫入路徑:PATCH /api/admin/settings(收資料庫欄位名,
 * 用 UpdateSystemSettingsDto 驗)與 PATCH /api/admin/app-settings(收畫面欄位名,
 * 用 UpdateAppSettingsDto 驗,再由 app-settings.view 換算)。前者沒有任何前端呼叫,
 * 已經整支拿掉,連同那支 DTO —— 只剩測試在用的驗證 class 不留。
 *
 * 這一份留著,而且比以前更重要:它擋的不是 HTTP,是**進到
 * SettingsService.update() 的東西**,不管呼叫端是誰。內部呼叫端
 * (setup.service、app-settings.service)本來就不經過 ValidationPipe,
 * 少了這一份,任何一天有人在內部路徑上多塞一個 key,它就會永久留在那一列裡。
 *
 * 為什麼未知 key 非擋不可:那一列是整包 JSON 的讀改寫,寫進去就永久留著,
 * 而每一條要讀設定的路徑都得把整包讀回來再 merge。塞得進去 = 全站一起變慢。
 *
 * 對齊由 settings-writable-keys.spec.ts 釘住:凡是 toSettingsPatch 產得出來的鍵
 * 都必須在這份清單裡,否則後台存檔會靜靜地把那一格丟掉。
 */
import type { SystemSettingsData } from './settings.types';

/**
 * 允許寫進 system_settings id=1 的欄位。
 *
 * notify* 四個鍵刻意不在這裡:全 repo 沒有任何讀取端,後台與精靈都已經拿掉,
 * 型別留著只是為了讀舊資料。已經存在資料庫裡的舊值不受影響(merge 不會刪),
 * 但不接受新的寫入。
 */
export const WRITABLE_SETTING_KEYS = [
  'productName',
  'organizationDisplayName',
  'stagesConfiguredAt',
  'themeScheme',
  'themeSidebar',
  'themeDefaultMode',
  'areaColors',
  'companyName',
  'logoText',
  'timezone',
  'locale',
  'defaultLanguage',
  'contactPhone',
  'contactEmail',
  'contactAddress',
  'mailingAddress',
  'nominatimEmail',
  'geocoderBaseUrl',
  'geocoderUserAgent',
  'geocodeCountryCodes',
  'mapDefaultLat',
  'mapDefaultLng',
  'mapDefaultZoom',
  'mapTileUrl',
  'geocodeProvider',
  'lookupEnabled',
  'lookupLabel',
  'lookupUrlTemplate',
  'lookupFieldMap',
  'lookupPattern',
  'photoChecklist',
  'photoExemptPremises',
] as const satisfies ReadonlyArray<keyof SystemSettingsData>;

export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number];

const WRITABLE_SET: ReadonlySet<string> = new Set(WRITABLE_SETTING_KEYS);

/** 這個 key 可不可以寫進 id=1 那一列 */
export function isWritableSettingKey(key: string): key is WritableSettingKey {
  return WRITABLE_SET.has(key);
}
