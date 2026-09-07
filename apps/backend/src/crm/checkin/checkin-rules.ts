/**
 * 打卡存證的純函式規則:haversine 距離、假定位偵測、照片 magic bytes 檢查。
 * 不碰 DB、不碰 Nest,方便單元測試(見 checkin-rules.spec.ts)。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */

import { DEFAULT_VISIT_PHOTO_KINDS, defaultPhotoChecklist } from '@mitchcrm/shared';
// 地球半徑只有一份(見 common/geo.ts):打卡頁與地圖頁算出來的公尺數必須一致
import { EARTH_RADIUS_M } from '../../common/geo';

export const SUSPICIOUS_ACCURACY_M = 300;
export const SUSPICIOUS_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const SUSPICIOUS_SPEED_KMH = 120;
export const SUSPICIOUS_PREV_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SUSPICIOUS_DISTANCE_M = 1500;
export const PHOTO_MAX_BYTES = 600 * 1024;

/** 系統紀錄的前綴符號:互動 note 以此開頭代表是系統寫的(移交、成交、合併、地址變更),使用者不能自己打 */
export const SYSTEM_NOTE_PREFIX = '【';

/** 去掉 Unicode Cf 類(零寬空白、零寬連接、方向控制、BOM 等)字元與前後空白,再判斷開頭用 */
export function stripInvisible(note: unknown): string {
  return (note ?? '')
    .toString()
    .replace(/\p{Cf}/gu, '')
    .trim();
}

/**
 * 使用者手動輸入的備註是否誤用了系統前綴「【」(去除零寬字元與空白後判斷)。
 * 手動互動(crm.service)與拜訪打卡(crm-checkin.service)共用同一份規則。
 * 違規回錯誤訊息;正常回 null。
 */
export function systemPrefixBlockReason(note: unknown): string | null {
  if (stripInvisible(note).startsWith(SYSTEM_NOTE_PREFIX))
    return '備註不可以【開頭,此符號保留給系統紀錄';
  return null;
}

/** ISO 8601 字串是否帶時區資訊(結尾 Z 或 ±hh:mm / ±hhmm);純日期或本地時間一律 false */
export function hasTimezone(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  // 一定要有 T 時間部分,偏移才算數;否則純日期「2026-09-02」的「-02」會被誤認成 -02 時區
  return /T[\d:.]+(Z|[+-]\d{2}(:?\d{2})?)$/i.test(s.trim());
}

/** 地址變更 / 合併 / 新建客戶的可疑判定視窗(24 小時) */
export const ADDRESS_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REASON_ADDRESS_CHANGED = '客戶地址於 24 小時內變更';
export const REASON_MERGED = '客戶於 24 小時內合併';

/**
 * 客戶沒有座標時的留痕。這句本身**不算可疑**,它只是說明這一次為什麼沒有距離可比。
 *
 * ── 為什麼「新建客戶尚無座標」不再算可疑(2026-09-05 修)────────────────
 * 舊版在「客戶建檔不到 24 小時而且還沒有座標」時另外加一條可疑理由,
 * 結果寫進資料庫的是這樣一串:
 *
 *   gps_suspicious_reason = 客戶尚無座標,未比對距離,新建客戶尚無座標
 *
 * 同一件事講了兩次,而且那個條件在出廠設定下**必然成立**:地理編碼預設不啟用,
 * 新建的客戶不會有座標,所以每一位新客戶的第一次到訪都會被標記可疑。
 * 假定位偵測對每一筆新客戶都亮紅燈,主管很快就學會忽略它,連真的異常也一起忽略。
 *
 * 就算把地理編碼打開也一樣:編碼是背景排程,剛建好的客戶本來就還沒有座標。
 * 也就是說這一條抓到的永遠是「正常的新客戶」,不是造假 —— 它不是門檻設錯,
 * 是判準本身不成立,所以整條拿掉,不是調參數。
 *
 * 真正的兩條規則留著:24 小時內【地址變更】或【合併】。那兩件事是有人在既有客戶上
 * 動了手腳之後才會出現的,而且時間點就在打卡前後,是有意義的訊號。
 */
