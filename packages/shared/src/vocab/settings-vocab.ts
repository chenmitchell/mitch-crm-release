// ref:3687 mc/陳彥輔/米球®
/**
 * 設定畫面共用的出廠語彙:功能區識別色的色盤代碼、外部查詢的欄位對應與預設名稱。
 *
 * 為什麼搬到共用套件:這三份原本各有兩個定義。
 *   - `ZONE_NAMES`:後端 app-settings.view.ts 一份、前端 lib/app-settings.tsx 一份。
 *   - `LOOKUP_DEFAULT_LABEL`:同上兩份,而且前端那一份的註解就寫著「兩邊都要改」。
 *   - `LOOKUP_TARGET_FIELDS`:後端內部就有兩份(lookup/lookup-url.ts 與
 *     app-settings/app-settings.view.ts),前端再一份,共三處。
 *
 * 這三個值都是前後端要對得起來的合約:後端拿它們清洗資料、前端拿同一組去畫下拉與
 * 解析回應。任何一邊自己改,症狀都是靜默的 —— 後端把不認得的功能區色退回預設,
 * 而畫面上只是「顏色跟設定的不一樣」,沒有任何錯誤。
 */

/**
 * 功能區識別色只能從這五組「已驗過對比」的色盤挑,不開放自由填色值。
 *
 * 每一組在前端 globals.css 都備齊 accent / tint / tint-fg,而且淺色、深色、
 * 配色方案 A、B 四種組合各自量過(白字對 accent >= 7:1、tint-fg 對 tint >= 7:1)。
 * 開放自由填色碼的話,只要填亮一點,整個功能區的字就掉出 AAA,而設定頁上看不出來。
 */
export const ZONE_NAMES = ['dev', 'app', 'rev', 'dash', 'sys'] as const;
export type ZoneName = (typeof ZONE_NAMES)[number];

/**
 * 外部查詢識別碼的預設名稱。
 *
 * 刻意用一個通用到有點笨的說法:這一格在每個地方的正式名稱都不同,
 * 而這套系統不預設任何一個地區。裝好之後由後台改成當地的說法。
 */
export const LOOKUP_DEFAULT_LABEL = '公司登記編號';

/** 欄位對應表只認這三個目標欄位(對應新增客戶表單的公司名 / 登記地址 / 電話) */
export const LOOKUP_TARGET_FIELDS = ['name', 'address', 'phone'] as const;
export type LookupTargetField = (typeof LOOKUP_TARGET_FIELDS)[number];
