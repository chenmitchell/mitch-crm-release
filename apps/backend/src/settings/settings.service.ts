// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PHOTO_CHECKLIST } from '../crm/checkin/checkin-rules';
import {
  APP_SETTINGS_VIEW_DEFAULTS,
  DEFAULT_AREA_COLORS,
  LOOKUP_DEFAULT_LABEL,
  toAppSettingsView,
  type AppSettingsView,
  type PhotoKindRow,
  type StageRow,
  type VocabRow,
} from '../app-settings/app-settings.view';
// 時區與地區的出廠預設共用 shared 那一份(前端保底值也讀同一個常數)
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from '@mitchcrm/shared';
import { lockSettingsRow } from './settings-lock';
import { isWritableSettingKey } from './settings-writable-keys';

/**
 * 單一登入(SSO)設定固定用 system_settings 的 id=3 這一列。
 *
 * 為什麼不塞進 id=1:
 *   GET /api/admin/settings 會把 id=1 整包回給任何登入者,SSO 的允許網域與
 *   自動建帳號開關屬於「誰能進系統」的存取控制設定,不該讓一般帳號讀得到,
 *   更不該被誤改。另開一列,只有 admin-only 的路徑讀寫得到。
 *
 * 這裡只存「政策」,不存「憑證」:
 *   ENTRA_CLIENT_SECRET 一律只留在環境變數,不進資料庫、不回前端、不進 log。
 */
export const SSO_SETTINGS_ROW_ID = 3;

/**
 * M365 組織資料快取固定用 system_settings 的 id=4 這一列。
 * 這是快取不是真相來源:真相在 Entra,每次登入覆寫一次。
 * 讀不到就當成「還沒同步過」,不影響任何權限判斷。
 */
export const M365_DIRECTORY_ROW_ID = 4;

/**
 * SSO 政策設定(id=3 那一列的 JSON)
 * 欄位留 undefined = 沒設定過 → 由呼叫端 fallback 到環境變數。
 */
export interface SsoSettingsData {
  /**
   * 允許登入的 email 網域清單。
   * 已正規化(小寫、無空白);可含 *.example.com 代表「含子網域」。
   * 空陣列 [] 與 undefined 意義不同:
   *   undefined = 從未在後台設定過 → fallback 到 ENTRA_ALLOWED_DOMAINS
   *   []        = 後台明確清空 → 不限網域(後台會顯示警告)
   */
  entraAllowedDomains?: string[];
  /** AD 有這個人就自動開帳號。undefined = fallback 到 ENTRA_AUTO_PROVISION */
  entraAutoProvision?: boolean;
  /**
   * 登入時要不要一併同步「主管」。
   * 預設 false,而且必須是 false:讀主管要 User.Read.All,那是**需要系統管理員
   * 同意**、而且等於「可以讀全租用戶所有人資料」的權限。預設打開等於幫 IT 決定
   * 要不要授出這種權限。沒同意也可以打開,只是 Graph 會回 403,這裡安靜跳過。
   */
  entraSyncManager?: boolean;
  /**
   * 自動建立帳號時要套用的預設部門(dev_departments.id)。
   * undefined / null = 不指定。
   *
   * 為什麼需要這一格:訪查主管看得到誰,是由 users.manager_id 與 users.department_id
   * 兩欄算出來的(見 scope/view-scope.ts)。SSO 自動建的帳號兩欄都空著的話,
   * 那個人能正常打卡建客戶,但他的主管在看板、戰情、日報、地圖上一筆都看不到,
   * 而且畫面上沒有任何提示。邀請連結那條路徑早就會繼承邀請人的部門,
   * SSO 這條要有等價的東西,不然「開了自動建帳號」等於製造一批隱形帳號。
   */
  entraDefaultDepartmentId?: string | null;
  /** 自動建立帳號時要套用的預設主管(users.id)。undefined / null = 不指定。理由同上 */
  entraDefaultManagerId?: string | null;
}

/**
 * 一位使用者從 Microsoft Graph 同步回來的組織資料(存 id=4 那一列)。
 * 全部可空:Graph 上沒填的欄位就是沒有,不要用空字串假裝有值。
 */