export const NOTE_NO_COORDINATE = '客戶尚無座標,未比對距離';

/**
 * 24 小時規則(不看 geocodedAt):任一成立就 suspicious=true,理由各一句:
 * - 24 小時內有【地址變更】互動 → 「客戶地址於 24 小時內變更」(有沒有座標都算,座標可能是新地址剛編好的)
 * - 24 小時內有【合併】互動 → 「客戶於 24 小時內合併」
 * 客戶沒座標時另加一句 NOTE_NO_COORDINATE 留痕,這句本身不算可疑。
 *
 * createdAt 與 serverTime 仍留在輸入形狀裡而目前沒有被讀:呼叫端
 * (crm-checkin.service)照舊把兩個值傳進來,拿掉會讓那邊的物件字面值多出屬性
 * 而編譯不過。兩個值在同一個判斷裡本來就是一組(「建檔多久了」),
 * 日後要加回任何一條跟建檔時間有關的規則時,不必再改一次呼叫端。
 */
export function noCoordinateVerdict(input: {
  hasCoordinate: boolean;
  createdAt: Date;
  addressChangedRecently: boolean;
  mergedRecently: boolean;
  serverTime: Date;
}): { suspicious: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!input.hasCoordinate) notes.push(NOTE_NO_COORDINATE);
  const reasons: string[] = [];
  if (input.addressChangedRecently) reasons.push(REASON_ADDRESS_CHANGED);
  if (input.mergedRecently) reasons.push(REASON_MERGED);
  return { suspicious: reasons.length > 0, notes: [...notes, ...reasons] };
}

/** 打卡互動 note 最後一行:這次拿來比對距離的客戶地址(pickAddress 正規化結果) */
export const COMPARE_ADDRESS_LINE_PREFIX = '比對地址:';

/**
 * 把比對地址附在使用者備註後面(自成一行);備註空就只寫這行;沒有可用地址就寫「(無)」。
 * 回傳字串永遠非空,所以打卡互動一定有 note。
 */
export function appendCompareAddress(
  note: string | null | undefined,
  compareAddress: string,
): string {
  const line = `${COMPARE_ADDRESS_LINE_PREFIX}${compareAddress || '(無)'}`;
  const body = (note ?? '').trim();
  return body ? `${body}\n${line}` : line;
}

/** 兩點大圓距離(公尺),四捨五入到整數 */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a))));
}

/** 座標小數位數(用字串判斷,避免浮點誤差;整數視為 0 位) */
export function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  if (s.includes('e-')) {
    // 1e-7 這種科學記號:指數就是小數位數(加上尾數本身的小數位)
    const [mant = '', exp = '0'] = s.split('e-');
    const mantDec = mant.includes('.') ? mant.length - mant.indexOf('.') - 1 : 0;
    return Number(exp) + mantDec;
  }
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export interface SuspicionInput {
  lat: number;
  lng: number;
  accuracy?: number | null;
  /** 客戶端送來的時間(ISO 字串已解析) */
  clientTime: Date;
  /** 伺服器收到請求的時間 */
  serverTime: Date;
  /** 同一使用者最近一次有 GPS 的互動(可為 null) */
  prev?: { lat: number; lng: number; occurredAt: Date } | null;
  /** 與客戶地址的距離(公尺);客戶沒座標就 null */
  distanceM?: number | null;
}

export interface SuspicionResult {
  suspicious: boolean;
  reason: string | null;
  /** 與上一筆換算出的速度(km/h);算不出來就 null,方便測試與除錯 */
  speedKmh: number | null;
}

/**
 * 假定位偵測:命中任一條就 suspicious=true,理由用中文逗號串起來。
 * 只標記不阻擋 —— 記錄照常寫入,由主管在「最近打卡」清單判斷。
 */
