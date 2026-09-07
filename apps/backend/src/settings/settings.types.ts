// ref:3687 mc/陳彥輔/米球®
/**
 * 系統設定那一列(system_settings id=1)的資料形狀。
 *
 * 為什麼是獨立一支而不是留在 settings.service.ts:
 * app-settings/app-settings.view.ts 自稱「純函式層,不碰 Nest 也不碰 Prisma」,
 * 卻要 import 這個型別,而 settings.service.ts 反過來 import 那一支的函式 ——
 * 兩個檔案互相 import,雖然其中一邊是 type-only、編譯得過,但迴圈本身
 * 就讓「純函式層」這句話不成立,而且任何一天有人把那個 import 從 `import type`
 * 改成一般 import(例如順手多帶一個常數進來),就會變成執行期的循環相依。
 *
 * 型別留在這裡,兩邊都往這裡 import,環就斷了。
 * settings.service.ts 仍然 re-export 同一個名字,既有的 import 路徑不用改。
 *
 * ── 內容 ────────────────────────────────────────────────
 * 這一列是整個系統「不寫死在程式碼裡」的地方:公司識別、時區與語系、
 * 對外聯絡資訊、地圖服務設定。全部可空,讀取時由 FACTORY_DEFAULTS 補上通用預設。
 *
 * 客戶階段清單與照片存證檢查表不放在這裡:它們是「多筆、要排序、要擋刪除」的主檔,
 * 各自有自己的資料表(dev_stages / visit_photo_kinds),見 ../app-settings。
 */
export interface SystemSettingsData {
  // ── 產品識別 ────────────────────────────────────────────
  /** 產品名(瀏覽器標題、頁尾、PWA 名稱)。留空 = Mitch CRM */
  productName?: string;
  /** 組織對外顯示名(較短,站頭副標)。組織全名是下面的 companyName */
  organizationDisplayName?: string;
  /**
   * 安裝精靈設定過階段的時間(ISO)。
   * 階段主檔在啟動時就 seed 好了,光看 dev_stages 分不出「使用者設過」與「出廠值」,
   * 所以另外記一格,GET /api/setup/status 的步驟標示靠它。
   */
  stagesConfiguredAt?: string;

  // ── 外觀 ────────────────────────────────────────────────
  // 由系統管理員統一決定,所有使用者看到同一套配色。
  // 個別使用者只能選淺色或深色,那個存在瀏覽器本機,不進資料庫。
  /** 配色方案:A 藍綠、B 赤陶 */
  themeScheme?: 'A' | 'B';
  /** 側欄底色深淺 */
  themeSidebar?: 'dark' | 'light';
  /** 預設日夜模式。system = 跟隨作業系統(個別使用者仍可自己切換) */
  themeDefaultMode?: 'light' | 'dark' | 'system';
  /** 功能區識別色:功能區代碼 → 色盤代碼。合法值見 app-settings.view 的 ZONE_NAMES */
  areaColors?: Record<string, string>;

  // ── 公司識別 ────────────────────────────────────────────
  /** 公司 / 組織名稱,出現在頁面標題與匯出檔 */
  companyName?: string;
  /** 側欄與登入頁的文字標誌(沒有圖檔時就用它),留空 = 用 companyName */
  logoText?: string;

  // ── 地區與語系 ──────────────────────────────────────────
  /**
   * IANA 時區字串,例如 Asia/Taipei。
   * 「今天是哪一天」一律以它為準:拜訪排程、日報(可補交範圍、今天誰交了)、打卡核銷、
   * 地圖的「今天要拜訪」、戰情圖表的週 / 月 / 季起點、存證照片浮水印的時間戳,
   * 都走 OrgTimeService → @mitchcrm/shared 的 org-time(用 Intl 查時區資料庫,夏令時間也對)。
   * 認不得的字串會在讀寫時退回出廠預設(見 app-settings.view 的 resolveTimeZone)。
   */
  timezone?: string;
  /** 地區(BCP 47),影響數字與日期格式,例如 zh-TW */
  locale?: string;
  /** 預設介面語言,例如 zh-TW */
  defaultLanguage?: string;

  // ── 對外聯絡資訊 ────────────────────────────────────────
  contactPhone?: string;
  contactEmail?: string;
  /** 辦公室 / 營業地址 */
  contactAddress?: string;
  /** 郵寄收件地址(可與辦公室地址不同) */
  mailingAddress?: string;