export interface M365DirectoryEntry {
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  mobilePhone?: string | null;
  businessPhone?: string | null;
  employeeId?: string | null;
  managerName?: string | null;
  managerEmail?: string | null;
  /** 最後一次成功同步的時間(ISO) */
  syncedAt?: string;
  /** 最後一次同步失敗的時間(ISO)。有值 = 那次登入 Graph 沒回應,資料是舊的 */
  lastFailedAt?: string;
}

export interface M365DirectoryData {
  /** userId → 組織資料 */
  users?: Record<string, M365DirectoryEntry>;
}

/**
 * 系統設定那一列的資料形狀。定義搬到 settings.types.ts 以斷開與
 * app-settings.view.ts 的 type-only import 環(理由寫在那一支的檔頭),
 * 這裡 re-export 同一個名字,既有的 import 路徑不用改。
 */
export type { SystemSettingsData } from './settings.types';
import type { SystemSettingsData } from './settings.types';

/**
 * 免登入端點允許對外的欄位白名單。
 *
 * 這一份是**斷言用的**,不是執行期會被讀到的過濾器:實際出得去的欄位由
 * 下面 getPublicDisplay() 逐欄組出來的那個物件決定,程式路徑上沒有人 import
 * 這個常數。唯一的讀者是 public-settings.controller.spec.ts,它把
 * getPublicDisplay() 實際回傳的 key 集合跟這一份對起來 ——
 * 兩邊走散就紅燈,所以要加一個對外欄位,兩個地方都要動。
 * 只改這一份不會讓任何欄位變成公開的,只會讓那支測試紅。
 */
export const PUBLIC_DISPLAY_SETTING_KEYS = [
  // 舊名(頁尾、聯絡頁與匯出檔用的欄位名,前端把 companyName 當 organizationName 的別名來源)
  'companyName',
  'contactAddress',
  'email',
  'defaultLanguage',
  // 前端 AppSettings 的欄位,一字不差
  'productName',
  'logoText',
  'organizationName',
  'organizationDisplayName',
  'phone',
  'mailingAddress',
  'timezone',
  'locale',
  'themeScheme',
  'themeSidebar',
  'themeDefaultMode',
  'stages',
  'photoChecklist',
  'photoExemptPremises',
  'channels',
  'premisesTypes',
  'categories',
  'areaColors',
  'mapDefaultLat',
  'mapDefaultLng',
  'mapDefaultZoom',
  // 圖磚由使用者瀏覽器直接請求,不是機密,地圖元件要靠它才畫得出圖磚
  'mapTileUrl',
  'geocodeProvider',
  // 只有這三個:網址樣板與欄位對應是伺服器端的設定(可能含金鑰或內部網址),
  // 不對未登入者公開,只走需要 admin 的 /api/admin/app-settings。
  'lookupEnabled',
  'lookupLabel',
  'lookupPattern',
] as const;

/**
 * 公開展示欄位。全部是本來就會印在名片或頁尾上、或是畫面本身長什麼樣的資訊,
 * 沒有任何內部設定、門檻或樣板。
 *
 * 為什麼階段清單與照片存證檢查表也在這裡:整個前端的看板欄位、表單下拉與
 * 缺件提示都由這一包供應(見 apps/frontend/src/lib/app-settings.tsx)。
 * 不放進來的話,前端只能一路用它自己的保底預設值,後台改階段完全不會反映到畫面,
 * 而且沒有任何錯誤訊息 —— 那正是「兩邊各自能編譯、合起來不能跑」的樣子。
 * 內容本身是「這套系統的看板有哪幾欄」,不含任何客戶資料。
 *
 * 通知設定(notify*)不在這裡,也不在 AppSettingsView 裡:那四個鍵沒有任何讀取端,
 * 已經從精靈與後台設定頁移除,只在 SystemSettingsData 留著型別以便讀舊資料。
 */