export function detectSuspicion(input: SuspicionInput): SuspicionResult {
  const reasons: string[] = [];

  if (typeof input.accuracy === 'number' && input.accuracy > SUSPICIOUS_ACCURACY_M) {
    reasons.push(`定位精度過差(${Math.round(input.accuracy)} 公尺)`);
  }

  const skewMs = Math.abs(input.serverTime.getTime() - input.clientTime.getTime());
  if (!Number.isFinite(skewMs) || skewMs > SUSPICIOUS_CLOCK_SKEW_MS) {
    reasons.push(`手機時間與伺服器相差 ${Math.round(skewMs / 60000)} 分鐘`);
  }

  if (input.lat === 0 && input.lng === 0) {
    reasons.push('座標為 (0,0)');
  } else if (decimalPlaces(input.lat) <= 2 || decimalPlaces(input.lng) <= 2) {
    reasons.push('座標過於整齊(小數位數不足)');
  }

  let speedKmh: number | null = null;
  if (input.prev) {
    const dtMs = input.serverTime.getTime() - input.prev.occurredAt.getTime();
    if (dtMs > 0 && dtMs <= SUSPICIOUS_PREV_WINDOW_MS) {
      const dM = haversineM(input.prev.lat, input.prev.lng, input.lat, input.lng);
      speedKmh = dM / 1000 / (dtMs / 3_600_000);
      if (speedKmh > SUSPICIOUS_SPEED_KMH) {
        reasons.push(`與上一筆打卡換算移動速度 ${Math.round(speedKmh)} km/h`);
      }
    }
  }

  if (typeof input.distanceM === 'number' && input.distanceM > SUSPICIOUS_DISTANCE_M) {
    reasons.push(`距離客戶地址 ${input.distanceM} 公尺`);
  }

  return {
    suspicious: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(',') : null,
    speedKmh,
  };
}

/** 檔頭 magic bytes 是否符合宣告的 mime */
export function matchesMagic(mime: string, buf: Uint8Array): boolean {
  switch (mime) {
    case 'image/jpeg':
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png':
      return (
        buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      );
    case 'image/webp':
      return (
        buf.length >= 12 &&
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 && // RIFF
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50 // WEBP
      );
    default:
      return false;
  }
}

/** 去掉 data URL 前綴與空白,回傳純 base64 */
export function stripBase64(s: string): string {
  const comma = s.indexOf(',');
  const body = s.startsWith('data:') && comma >= 0 ? s.slice(comma + 1) : s;
  return body.replace(/\s+/g, '');
}

/**
 * 存證照片類型。
 *
 * 類型本身已經改成可設定的資料表(visit_photo_kinds),所以這裡是 string 而不是聯集型別 ——
 * 寫死聯集的話,後台新增的類型會在型別層就被擋掉,而且錯誤訊息看不出原因。
 * 下面這份出廠清單只當「還沒讀到資料表時的預設標籤」。
 */
export type VisitPhotoKindValue = string;

/** 照片類型顯示名(讀不到資料表時的 fallback;正式的顯示名以 visit_photo_kinds.label 為準) */
export const VISIT_PHOTO_KIND_LABEL: Record<string, string> = Object.fromEntries(
  DEFAULT_VISIT_PHOTO_KINDS.map((k) => [k.key, k.label]),
);

/**
 * 照片存證檢查表:場所類型 → 必備的照片類型代碼。
 * 出廠預設在這裡,實際採用的那一份存在系統設定(SystemSettingsData.photoChecklist),
 * 由後台維護。呼叫端讀不到設定就用這一份,行為與可設定之前一致。
 */
export type PhotoChecklist = Record<string, readonly string[]>;

/**
 * 出廠預設由 @mitchcrm/shared 的照片種類清單推導(哪一種在哪些場所必拍),
 * 不在這裡另抄一份 —— 兩份會走散,症狀是後台看到的必拍項目
 * 跟打卡實際擋下來的不一樣,而畫面上看不出原因。
 */
export const DEFAULT_PHOTO_CHECKLIST: PhotoChecklist = defaultPhotoChecklist();

