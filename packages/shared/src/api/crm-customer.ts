// ref:3687 mc/陳彥輔/米球®
/**
 * 客戶清單與客戶卡的 **API 回應形狀**(前後端共用的唯一一份)。
 *
 * ## 為什麼需要這一份
 *
 * 這兩個形狀之前在兩邊各寫一份:後端是 crm.service.ts 的 CUSTOMER_LIST_SELECT
 * (逐格列出要 select 的欄位),前端是每一頁自己手寫的 interface。兩份之間
 * 沒有任何編譯期或測試期的連結,所以把後端 select 裡的某一欄拿掉,
 * 型別檢查、單元測試、路徑探針會全部通過 —— 探針只驗「這條路徑存不存在」,
 * 不驗回應長什麼樣。畫面上的結果是那一格永遠顯示 undefined,沒有任何錯誤訊息。
 *
 * 這一份就是那個連結:後端用它反推「select 至少要有哪幾格」,
 * 前端直接拿它當畫面型別。少一欄的話後端那一側編譯不過。
 *
 * ## 為什麼用泛型帶時間型別
 *
 * 同一個欄位在兩端的型別不一樣:Prisma 回 Date,經過 JSON 序列化到前端變成
 * ISO 字串。硬選一邊會讓另一邊得到處 as。所以這裡把「時間怎麼表示」抽成參數,
 * 後端拿 `<Date>`、前端拿 `<string>`,欄位名稱與有無仍然是同一份。
 *
 * ## 這不是驗證 schema
 *
 * 這裡只有 TypeScript 型別,沒有執行期的驗證程式碼,編譯後不留任何東西。
 * 輸入的驗證仍然在後端各模組的 DTO(class-validator)與前端表單裡,
 * 這一份管的是**輸出**:後端答應要給哪幾格。理由見 ../index.ts 的定位說明。
 */

/** 客戶負責人的精簡引用(清單與客戶卡都只帶 id 與姓名) */
export interface CustomerOwnerRef {
  id: string;
  name: string;
}

/**
 * 清單、看板與客戶卡共用的欄位。
 *
 * @typeParam TInstant 時間欄位的表示法:後端(Prisma)是 `Date`,前端(JSON)是 `string`
 */
export interface CustomerCommonFields<TInstant> {
  id: string;
  /** 外部查詢帶入的識別碼;名稱由後台的 lookupLabel 決定 */
  taxId: string | null;
  companyName: string;
  representative: string | null;
  registeredAddress: string | null;
  actualAddress: string | null;
  contactAddress: string | null;
  website: string | null;
  social: string | null;
  category: string | null;
  /** 階段代碼,對應 dev_stages.key(可由後台增減,不是固定聯集) */
  stage: string;
  source: string | null;
  contactName: string | null;
  contactPhone: string | null;
  ownerId: string;
  nextFollowUpAt: TInstant | null;
  lastContactAt: TInstant | null;
  /** 成交後對應的外部系統案件編號 */
  externalCaseRef: string | null;
  /** 地址地理編碼結果(拜訪地圖用);還沒編碼就是 null */
  lat: number | null;
  lng: number | null;
  /** 場所類型代碼,對應 dev_premises_types.key */
  premisesType: string | null;
  createdAt: TInstant;
  updatedAt: TInstant;
}

/**
 * 客戶清單與看板的一列(GET /api/admin/crm、GET /api/admin/crm/board)。
 *
 * 刻意不含 note:它最長 8000 字,而清單與看板一個字都不顯示。
 * 要看備註請走客戶卡。
 */
export interface CustomerListItem<TInstant> extends CustomerCommonFields<TInstant> {
  owner: CustomerOwnerRef | null;
}

/**
 * 客戶卡的主體欄位(GET /api/admin/crm/:id)。
 *
 * 只列「清單也有的欄位再加 note」這一段。互動時間軸與 _count 是客戶卡另外帶的
 * 關聯資料,形狀由那一頁自己負責,不放進這一份 —— 這裡守的是
 * 「後端不會安靜地少給一格客戶欄位」。
 */
export interface CustomerCardFields<TInstant> extends CustomerCommonFields<TInstant> {
  note: string | null;
  owner: CustomerOwnerRef | null;
}

/** 前端(JSON)版本:時間欄位是 ISO 字串 */
export type CustomerListItemJson = CustomerListItem<string>;
/** 前端(JSON)版本:時間欄位是 ISO 字串 */
export type CustomerCardJson = CustomerCardFields<string>;

/**
 * 後端(Prisma)版本:時間欄位是 Date。
 * crm.service.ts 用它反推 select 的最小集合,見那一支的 CUSTOMER_LIST_SELECT。
 */
export type CustomerListItemRow = CustomerListItem<Date>;
/** 後端(Prisma)版本:時間欄位是 Date */
export type CustomerCardRow = CustomerCardFields<Date>;

/**
 * 把契約的欄位名反推成 Prisma 的 select 物件形狀:每一格都必須是 `true`。
 *
 * 後端把 CUSTOMER_LIST_SELECT 宣告成 `satisfies ... & CustomerListSelectShape`,
 * 少列一格就是編譯錯誤,而不是等到畫面上出現空白才有人發現。
 * owner 是關聯,形狀不同,由呼叫端自己接上,所以這裡排除掉。
 */
export type CustomerListSelectShape = {
  [K in keyof CustomerCommonFields<Date>]-?: true;
};

/**
 * 編譯期斷言:A 必須可以指派給 B,不行就在這一行報錯。
 *
 * 用法是宣告一個沒有人讀的 type alias(型別層的東西,編譯後不留程式碼):
 *   type _Check = AssertAssignable<實際回應型別, 契約型別>;
 * 實際型別少一格、型別對不上,錯誤就出現在那一行,而不是散到呼叫端。
 */
export type AssertAssignable<TActual extends TContract, TContract> = TActual;