  // ── 地圖服務 ────────────────────────────────────────────
  /**
   * Nominatim 使用政策要求帶得出聯絡方式的 User-Agent。
   * 留空時退回環境變數 NOMINATIM_EMAIL,兩邊都沒有就用 placeholder 並在啟動時警告。
   */
  nominatimEmail?: string;
  /**
   * 自訂 geocoder 的基底網址(自架 Nominatim 或相容服務),例如 https://geo.example.com。
   * 留空 = 用公共的 nominatim.openstreetmap.org。
   * 服務名稱會併進 User-Agent,方便對方辨識來源。
   */
  geocoderBaseUrl?: string;
  /** 送出去的 User-Agent 產品名,預設 MitchCRM */
  geocoderUserAgent?: string;
  /**
   * 地理編碼時要不要限制國家,逗號分隔的 ISO 3166-1 alpha-2 兩碼國碼(例:tw 或 jp,kr)。
   * **空字串 = 不限制國家**,這是出廠值:這套系統會裝在哪一國由使用單位決定,
   * 程式碼不預設任何一個。以前這裡寫死 countrycodes=tw,結果是裝在台灣以外的組織
   * 每一筆地址都查不到座標,而畫面上只會顯示「查無此地址」,看不出原因。
   */
  geocodeCountryCodes?: string;
  /** 拜訪地圖打開時的預設中心與縮放 */
  mapDefaultLat?: number;
  mapDefaultLng?: number;
  mapDefaultZoom?: number;
  /**
   * 拜訪地圖的圖磚網址樣板({z}/{x}/{y} 是圖磚座標)。
   * 留空 = 用預設的公共 OpenStreetMap 圖磚。比照 geocoderBaseUrl 做成可設定:
   * 圖磚由使用者的瀏覽器直接請求,會把 IP 與檢視座標範圍送給該服務,
   * 要換成自架或其他相容的圖磚服務就填這一格。
   */
  mapTileUrl?: string;
  /** 地理編碼服務:nominatim 或 none(關閉自動定位,只收手動座標) */
  geocodeProvider?: 'nominatim' | 'none';

  // ── 通知(保留欄位,目前沒有任何實作)──────────────────────
  /**
   * 這四格是既有資料庫裡可能已經存著的鍵,型別留著只是為了讀舊資料不出錯。
   *
   * 全 repo 沒有任何讀取端:後端沒有排程器、沒有寄信元件,前端也沒有推播註冊。
   * 也就是說改這四個值不會改變系統的任何行為,所以安裝精靈與後台設定頁
   * 已經把它們拿掉了 —— 讓人設一個沒有效果的東西比不給設更糟。
   * 真的要做通知時,連同排程器與寄信元件一起補,再把 UI 加回去。
   */
  notifyBrowserPush?: boolean;
  notifyDailyReminderAt?: string;
  notifyEmailEnabled?: boolean;
  notifyEmailFrom?: string;

  // ── 外部查詢帶入(可插拔)────────────────────────────────
  /**
   * 這一組把「輸入一組識別碼,自動帶入名稱、地址、電話」做成設定,
   * 程式碼本身不知道那組識別碼在當地叫什麼、要打哪個網址。
   * 每個國家的公開登記資料都不一樣,寫死任何一個等於把產品綁在一個地區。
   * 實際的呼叫與 SSRF 防護在 ../lookup。
   */
  /** 關著就不提供查詢端點,欄位變成純手動填。預設 false */
  lookupEnabled?: boolean;
  /** 這個識別碼在當地叫什麼(只影響畫面上的字)。預設「公司登記編號」 */
  lookupLabel?: string;
  /** 查詢網址樣板,{q} 會被查詢字串取代,例:https://example.com/api?id={q} */
  lookupUrlTemplate?: string;
  /**
   * 上游回應欄位 → 客戶欄位的對應。key 只認 name / address / phone,
   * value 是點分隔路徑,例:{"name":"data.company_name","address":"data.addr"}
   */
  lookupFieldMap?: Record<string, string>;
  /** 識別碼格式的正規表示式字串。空字串 = 不限制格式 */
  lookupPattern?: string;

  // ── 照片存證檢查表 ──────────────────────────────────────
  /**
   * 場所類型 → 必備的照片類型代碼。代碼要對得上 visit_photo_kinds.key。
   * 沒設定過就用 checkin-rules 的 DEFAULT_PHOTO_CHECKLIST(行為與可設定之前一致)。
   */
  photoChecklist?: Record<string, string[]>;
  /**
   * 明確設定為「不需照片存證」的場所類型代碼。
   *
   * 為什麼要有這一格:photoChecklist 裡某個場所對到空陣列有兩種意思 ——
   * 「這個場所不用拍」與「這個場所還沒設定」。只看空陣列的話,兩者分不出來,
   * 成交守衛要嘛全部放行(管理員新增一個場所忘了設必拍,那些客戶零張照片就能成交),
   * 要嘛全部擋下(後台根本設不出一個真的不用拍的場所)。
   * 有這一格之後就分得出來:在清單裡 = 放行,不在清單裡而且沒有必拍項目 = 擋並指路。
   */
  photoExemptPremises?: string[];
}