export interface PublicDisplaySettings extends Omit<
  AppSettingsView,
  // 外部查詢的網址樣板與欄位對應可能帶著金鑰或內部服務位址,不公開
  | 'lookupUrlTemplate'
  | 'lookupFieldMap'
  // 地理編碼的國家限制是伺服器端打外部服務時才用得到的參數,前端不做地理編碼
  | 'geocodeCountryCodes'
> {
  /** 公司 / 組織名稱(organizationName 的舊欄位名,兩者同值) */
  companyName: string;
  /** 辦公室 / 營業地址 */
  contactAddress: string;
  /** 對外聯絡信箱 */
  email: string;
  /** 預設介面語言 */
  defaultLanguage: string;
}

/**
 * 出廠預設。刻意全部是通用值:這是公開的產品,不預設任何一家公司的資料。
 * 第一次啟動的初始化精靈(POST /api/setup)會把使用者填的公司資料寫進 id=1。
 */
const FACTORY_DEFAULTS: SystemSettingsData = {
  productName: 'Mitch CRM',
  organizationDisplayName: '',
  themeScheme: 'A',
  themeSidebar: 'dark',
  themeDefaultMode: 'system',
  areaColors: { ...DEFAULT_AREA_COLORS },
  mapDefaultLat: APP_SETTINGS_VIEW_DEFAULTS.mapDefaultLat,
  mapDefaultLng: APP_SETTINGS_VIEW_DEFAULTS.mapDefaultLng,
  mapDefaultZoom: APP_SETTINGS_VIEW_DEFAULTS.mapDefaultZoom,
  mapTileUrl: APP_SETTINGS_VIEW_DEFAULTS.mapTileUrl,
  geocodeProvider: 'nominatim',
  companyName: 'Mitch CRM',
  logoText: '',
  timezone: DEFAULT_TIME_ZONE,
  locale: DEFAULT_LOCALE,
  defaultLanguage: 'zh-TW',
  contactPhone: '',
  contactEmail: '',
  contactAddress: '',
  mailingAddress: '',
  nominatimEmail: '',
  geocoderBaseUrl: '',
  geocoderUserAgent: 'MitchCRM',
  // 出廠不限制國家。要限制的組織在系統設定的「地圖與地理編碼」自己填
  geocodeCountryCodes: '',
  lookupEnabled: false,
  lookupLabel: LOOKUP_DEFAULT_LABEL,
  lookupUrlTemplate: '',
  lookupFieldMap: {},
  lookupPattern: '',
  // 檢查表的出廠值定義在 checkin-rules(那裡是唯一的預設來源),這裡只是複製一份進設定
  photoChecklist: Object.fromEntries(
    Object.entries(DEFAULT_PHOTO_CHECKLIST).map(([k, v]) => [k, [...v]]),
  ),
  // 出廠沒有任何場所被豁免:照片存證是這套系統的核心,要豁免得由管理員明講
  photoExemptPremises: [],
};

/**
 * 只有系統管理員讀得到的欄位。
 *
 * 判準是「這一格的值本身是憑證、內部位址,或會變成對外請求的一部分」:
 *   lookupUrlTemplate  外部查詢的網址樣板。實務上 API 金鑰就寫在它的 query string 裡
 *   lookupFieldMap     上游回應的結構,等於把對方的 API 形狀交出去
 *   geocoderBaseUrl    自架地理編碼服務的位址,常常是內網
 *   nominatimEmail     地圖服務的聯絡信箱,是對外請求的識別
 *   notifyEmailFrom    寄件人位址(功能已移除,舊資料可能還存著這一格,所以繼續擋)
 * 這一份與 public-settings 的白名單是同一個判準的兩種寫法:那邊是逐欄放行,
 * 這邊是逐欄擋掉,兩邊都不要用「展開再刪」的寫法,新欄位才不會自動跟著出去。
 */
export const ADMIN_ONLY_SETTING_KEYS = [
  'lookupUrlTemplate',
  'lookupFieldMap',
  'geocoderBaseUrl',
  'nominatimEmail',
  'notifyEmailFrom',
] as const satisfies ReadonlyArray<keyof SystemSettingsData>;