/** 一次上傳最多張數與總量上限 */
export const PHOTOS_MAX_COUNT = 8;
export const PHOTOS_TOTAL_MAX_BYTES = 3 * 1024 * 1024;

/** 每位客戶累計存證照片上限:張數與總位元組(含歷史所有互動掛的照片) */
export const CUSTOMER_PHOTOS_MAX_COUNT = 40;
export const CUSTOMER_PHOTOS_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 每位使用者每天(組織時區的日曆日)可以上傳的存證照片總位元組。
 *
 * 為什麼需要這一層:前面三層額度(每張 600KB / 每批 3MB / 每客戶 20MB)全部是
 * **以客戶為單位**的,而建客戶只吃預設的請求額度。也就是說一個登入帳號可以
 * 一直建新客戶,每個客戶各塞 20MB,總量沒有任何上限:
 * 上傳端點每 IP 每分鐘 10 次、每次 3MB,一分鐘穩定寫入 30MB,約 43GB/天。
 * 照片存在 Postgres 的 bytea 裡,而刪除路徑對已結案客戶是擋住的,
 * 清到最後要 DBA 進場。
 *
 * 100MB 怎麼來的:實務上一次拜訪拍滿 8 張是 4.8MB,一天跑 10 家約 48MB。
 * 100MB 對真的在外面跑的人有兩倍餘裕,對「拿帳號當免費儲存空間」的人
 * 則是把 43GB/天壓成 0.1GB/天。要調整的部署方改這一個常數就好。
 */
export const USER_DAILY_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * 這位使用者今天還裝不裝得下這一批。回 null 表示可以,否則回中文錯誤訊息。
 *
 * 判準與客戶配額一致:既有 + 這一批 > 上限就擋,而不是「已經超過才擋」——
 * 後者等於每天最後一批一定能寫進去,上限就不是上限。
 */
export function userDailyUploadQuotaError(
  existingBytes: number,
  incomingBytes: number,
): string | null {
  if (existingBytes + incomingBytes > USER_DAILY_UPLOAD_MAX_BYTES) {
    const mb = Math.round(USER_DAILY_UPLOAD_MAX_BYTES / (1024 * 1024));
    return `你今天上傳的存證照片總量已達 ${mb}MB 上限,請明天再繼續;確有需要請洽系統管理員`;
  }
  return null;
}

/** 照片拍攝時間允許與伺服器時間相差的範圍(±24 小時);超出視為異常 */
export const TAKEN_AT_MAX_SKEW_MS = 24 * 60 * 60 * 1000;

/** 拍攝時間是否落在伺服器時間 ±24 小時內;無效日期一律 false */
export function isTakenAtWithinRange(takenAt: Date, serverTime: Date): boolean {
  const t = takenAt.getTime();
  const s = serverTime.getTime();
  if (!Number.isFinite(t) || !Number.isFinite(s)) return false;
  return Math.abs(t - s) <= TAKEN_AT_MAX_SKEW_MS;
}

/**
 * 這位客戶目前的存證照片有沒有「已經超過」上限,超過多少。
 *
 * ── 為什麼會有超過上限這種狀態 ──────────────────────────────────
 * 所有寫入路徑(打卡、補拍)判的都是「既有 + 這一批 > 上限就擋」,所以走正常
 * 上傳最多只會停在剛好等於上限,不可能超過。真正會超過的只有一條路:
 * 查重合併。合併是把兩筆重複建檔的客戶併回一筆,照片整批搬到保留的那一筆
 * (見 crm/duplicates/crm-duplicates.service.ts 的 mergeOnce),
 * 兩筆各 30 張併完就是 60 張。
 *
 * 合併本身刻意不擋:合併的用途就是修正重複建檔,擋掉的話資料永遠修不乾淨。
 * 代價是保留筆會處在超額狀態,而超額狀態必須看得見、講得出原因 ——
 * 這一支就是那個判斷,前端的說明、補拍被擋的訊息、已結案客戶能不能刪照片
 * 三處都吃它,不各自再寫一份比較。
 *
 * 判準是嚴格大於(> 而不是 ≥):剛好等於上限是正常的滿額,不是超額。
 */
