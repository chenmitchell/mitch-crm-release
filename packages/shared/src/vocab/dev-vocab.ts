// ref:3687 mc/陳彥輔/米球®
/**
 * 業務語彙的出廠預設:客戶階段與存證照片種類。
 *
 * 為什麼放在 packages/shared:
 *   這兩份清單前端與後端都要一份保底值 —— 後端第一次啟動要 seed 進
 *   dev_stages / visit_photo_kinds,前端在 /api/public/settings 還沒回來
 *   (或整支失敗)時要先畫得出看板。各抄一份的結果是兩邊慢慢走散:
 *   同一個 key 在後端叫「報價中」、在前端叫「洽談中」,顏色也不一樣,
 *   全新安裝時看板會先畫錯一次再跳掉,而畫面上看不出原因。
 *   單一份在這裡,兩邊都 import,走散這件事就不可能發生。
 *
 * 這裡是**出廠預設**,不是執行期的合法值來源。
 * 執行期一律以資料表(dev_stages / visit_photo_kinds)為準,
 * 不然後台新增的階段會被程式碼裡的清單擋掉,而這正是這套系統的賣點。
 *
 * key 一旦寫進 dev_customers.stage / dev_visit_photos.kind 就不可以再改:
 * 那是資料值,不是顯示文字。要改字請改 label。
 */

/** 看板色組名。對應前端 globals.css 的 --st-<name>-bg / -fg / -bar */
export const STAGE_COLOR_NAMES = [
  'purple',
  'info',
  'teal',
  'amber',
  'pink',
  'green',
  'neutral',
  'danger',
] as const;
export type StageColorName = (typeof STAGE_COLOR_NAMES)[number];

/**
 * 產品保留的兩個階段代碼。
 *
 * 這是全系統唯一可以寫死階段代碼的地方,其他一律查 dev_stages。
 * 保留的理由是它們不只是「一個階段」,而是綁著一段流程:
 *   converted:標記成交流程的終點(要過場所類型與存證照片檢查才寫得進去),
 *             統計的成交數、合併時的優先階段都認這個值。
 *   dropped :查重合併把被併掉的那筆標成這個值,查重候選預設也排除它。
 * 後台可以改它們的 label 與顏色,也可以再加自己的終止階段;
 * 「是不是終止階段」一律以 dev_stages.is_terminal 判斷,不是靠這兩個代碼。
 */
export const WON_STAGE_KEY = 'converted';
export const LOST_STAGE_KEY = 'dropped';
export const RESERVED_STAGE_KEYS: readonly string[] = [WON_STAGE_KEY, LOST_STAGE_KEY];

export interface DefaultDevStage {
  readonly key: string;
  readonly label: string;
  /** 看板色組名(見 STAGE_COLOR_NAMES),不是 hex 色碼 */
  readonly color: StageColorName;
  readonly sortOrder: number;
  /** 終止階段(成交或放棄):不再視為進行中,地圖與待辦預設不顯示 */
  readonly isTerminal: boolean;
  /** 出現在看板欄位 */
  readonly showOnBoard: boolean;
  /** 出現在新增 / 編輯表單的下拉 */
  readonly showInForm: boolean;
}

/**
 * 出廠的客戶階段。全部是通用的訪查流程用語,不帶任何產業或商品字眼。
 * 順序就是流程順序:排越後面越接近終點。
 */