/**
 * 寫 system_settings 需要的最小介面。交易客戶端(Prisma.TransactionClient)與
 * PrismaService 都符合,所以呼叫端可以把自己的 tx 傳進來共用同一條連線。
 *
 * 為什麼連 $queryRaw 也要:這一列的寫入是 read-modify-write(整包 JSON),
 * 必須先拿 advisory lock 才安全(見 settings-lock.ts)。鎖要跟讀寫在同一條連線上,
 * 所以發鎖的能力得是這個介面的一部分,不能另外借一條。
 */
export type SettingsWriteClient = Pick<PrismaService, 'systemSettings' | '$queryRaw'>;

/**
 * 只留下允許寫進 id=1 的欄位,其餘一律丟掉(不是丟例外:內部呼叫端不該因為
 * 多帶一個沒人認得的 key 就整筆失敗,但那個 key 也絕不該被寫進去)。
 *
 * `undefined` 的欄位也一併去掉:JSON.stringify 會把它整個吃掉,但物件展開
 * (`{ ...current, ...patch }`)不會 —— 它會把既有的值蓋成 undefined,
 * 存進 Json 欄位之後那一格就沒了。呼叫端要清空一格請送空字串或 null。
 */
export function pickWritableSettings(
  patch: Partial<SystemSettingsData>,
): Partial<SystemSettingsData> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!isWritableSettingKey(key)) continue;
    out[key] = value;
  }
  return out as Partial<SystemSettingsData>;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cached: SystemSettingsData | null = null;
  private cachedAt = 0;
  private readonly CACHE_TTL_MS = 30_000; // 30s cache(避免 buildVariables 每次打 DB)

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SystemSettingsData> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.CACHE_TTL_MS) {
      return this.cached;
    }
    const row = await this.prisma.systemSettings.findUnique({ where: { id: 1 } });
    const data = row ? (row.data as SystemSettingsData) : {};
    const merged = { ...FACTORY_DEFAULTS, ...data };
    this.cached = merged;
    this.cachedAt = now;
    return merged;
  }

  /**
   * 給「設定畫面」這條讀取路徑用的版本。
   *
   * 這支原本的參數叫 `_isAdmin`,值完全沒用,註解寫著「目前沒有只給 admin 看的欄位」。
   * 那句話不成立:id=1 這一列裡有 lookupUrlTemplate(實務上金鑰就寫在 query
   * string 裡)、geocoderBaseUrl(可能是內網位址)、nominatimEmail 與整套聯絡資料。
   * public-settings.controller.ts 的檔頭正是為了這幾欄才逐欄組白名單,結果同一批值
   * 從 GET /api/admin/settings 對「任何登入者」原樣送出去,一般訪查人員的帳號就拿得到。
   *
   * 現在真的依 isAdmin 過濾。呼叫端的 controller 另外有 admin 檢查,這裡是第二道:
   * 少一道也不會外洩,而且日後有人加了新的讀取路徑,預設就是安全的那一邊。
   */
  async getForRead(isAdmin: boolean): Promise<SystemSettingsData> {
    const full = await this.get();
    if (isAdmin) return full;
    const safe = { ...full };
    for (const key of ADMIN_ONLY_SETTING_KEYS) delete safe[key];
    return safe;
  }

  /**
   * 寫入 id=1。
   *
   * client 可以傳一個交易客戶端進來,讓這一次寫入跟呼叫端的其他寫入在同一筆交易、
   * 同一條連線上完成。預設用 this.prisma(自己借一條連線)。
   * 為什麼要開這個口:呼叫端在交易裡呼叫這一支時,預設會另外借一條連線,
   * Prisma 的連線池在單 vCPU 只有 3 條,幾個併發請求就會互相等到 pool timeout,
   * 而且設定寫入不在呼叫端的交易裡,失敗時回不掉。
   *
   * 併發:這一支跟 upsertM365DirectoryEntry 一樣是 read-modify-write(整包 JSON
   * 讀出來、merge、再整包寫回),所以同樣先拿 advisory lock。
   * 實務上兩位管理員同時按存檔的機率遠低於「上班尖峰兩個人同時 SSO 登入」,
   * 但這裡照樣加,理由有三個:成本只有一道語句;初始化精靈與後台設定頁是兩條
   * 不同的呼叫路徑,同時跑並非不可能;而且「同一種讀改寫,有的有鎖有的沒有」
   * 本身就是日後有人照著沒鎖那一支複製貼上的來源。
   */
  async update(
    isAdmin: boolean,
    userId: string,
    patch: Partial<SystemSettingsData>,
    client?: SettingsWriteClient,
  ): Promise<SystemSettingsData> {
    if (!isAdmin) throw new ForbiddenException('只有系統管理員可以修改系統設定');
    // 未知 key 一律丟掉(白名單見 settings-writable-keys.ts)。
    // 這一列已經沒有自己的 HTTP 端點,所有寫入都是內部呼叫(setup.service、
    // app-settings.service),而它們根本不經過 ValidationPipe —— 只有這一道攔得到。
    // 為什麼非擋不可:這一列是整包 JSON 的讀改寫,寫進去的東西會永久留著,
    // 而每一條要讀設定的路徑都要把整包讀回來再 merge —— 塞得進去就等於全站一起變慢。
    const safePatch = pickWritableSettings(patch);
    const dropped = Object.keys(patch).length - Object.keys(safePatch).length;
    const run = async (tx: SettingsWriteClient): Promise<SystemSettingsData> => {
      await lockSettingsRow(tx, 1);
      const current = await tx.systemSettings.findUnique({ where: { id: 1 } });
      const newData = { ...((current?.data as SystemSettingsData) ?? {}), ...safePatch };
      await tx.systemSettings.upsert({
        where: { id: 1 },
        create: { id: 1, data: newData as object, updatedBy: userId },
        update: { data: newData as object, updatedBy: userId },
      });
      return newData;
    };
    const newData = client ? await run(client) : await this.prisma.$transaction(run);
    this.cached = null; // bust cache
    // 只記數量,不記 key 也不記值:這一列裡有查詢樣板與內部服務位址
    this.logger.log(
      `[settings] updated by ${userId}, ${Object.keys(safePatch).length} fields` +
        (dropped > 0 ? `(另有 ${dropped} 個未知欄位被丟棄)` : ''),
    );
    return { ...FACTORY_DEFAULTS, ...newData };
  }

  /** 工廠出廠值(給前端 reset / fallback 用)*/
  getFactoryDefaults(): SystemSettingsData {
    return { ...FACTORY_DEFAULTS };
  }

  /**
   * 公開展示用設定(免登入端點 GET /api/public/settings 唯一的資料來源)。
   *
   * 回傳值刻意「逐欄組出來」而不是從 SystemSettingsData 挑欄位刪:
   *   挑欄位刪的寫法,日後有人往設定裡加一個新欄位,那個欄位會自動跟著出去。
   *   逐欄組出來的寫法,新欄位預設是不出去的,要外洩必須有人在這裡動手加。
   *   這一列裡面有地圖服務的聯絡信箱,那個不該出現在免登入端點。
   *
   * 對應的白名單測試在 public-settings.controller.spec.ts,釘住「回傳的 key 集合」。
   */
  async getPublicDisplay(): Promise<PublicDisplaySettings> {
    const full = await this.get();
    const [stages, photoKinds, channels, premisesTypes, categories] = await Promise.all([
      this.readStages(),
      this.readPhotoKinds(),
      this.readChannels(),
      this.readPremisesTypes(),
      this.readCategories(),
    ]);
    const view = toAppSettingsView(full, stages, photoKinds, {
      channels,
      premisesTypes,
      categories,
    });
    // 逐欄組出來(不是把 view 展開再刪欄位):往設定裡加新欄位時,
    // 新欄位預設是不出去的,要外洩必須有人在這裡動手加一行。
    return {
      companyName: view.organizationName,
      organizationName: view.organizationName,
      organizationDisplayName: view.organizationDisplayName,
      productName: view.productName,
      // logoText 留空就等於組織名稱:設定畫面上少填一格,不是「沒有標誌」
      logoText: view.logoText.trim() || view.organizationName,
      mailingAddress: view.mailingAddress,
      contactAddress: full.contactAddress ?? '',
      phone: view.phone,
      email: full.contactEmail ?? '',
      timezone: view.timezone,
      locale: view.locale,
      defaultLanguage: full.defaultLanguage ?? 'zh-TW',
      themeScheme: view.themeScheme,
      themeSidebar: view.themeSidebar,
      themeDefaultMode: view.themeDefaultMode,
      stages: view.stages,
      photoChecklist: view.photoChecklist,
      // 前端的缺件提示要分得出「這個場所不用拍」與「還沒設定」,所以這一份要公開。
      // 內容只有場所類型代碼,沒有任何客戶資料
      photoExemptPremises: view.photoExemptPremises,
      channels: view.channels,
      premisesTypes: view.premisesTypes,
      categories: view.categories,
      areaColors: view.areaColors,
      mapDefaultLat: view.mapDefaultLat,
      mapDefaultLng: view.mapDefaultLng,
      mapDefaultZoom: view.mapDefaultZoom,
      // 圖磚由使用者瀏覽器直接請求,不是機密,所以走公開設定給地圖元件用
      mapTileUrl: view.mapTileUrl,
      geocodeProvider: view.geocodeProvider,
      lookupEnabled: view.lookupEnabled,
      lookupLabel: view.lookupLabel,
      lookupPattern: view.lookupPattern,
    };
  }

  /**
   * 讀階段主檔給公開端點用。查不到就回空陣列 ——
   * 這條路徑是登入頁與邀請頁在走,資料表還沒建好的時候不該讓整頁掛掉,
   * 前端拿到空清單會退回它自己的保底預設值。
   */
  private async readStages(): Promise<StageRow[]> {
    try {
      const rows = await this.prisma.devStage.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: {
          key: true,
          label: true,
          color: true,
          sortOrder: true,
          isActive: true,
          isTerminal: true,
          showOnBoard: true,
          showInForm: true,
        },
      });
      return rows as StageRow[];
    } catch {
      return [];
    }
  }

  private async readPhotoKinds(): Promise<PhotoKindRow[]> {
    try {
      const rows = await this.prisma.visitPhotoKind.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true, isActive: true },
      });
      return rows as PhotoKindRow[];
    } catch {
      return [];
    }
  }

  /**
   * 互動管道主檔。查不到就回空陣列,由 toAppSettingsView 退回出廠預設 ——
   * 舊部署的遷移還沒跑完時,客戶卡的管道下拉不該整個空掉。
   */
  private async readChannels(): Promise<VocabRow[]> {
    try {
      const rows = await this.prisma.devInteractionChannel.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true, isActive: true },
      });
      return rows as VocabRow[];
    } catch {
      return [];
    }
  }

  /** 場所類型主檔。理由同 readChannels */
  private async readPremisesTypes(): Promise<VocabRow[]> {
    try {
      const rows = await this.prisma.devPremisesType.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true, isActive: true },
      });
      return rows as VocabRow[];
    } catch {
      return [];
    }
  }

  /** 商業分類主檔。理由同 readChannels */
  private async readCategories(): Promise<VocabRow[]> {
    try {
      const rows = await this.prisma.devCategory.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true, isActive: true },
      });
      return rows as VocabRow[];
    } catch {
      return [];
    }
  }

  /**
   * 讀出 SSO 政策設定(id=3)。沒設定過回 {},不補預設值 ——
   * 「沒設定過」與「設成空的」必須分得出來,fallback 到 env 的判斷靠這個。
   *
   * 刻意不快取:這一列一改就要立刻生效(IT 加完網域會馬上叫人重試登入),
   * 而且後端可能有多個 instance,記憶體快取會讓「改了但某一台還是舊的」
   * 變成隨機現象,那種 bug 很難查。SSO 登入本來就不是高頻路徑。
   */
  async getSsoSettings(): Promise<SsoSettingsData> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { id: SSO_SETTINGS_ROW_ID },
    });
    return (row?.data as SsoSettingsData | undefined) ?? {};
  }

  /** 寫入 SSO 政策設定(admin only)。只覆蓋有帶的欄位。 */
  async updateSsoSettings(
    isAdmin: boolean,
    userId: string,
    patch: Partial<SsoSettingsData>,
  ): Promise<SsoSettingsData> {
    if (!isAdmin) throw new ForbiddenException('只有系統管理員可以修改單一登入設定');
    // 同樣是整包 JSON 的讀改寫,鎖的理由與 update() 相同(見 settings-lock.ts)
    const newData = await this.prisma.$transaction(async (tx) => {
      await lockSettingsRow(tx, SSO_SETTINGS_ROW_ID);
      const row = await tx.systemSettings.findUnique({ where: { id: SSO_SETTINGS_ROW_ID } });
      const merged: SsoSettingsData = {
        ...((row?.data as SsoSettingsData | undefined) ?? {}),
        ...patch,
      };
      await tx.systemSettings.upsert({
        where: { id: SSO_SETTINGS_ROW_ID },
        create: { id: SSO_SETTINGS_ROW_ID, data: merged as object, updatedBy: userId },
        update: { data: merged as object, updatedBy: userId },
      });
      return merged;
    });
    this.logger.log(`[settings] SSO 設定已更新 by ${userId},欄位=${Object.keys(patch).join(',')}`);
    return newData;
  }

  /**
   * 讀 M365 組織資料快取(id=4)。沒同步過就回 {}。
   * 不快取在記憶體:這一列每次登入都會被改寫,記憶體快取只會讓
   * 「剛登入的人在後台看到的還是上一版部門」變成隨機現象。
   */
  async getM365Directory(): Promise<M365DirectoryData> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { id: M365_DIRECTORY_ROW_ID },
    });
    return (row?.data as M365DirectoryData | undefined) ?? {};
  }

  /**
   * 寫入某位使用者的組織資料。
   *
   * 刻意做成 merge 而不是覆寫整包:同步失敗那次只會補一個 lastFailedAt,
   * 上一次成功同步的部門與職稱要留著 —— 「同步失敗」不等於「這個人沒有部門」。
   * 這支不做權限檢查:它的呼叫端是登入流程本身,對象永遠是登入者自己。
   *
   * 為什麼整段包在交易裡、而且開頭先拿 advisory lock:
   *   這一列存的是「全部使用者」的一包 JSON,merge 的對象是整包,不是自己那一格。
   *   呼叫端是登入流程本身,上班尖峰必然有兩個人同時登入,而兩邊都是
   *   「讀整包 → 改自己那一格 → 寫整包」。沒有鎖的話後寫的那個是拿讀到的舊快照
   *   覆蓋,前一位剛同步好的部門、職稱整筆消失,而且完全沒有錯誤訊息。
   *   影響只限於後台顯示用的欄位(可見範圍走 users.manager_id 與 users.department_id
   *   兩個真欄位,不吃這一包),下次登入也會補回來,但那是靠使用者再登入一次來
   *   遮掩競態,不是修好它。
   *   讀也必須在鎖之後、同一條連線上,所以這裡不呼叫 getM365Directory()(它走
   *   this.prisma,會另外借一條連線,讀到的仍可能是鎖外的舊值)。
   */
  async upsertM365DirectoryEntry(
    userId: string,
    entry: M365DirectoryEntry,
  ): Promise<M365DirectoryEntry> {
    return this.prisma.$transaction(async (tx) => {
      await lockSettingsRow(tx, M365_DIRECTORY_ROW_ID);
      const row = await tx.systemSettings.findUnique({ where: { id: M365_DIRECTORY_ROW_ID } });
      const current = (row?.data as M365DirectoryData | undefined) ?? {};
      const users = { ...(current.users ?? {}) };
      const merged: M365DirectoryEntry = { ...(users[userId] ?? {}), ...entry };
      users[userId] = merged;
      const newData: M365DirectoryData = { ...current, users };
      await tx.systemSettings.upsert({
        where: { id: M365_DIRECTORY_ROW_ID },
        create: { id: M365_DIRECTORY_ROW_ID, data: newData as object, updatedBy: userId },
        update: { data: newData as object, updatedBy: userId },
      });
      return merged;
    });
  }
}