export function customerPhotoOverQuota(existing: { count: number; bytes: number }): {
  over: boolean;
  overCount: number;
  overBytes: number;
} {
  const overCount = Math.max(0, existing.count - CUSTOMER_PHOTOS_MAX_COUNT);
  const overBytes = Math.max(0, existing.bytes - CUSTOMER_PHOTOS_MAX_BYTES);
  return { over: overCount > 0 || overBytes > 0, overCount, overBytes };
}

/** 位元組數寫成給人看的 MB(一位小數) */
function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * 超額狀態的說明文字,給客戶卡的存證照片區顯示;沒超額回 null。
 *
 * 要說三件事:現在是多少、為什麼會這樣(合併,不是使用者拍太多)、
 * 接下來會發生什麼(新的補拍會被擋)。只寫「超過上限」而不寫原因的話,
 * 使用者會以為是自己操作錯誤。
 */
export function customerPhotoOverQuotaNotice(existing: {
  count: number;
  bytes: number;
}): string | null {
  const o = customerPhotoOverQuota(existing);
  if (!o.over) return null;
  const parts: string[] = [];
  if (o.overCount > 0) {
    parts.push(`張數 ${existing.count} 張,超過上限 ${CUSTOMER_PHOTOS_MAX_COUNT} 張`);
  }
  if (o.overBytes > 0) {
    parts.push(`總量 ${mb(existing.bytes)}MB,超過上限 ${mb(CUSTOMER_PHOTOS_MAX_BYTES)}MB`);
  }
  return (
    `這位客戶的存證照片${parts.join(';')}。` +
    '超額是查重合併把兩筆重複客戶的照片併到這一筆造成的,不是拍太多。' +
    '在刪回上限以內之前,新的補拍會被擋下來;請刪掉重複或不需要的照片。'
  );
}

/**
 * 客戶累計照片是否還裝得下這批:既有張數 + 新增張數 ≤ 40,既有總量 + 新增總量 ≤ 20MB。
 * 回 null 表示可以;否則回中文錯誤訊息(由 service 包成 400)。
 *
 * 已經超額(只可能來自查重合併)時走另一組訊息:原本那句「已達上限,請先刪除
 * 不需要的照片」對超額的客戶是誤導 —— 使用者沒有拍那麼多張,而且如果那位客戶
 * 已經結案,刪除路徑以前是整個擋住的,兩句話湊起來等於「請去做一件做不到的事」。
 * 超額時要說得出真正的原因,並指出真的走得通的下一步。
 */
export function customerPhotoQuotaError(
  existing: { count: number; bytes: number },
  incoming: { count: number; bytes: number },
): string | null {
  const o = customerPhotoOverQuota(existing);
  if (o.overCount > 0) {
    return (
      `此客戶目前有 ${existing.count} 張存證照片,已超過每位客戶 ${CUSTOMER_PHOTOS_MAX_COUNT} 張的上限 ` +
      `${o.overCount} 張。這是查重合併把兩筆客戶的照片併在一起造成的,不是這次上傳太多。` +
      `請先到客戶卡的存證照片區刪掉重複或不需要的照片,刪到 ${CUSTOMER_PHOTOS_MAX_COUNT} 張以內就能繼續補拍` +
      '(這位客戶即使已結案也允許刪除,刪除會留在時間軸上)'
    );
  }
  if (o.overBytes > 0) {
    return (
      `此客戶目前的存證照片共 ${mb(existing.bytes)}MB,已超過每位客戶 ${mb(CUSTOMER_PHOTOS_MAX_BYTES)}MB 的上限。` +
      '這是查重合併把兩筆客戶的照片併在一起造成的,不是這次上傳太多。' +
      `請先到客戶卡的存證照片區刪掉重複或不需要的照片,刪到 ${mb(CUSTOMER_PHOTOS_MAX_BYTES)}MB 以內就能繼續補拍` +
      '(這位客戶即使已結案也允許刪除,刪除會留在時間軸上)'
    );
  }
  if (existing.count + incoming.count > CUSTOMER_PHOTOS_MAX_COUNT) {
    return `此客戶存證照片已達 ${CUSTOMER_PHOTOS_MAX_COUNT} 張上限,請先刪除不需要的照片`;
  }
  if (existing.bytes + incoming.bytes > CUSTOMER_PHOTOS_MAX_BYTES) {
    return '此客戶存證照片總量已達 20MB 上限,請先刪除不需要的照片';
  }
  return null;
}