export const DEFAULT_DEV_STAGES: readonly DefaultDevStage[] = [
  {
    key: 'lead',
    label: '名單',
    color: 'neutral',
    sortOrder: 10,
    isTerminal: false,
    showOnBoard: true,
    showInForm: true,
  },
  {
    key: 'contacted',
    label: '已接觸',
    color: 'info',
    sortOrder: 20,
    isTerminal: false,
    showOnBoard: true,
    showInForm: true,
  },
  {
    key: 'visited',
    label: '已拜訪',
    color: 'teal',
    sortOrder: 30,
    isTerminal: false,
    showOnBoard: true,
    showInForm: true,
  },
  {
    key: 'quoting',
    label: '報價中',
    color: 'amber',
    sortOrder: 40,
    isTerminal: false,
    showOnBoard: true,
    showInForm: true,
  },
  {
    key: 'interested',
    label: '有意願',
    color: 'purple',
    sortOrder: 50,
    isTerminal: false,
    showOnBoard: true,
    showInForm: true,
  },
  {
    key: 'converted',
    label: '已成交',
    color: 'green',
    sortOrder: 60,
    isTerminal: true,
    showOnBoard: true,
    showInForm: true,
  },
  {
    key: 'dropped',
    label: '無效/放棄',
    color: 'danger',
    sortOrder: 70,
    isTerminal: true,
    showOnBoard: true,
    showInForm: true,
  },
];

export interface DefaultVisitPhotoKind {
  readonly key: string;
  readonly label: string;
  readonly sortOrder: number;
  /** 缺了會擋結案 */
  readonly required: boolean;
  /** 只在這些場所類型要求;空陣列 = 所有場所 */
  readonly placeTypes: readonly string[];
}

/**
 * 出廠的存證照片種類。
 * 標籤刻意用通用詞(門牌、外觀、招牌、內部、環境、物品、其他),
 * 不寫死成某一種行業的場景。
 */
export const DEFAULT_VISIT_PHOTO_KINDS: readonly DefaultVisitPhotoKind[] = [
  {
    key: 'doorplate',
    label: '門牌',
    sortOrder: 10,
    required: true,
    placeTypes: ['store', 'office'],
  },
  {
    key: 'entrance',
    label: '外觀',
    sortOrder: 20,
    required: true,
    placeTypes: ['store', 'office'],
  },
  { key: 'signboard', label: '招牌', sortOrder: 30, required: true, placeTypes: ['office'] },
  { key: 'interior', label: '內部', sortOrder: 40, required: true, placeTypes: ['store'] },
  { key: 'office', label: '環境', sortOrder: 50, required: true, placeTypes: ['office'] },
  { key: 'inventory', label: '物品', sortOrder: 60, required: true, placeTypes: ['store'] },
  { key: 'other', label: '其他', sortOrder: 70, required: false, placeTypes: [] },
];

export interface DefaultPremisesType {
  readonly key: string;
  readonly label: string;
  readonly sortOrder: number;
}

/**
 * 出廠的場所類型。檢查表的「所有場所」就是展開成這幾個。
 *
 * 執行期以 dev_premises_types 為準,這裡只是第一次啟動的 seed 與讀不到主檔時的保底。
 * 照片檢查表是按場所類型分組的,所以場所類型不可設定的話,
 * 「加一種新的現場」這件事在後台完全做不到。
 */
export const DEFAULT_PREMISES_TYPES: readonly DefaultPremisesType[] = [
  { key: 'store', label: '實體店面', sortOrder: 10 },
  { key: 'office', label: '辦公室', sortOrder: 20 },
];

/** 出廠場所類型的代碼,順序同上 */
export const DEFAULT_PLACE_TYPES: readonly string[] = DEFAULT_PREMISES_TYPES.map((p) => p.key);

export interface DefaultCategory {
  readonly key: string;
  readonly label: string;
  readonly sortOrder: number;
}

/**
 * 出廠的商業分類(客戶卡上「分類」那一格的選項)。
 *
 * 這份清單原本寫死在前端的 crm-shared.ts 裡,後台完全改不到 ——
 * 而「前台不得出現寫死的業務用語清單」正是這套系統的產品原則。
 * 現在它跟階段、互動管道、場所類型一樣是可增減的主檔(dev_categories),
 * 這裡只是第一次啟動要塞哪幾筆,以及設定還沒回來時前端的保底值。
 *
 * 標籤刻意用跨行業都講得通的說法,不帶任何一種產業的內部用語:
 * 一間做設備維修的公司可以整組換成自己的分類,後台改就好,不必改程式。
 */
export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { key: 'retail_online', label: '電商/網路商店', sortOrder: 10 },
  { key: 'retail_store', label: '實體零售/門市', sortOrder: 20 },
  { key: 'food_beverage', label: '餐飲/飲料', sortOrder: 30 },
  { key: 'lodging', label: '旅宿/民宿', sortOrder: 40 },
  { key: 'education', label: '教育/補習', sortOrder: 50 },
  { key: 'healthcare', label: '醫療/診所', sortOrder: 60 },
  { key: 'beauty', label: '美業/沙龍', sortOrder: 70 },
  { key: 'events', label: '活動/展演', sortOrder: 80 },
  { key: 'home_service', label: '到府服務', sortOrder: 90 },
  { key: 'wholesale', label: '批發/B2B', sortOrder: 100 },
  { key: 'vehicle', label: '汽機車/維修', sortOrder: 110 },
  { key: 'property', label: '房仲/物業管理', sortOrder: 120 },
  { key: 'logistics', label: '運輸/物流', sortOrder: 130 },
  { key: 'agriculture', label: '生鮮/農漁', sortOrder: 140 },
  { key: 'software', label: '訂閱/軟體服務', sortOrder: 150 },
  { key: 'leisure', label: '休閒/娛樂', sortOrder: 160 },
  { key: 'manufacturing', label: '製造/加工', sortOrder: 170 },
  { key: 'construction', label: '營建/工程', sortOrder: 180 },
  { key: 'nonprofit', label: '公協會/非營利', sortOrder: 190 },
  { key: 'other', label: '其他', sortOrder: 200 },
];

export interface DefaultInteractionChannel {
  readonly key: string;
  readonly label: string;
  readonly sortOrder: number;
}

/**
 * 產品保留的兩個互動管道代碼。理由與階段的保留字相同:它們綁著一段流程,
 * 不只是清單上的一列。
 *   visit:只能由外勤到訪打卡寫入(要 GPS 與照片),手動新增互動一律擋掉。
 *   note :系統紀錄(移交、成交、地址變更)寫的就是這個管道,
 *         也是輸入落不到任何已知管道時的退路。
 * 後台可以改它們的名稱與排序,但不能刪掉,刪掉之後打卡與系統紀錄會寫進一個不存在的管道。
 */
export const VISIT_CHANNEL_KEY = 'visit';
export const NOTE_CHANNEL_KEY = 'note';
export const RESERVED_CHANNEL_KEYS: readonly string[] = [VISIT_CHANNEL_KEY, NOTE_CHANNEL_KEY];

/**
 * 出廠的互動管道。標籤用通用說法,不綁任何一種行業的工作方式:
 * 設備維修公司可以整組換成「工單、現場、電話」,後台改就好,不必改程式。
 */
export const DEFAULT_INTERACTION_CHANNELS: readonly DefaultInteractionChannel[] = [
  { key: 'visit', label: '拜訪', sortOrder: 10 },
  { key: 'call', label: '電話', sortOrder: 20 },
  { key: 'line', label: '通訊軟體', sortOrder: 30 },
  { key: 'email', label: '電子郵件', sortOrder: 40 },
  { key: 'quote', label: '報價', sortOrder: 50 },
  { key: 'note', label: '備註', sortOrder: 60 },
  { key: 'other', label: '其他', sortOrder: 70 },
];

/**
 * 出廠的照片存證檢查表(場所類型 → 必備照片代碼)。
 * 由上面那份清單推導,不另外寫一份 —— 兩份會走散,
 * 症狀是後台看到的必拍項目跟打卡實際擋的不一樣。
 */
export function defaultPhotoChecklist(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const place of DEFAULT_PLACE_TYPES) out[place] = [];
  for (const kind of DEFAULT_VISIT_PHOTO_KINDS) {
    if (!kind.required) continue;
    const targets = kind.placeTypes.length > 0 ? kind.placeTypes : DEFAULT_PLACE_TYPES;
    for (const place of targets) {
      const bucket = out[place] ?? (out[place] = []);
      if (!bucket.includes(kind.key)) bucket.push(kind.key);
    }
  }
  return out;
}