/**
 * 這個場所類型在檢查表裡有沒有「必拍至少一項」。
 *
 * 為什麼要單獨一支:requiredPhotoKinds 回空陣列有兩種意思 ——
 * 「這個場所不用拍」與「這個場所根本還沒設定」。這一支只回答其中一半
 * (「有沒有必拍項目」),兩種意思的分辨交給 photoRequirementState。
 */
export function hasPhotoRequirement(
  premisesType: string | null | undefined,
  checklist: PhotoChecklist = DEFAULT_PHOTO_CHECKLIST,
): boolean {
  return requiredPhotoKinds(premisesType, checklist).length > 0;
}

/**
 * 一個場所類型的照片存證狀態,三選一。
 *
 *   required   有必拍項目 → 照常檢查缺件
 *   exempt     管理員明確勾了「這個場所不需照片存證」→ 放行
 *   unset      沒有必拍項目,也沒有被勾豁免 → 擋下並指路到後台
 *
 * 為什麼一定要分出 exempt 與 unset:上一版把「必拍清單為空」一律當成 unset 擋下來,
 * 擋住的確實是真正的漏洞(新增場所忘了設必拍,那些客戶零張照片就能成交),
 * 但副作用是後台**設不出**一個真的不用拍的場所類型 —— 管理員把必拍全部取消掉,
 * 系統仍然說「尚未設定」。同一個空陣列被拿來表示兩件事,就一定會有一邊做不到。
 * 所以豁免改成一份明確的清單(SystemSettingsData.photoExemptPremises),
 * 空陣列從此只代表「還沒設定」。
 *
 * 未填場所類型不在這三種裡:那是客戶資料本身的缺漏,由呼叫端先擋。
 */
export type PhotoRequirementState = 'required' | 'exempt' | 'unset';

export function photoRequirementState(
  premisesType: string | null | undefined,
  checklist: PhotoChecklist = DEFAULT_PHOTO_CHECKLIST,
  exemptPremises: readonly string[] = [],
): PhotoRequirementState {
  if (hasPhotoRequirement(premisesType, checklist)) return 'required';
  // 豁免只在「沒有必拍項目」時才有意義。兩邊都設了的話以必拍為準:
  // 那是管理員在同一組設定裡自相矛盾,擋下來比安靜放行安全
  if (premisesType && exemptPremises.includes(premisesType)) return 'exempt';
  return 'unset';
}

/**
 * 依場所類型回必備照片清單。清單來自檢查表設定,沒帶就用出廠預設。
 * 未填場所類型、或檢查表裡沒有這一種場所 → 空陣列(由呼叫端另回 premisesTypeMissing)。
 */
export function requiredPhotoKinds(
  premisesType: string | null | undefined,
  checklist: PhotoChecklist = DEFAULT_PHOTO_CHECKLIST,
): VisitPhotoKindValue[] {
  if (!premisesType) return [];
  const list = checklist[premisesType];
  return Array.isArray(list) ? [...list] : [];
}

/** 必備清單扣掉已有的類型,保持必備清單順序;premisesType 未填時一律 [](由呼叫端另回 premisesTypeMissing) */
export function missingPhotoKinds(
  premisesType: string | null | undefined,
  kindsPresent: Iterable<string>,
  checklist: PhotoChecklist = DEFAULT_PHOTO_CHECKLIST,
): VisitPhotoKindValue[] {
  const present = new Set<string>(kindsPresent);
  return requiredPhotoKinds(premisesType, checklist).filter((k) => !present.has(k));
}
