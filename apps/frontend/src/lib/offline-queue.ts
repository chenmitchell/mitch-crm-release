// ref:3687 mc/陳彥輔/米球®

// 外勤「待送出」佇列(IndexedDB)。
//
// ── 這一支在救哪一件事 ──────────────────────────────────────────────
// 打卡與存證照片原本只存在 React state 裡。技師在地下室機房拍完三張照、按送出、
// 失敗,畫面留著預覽 —— 然後他關掉分頁,或系統為了回收記憶體把分頁殺掉,
// 那三張照片就沒了。他已經離開那個座標,補拍不回來。
// 這一支把「還沒送出去的東西」寫進裝置的 IndexedDB,分頁關掉、手機重開都還在。
//
// ── 為什麼是 IndexedDB 不是 localStorage ────────────────────────────
// localStorage 只吃字串、多數瀏覽器上限約 5MB,而且是同步 API:一張壓過浮水印的
// 照片 base64 就 400KB 上下,一次打卡最多八張,寫進去會直接爆掉配額,
// 而且同步寫大字串會把主執行緒卡住。IndexedDB 沒有這兩個問題。
//
// ── 這一支不做什麼 ──────────────────────────────────────────────────
// 不註冊 service worker,所以「完全沒開過的頁面」在離線時還是打不開。
// 這裡處理的是「頁面已經開著、送出失敗」那一段,那是外勤真正會遇到的情況。
//
// ── 共用裝置與登出 ──────────────────────────────────────────────────
// 佇列的資料**故意**活過分頁關閉:活不下來就重送不掉,那正是這一支存在的理由。
// 代價是它也活過登出 —— 待送出裡有存證照片的 base64(最多 24MB)、GPS 座標、
// 客戶名稱與備註,在共用平板上會留在 IndexedDB 最多 7 天,拿到那台裝置的人
// 開開發者工具就看得到。ownerKey 擋得住「被下一個人送出去、掛在他名下」,
// 擋不住「被下一個人看到」。
// 所以登出時要問:這台裝置上還有幾筆你的待送出,要現在清掉嗎。
// 預設不自動清:自動清等於在使用者不知情的狀況下丟掉他現場拍的照片,
// 那些照片補不回來(他已經離開那個座標)。決定權留給人,見 removeOwnerPending。
//
// ── 三個必須處理的邊界 ──────────────────────────────────────────────
// 1. 配額:瀏覽器的儲存空間是有限的,而且 iOS Safari 會在空間吃緊時整個清掉。
//    寫入前先擋筆數與總量,寫入時再接 QuotaExceededError,兩層都要有中文說明。
// 2. 過期:超過 QUEUE_TTL_MS(7 天)的自動清掉,不要讓半年前的東西留在裝置上。
// 3. 換帳號:每一筆都帶 ownerKey。列出與重送都只看目前登入者自己的那些,
//    不然共用裝置上 A 的打卡會被 B 送出去,而且是掛在 B 的名下。
//
// ── 拍攝時間不准改 ──────────────────────────────────────────────────
// 後端驗照片的 takenAt 必須落在**伺服器時間 ±24 小時**內
// (apps/backend/src/crm/checkin/checkin-rules.ts 的 TAKEN_AT_MAX_SKEW_MS)。
// 佇列一律保留原始拍攝時間,不會在重送時改寫成「現在」—— 改寫等於偽造存證。
// 代價是超過 24 小時的照片伺服器會擋下來,所以這一支算得出每一筆的「可重送到什麼時候」,
// 讓畫面提早講清楚,而不是等使用者按了才吃一個看不懂的 400。

/** 佇列裡的一張照片。欄位與後端 CheckinPhotoDto 一致 */
export interface QueuedPhoto {
  kind: string;
  mime: 'image/jpeg';
  base64: string;
  /** 原始拍攝時間(ISO,含時區)。重送時原樣送出,不改寫 */
  takenAt: string;
}

/** checkin = 一整筆到訪打卡;photos = 客戶卡上的單張補拍 */
export type QueuedKind = 'checkin' | 'photos';

/** 放進佇列時呼叫端要給的東西 */
export interface QueuedItemInput {
  type: QueuedKind;
  customerId: string;
  /** 只為了畫面上講得出是哪一家,不送後端 */
  customerName: string;
  /** 當初真的站在現場按下去的時間(ISO,含時區)。重送時當 clientTime 原樣送出 */
  capturedAt: string;
  /** 座標。補拍照片時可能沒有定位(後端那一支的 lat/lng 是選填),所以允許 null */
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  note?: string;
  photos: QueuedPhoto[];
}

/** 存在 IndexedDB 裡的一筆 */
export interface QueuedItem extends QueuedItemInput {
  id: string;
  /** 這一筆屬於哪個帳號(見 ownerKeyOf)。重送只送自己的 */
  ownerKey: string;
  /** 進佇列的時間(毫秒)。過期看這個,不看 capturedAt */
  queuedAt: number;
  /** 重送過幾次 */
  attempts: number;
  /** 最後一次重送失敗的原因(中文),沒有就 null */
  lastError: string | null;
}

/** 佇列保留多久:7 天,之後自動清掉 */
export const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 照片還能被伺服器接受多久:24 小時。
 * 這個數字對應後端 checkin-rules.ts 的 TAKEN_AT_MAX_SKEW_MS,兩邊要一起改。
 */
export const PHOTO_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 剩不到這麼久就開始催(畫面上換一種說法) */
export const RESEND_SOON_MS = 2 * 60 * 60 * 1000;
/** 佇列最多幾筆 */
export const MAX_QUEUED_ITEMS = 20;
/** 佇列總量上限(bytes)。一筆打卡最多 3MB 照片,抓 24MB 約等於八筆滿載 */
export const MAX_QUEUED_BYTES = 24 * 1024 * 1024;

const DB_NAME = 'mitchcrm-offline';
const DB_VERSION = 1;
const STORE = 'pending-submissions';
const OWNER_INDEX = 'ownerKey';

// ---------------------------------------------------------------------------
// 純函式(不碰 IndexedDB,可以直接在 node 裡測)
// ---------------------------------------------------------------------------

/**
 * 這一筆佔多少 bytes(估算)。
 * base64 每 4 個字代表 3 bytes,再加一點欄位本身的量。
 * 只用來擋配額,不必精準,但寧可高估不要低估。
 */
export function itemBytes(item: Pick<QueuedItem, 'photos' | 'note'>): number {
  let n = 512;
  for (const p of item.photos) n += Math.ceil((p.base64.length * 3) / 4) + 128;
  n += (item.note?.length ?? 0) * 3;
  return n;
}

/** 佇列總量 */
export function totalBytes(items: readonly QueuedItem[]): number {
  return items.reduce((s, it) => s + itemBytes(it), 0);
}

/** 超過保留期限了嗎(7 天,看 queuedAt) */
export function isExpired(item: Pick<QueuedItem, 'queuedAt'>, now: number): boolean {
  return now - item.queuedAt > QUEUE_TTL_MS;
}

/**
 * 這一筆最早的那張照片是什麼時候拍的。
 * 沒有照片就回 null —— 沒有照片的打卡不受 ±24 小時規則限制。
 * 拍攝時間解析不出來的那張直接跳過:它送出去本來就會被後端擋下,
 * 但不該因為它算不出來就讓整筆看起來「還來得及」。
 */
export function earliestPhotoAt(item: Pick<QueuedItem, 'photos'>): number | null {
  let min: number | null = null;
  for (const p of item.photos) {
    const t = Date.parse(p.takenAt);
    if (!Number.isFinite(t)) continue;
    if (min === null || t < min) min = t;
  }
  return min;
}

/**
 * 這一筆最晚可以重送到什麼時候(毫秒)。沒有照片就回 null(沒有期限)。
 * 依據是後端的「照片拍攝時間與伺服器時間相差不得超過 24 小時」。
 */
export function resendDeadline(item: Pick<QueuedItem, 'photos'>): number | null {
  const earliest = earliestPhotoAt(item);
  return earliest === null ? null : earliest + PHOTO_RESEND_WINDOW_MS;
}

/**
 * ok      還來得及
 * soon    剩不到兩小時,畫面要催
 * lapsed  照片拍攝時間已經超過 24 小時,伺服器一定會擋。這一筆不要再送,
 *         但也不自動刪 —— 東西是使用者的,刪不刪由他決定
 */
export type ResendWindow = 'ok' | 'soon' | 'lapsed';

export function resendWindow(item: Pick<QueuedItem, 'photos'>, now: number): ResendWindow {
  const deadline = resendDeadline(item);
  if (deadline === null) return 'ok';
  if (now >= deadline) return 'lapsed';
  return deadline - now <= RESEND_SOON_MS ? 'soon' : 'ok';
}

/** 放不進去的原因 */
export type AdmitReason = 'too-many' | 'too-large' | 'photo-lapsed';

export interface AdmitResult {
  ok: boolean;
  reason?: AdmitReason;
  /** 給使用者看的中文,說得出「為什麼」與「現在該做什麼」 */
  message?: string;
}

/**
 * 能不能再放一筆進佇列。純判斷,不寫入。
 * 呼叫端拿到 ok:false 時要把 message 原樣顯示,不要自己另外編一句。
 */
export function admit(
  existing: readonly QueuedItem[],
  incoming: Pick<QueuedItem, 'photos' | 'note'>,
  now: number,
): AdmitResult {
  if (existing.length >= MAX_QUEUED_ITEMS) {
    return {
      ok: false,
      reason: 'too-many',
      message: `裝置上的待送出已經有 ${MAX_QUEUED_ITEMS} 筆,存不下這一筆。請先回到有網路的地方重送,或刪掉不要的那幾筆。`,
    };
  }
  const incomingBytes = itemBytes(incoming);
  if (totalBytes(existing) + incomingBytes > MAX_QUEUED_BYTES) {
    const mb = Math.round(MAX_QUEUED_BYTES / (1024 * 1024));
    return {
      ok: false,
      reason: 'too-large',
      message: `裝置上的待送出照片總量已達 ${mb}MB 上限,存不下這一筆。請先回到有網路的地方重送,或刪掉不要的那幾筆。`,
    };
  }
  const w = resendWindow(incoming, now);
  if (w === 'lapsed') {
    return {
      ok: false,
      reason: 'photo-lapsed',
      message: '這些照片的拍攝時間已超過 24 小時,伺服器不會接受,存進待送出也沒有用。請重新拍攝。',
    };
  }
  return { ok: true };
}

/**
 * 這一筆屬於哪個帳號。
 *
 * 優先用 sub(權杖裡的使用者 id);沒有就退到 Email 小寫。
 * 兩個都沒有時回空字串,呼叫端要當成「還不知道是誰」而**不寫入**——
 * 沒有 ownerKey 的資料在共用裝置上會被下一個人送出去,掛在他名下。
 */
export function ownerKeyOf(me: { sub?: string; email?: string } | null | undefined): string {
  if (!me) return '';
  const sub = typeof me.sub === 'string' ? me.sub.trim() : '';
  if (sub) return sub;
  const email = typeof me.email === 'string' ? me.email.trim().toLowerCase() : '';
  return email;
}

/**
 * 重送時要送出去的備註。
 *
 * 原始的 clientTime(當初站在現場的時間)照送,不改寫成「現在」。後端對
 * 「手機時間與伺服器相差超過 5 分鐘」會標記待主管確認 —— 對一筆離線補送的打卡來說,
 * 被標記本來就是對的,主管應該看到它。但那句系統理由講的是時鐘偏差,
 * 主管看了會以為技師改過手機時間,所以這裡在備註裡把真正的原因寫清楚。
 * 備註上限 500 字,超過就先截原本的內容,系統那一行一定保留。
 */
export function noteWithOfflineMark(note: string | undefined, resentAtLabel: string): string {
  const mark = `(離線待送出,於 ${resentAtLabel} 補送)`;
  const base = (note ?? '').trim();
  if (!base) return mark;
  const room = 500 - mark.length - 1;
  const head = room > 0 ? base.slice(0, room) : '';
  return head ? `${head} ${mark}` : mark;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

/** 這個瀏覽器能不能用佇列(無痕視窗的部分瀏覽器會關掉 IndexedDB) */
export function queueSupported(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(OWNER_INDEX, 'ownerKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
    // 使用者在另一個分頁清掉了資料庫、或版本被擋住:當成不支援,不要無限等
    req.onblocked = () => reject(new Error('indexeddb blocked'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** 讀出全部(含別的帳號的)。內部用,對外一律走 listPending */
async function readAll(): Promise<QueuedItem[]> {
  const db = await openDb();
  const rows = await promisify(tx(db, 'readonly').getAll() as IDBRequest<QueuedItem[]>);
  return Array.isArray(rows) ? rows : [];
}

async function deleteIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const store = tx(db, 'readwrite');
  await Promise.all(
    ids.map((id) => promisify(store.delete(id) as unknown as IDBRequest<undefined>)),
  );
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `q-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ListResult {
  /** 目前登入者自己的待送出,新的在前 */
  items: QueuedItem[];
  /** 這次順手清掉了幾筆過期的(含別的帳號的) */
  pruned: number;
  /** 裝置上還有幾筆是別的帳號的。畫面要講出來,但一個字的內容都不顯示 */
  othersCount: number;
  /** 佇列讀不出來(不支援 / 被停用),畫面要降級但不要當成「沒有待送出」 */
  unavailable: boolean;
}

const EMPTY_LIST: ListResult = { items: [], pruned: 0, othersCount: 0, unavailable: true };

/**
 * 列出目前登入者的待送出,順便清掉過期的。
 *
 * 過期清理連別的帳號的一起清:那是這台裝置上的垃圾,留著只會佔配額。
 * 但**沒過期**的別人資料一筆都不動,也不顯示內容,只回一個數字。
 */
export async function listPending(ownerKey: string, now: number): Promise<ListResult> {
  if (!queueSupported()) return EMPTY_LIST;
  try {
    const all = await readAll();
    const expired = all.filter((it) => isExpired(it, now));
    if (expired.length > 0) await deleteIds(expired.map((it) => it.id));
    const live = all.filter((it) => !isExpired(it, now));
    const mine = live.filter((it) => it.ownerKey === ownerKey && ownerKey !== '');
    mine.sort((a, b) => b.queuedAt - a.queuedAt);
    return {
      items: mine,
      pruned: expired.length,
      othersCount: live.length - mine.length,
      unavailable: false,
    };
  } catch {
    return EMPTY_LIST;
  }
}

export type EnqueueResult =
  | { ok: true; item: QueuedItem }
  | {
      ok: false;
      reason: AdmitReason | 'unsupported' | 'no-owner' | 'quota' | 'failed';
      message: string;
    };

/**
 * 放一筆進佇列。
 *
 * 兩層配額:先用 admit() 擋筆數與總量,再接瀏覽器真的丟出來的 QuotaExceededError
 * (使用者裝置上的空間是所有網站共用的,我們自己的上限沒到不代表寫得進去)。
 */
export async function enqueue(
  ownerKey: string,
  input: QueuedItemInput,
  now: number,
): Promise<EnqueueResult> {
  if (!queueSupported()) {
    return {
      ok: false,
      reason: 'unsupported',
      message:
        '這個瀏覽器不支援離線暫存(無痕視窗常常會關掉),照片沒有存下來。請不要關閉這個分頁,回到有網路的地方再送出一次。',
    };
  }
  if (!ownerKey) {
    return {
      ok: false,
      reason: 'no-owner',
      message:
        '目前無法確認登入身分,為避免把資料掛到別人名下,沒有存進待送出。請不要關閉這個分頁,重新登入後再送出一次。',
    };
  }
  try {
    const existing = (await listPending(ownerKey, now)).items;
    const verdict = admit(existing, input, now);
    if (!verdict.ok) {
      return {
        ok: false,
        reason: verdict.reason ?? 'failed',
        message: verdict.message ?? '存不進待送出',
      };
    }
    const item: QueuedItem = {
      ...input,
      note: input.note?.trim() ? input.note.trim() : undefined,
      id: newId(),
      ownerKey,
      queuedAt: now,
      attempts: 0,
      lastError: null,
    };
    const db = await openDb();
    await promisify(tx(db, 'readwrite').put(item) as unknown as IDBRequest<IDBValidKey>);
    return { ok: true, item };
  } catch (e) {
    const quota =
      typeof DOMException !== 'undefined' &&
      e instanceof DOMException &&
      (e.name === 'QuotaExceededError' || e.name === 'NotEnoughSpace');
    return {
      ok: false,
      reason: quota ? 'quota' : 'failed',
      message: quota
        ? '裝置的儲存空間不足,照片沒有存下來。請清出空間,或不要關閉這個分頁,回到有網路的地方再送出一次。'
        : '照片沒有存進待送出(裝置的儲存空間可能被停用)。請不要關閉這個分頁,回到有網路的地方再送出一次。',
    };
  }
}

/**
 * 清掉某個帳號在這台裝置上的全部待送出,回傳清掉幾筆。
 *
 * 只清 ownerKey 對得上的那些:共用裝置上別人的待送出一筆都不動,
 * 那是他的東西,而且他還沒有機會回到有網路的地方重送。
 * 呼叫端(登出流程)要先問過使用者才呼叫這一支 —— 這裡刪掉的照片補不回來。
 */
export async function removeOwnerPending(ownerKey: string): Promise<number> {
  if (!queueSupported() || !ownerKey) return 0;
  try {
    const all = await readAll();
    const mine = all.filter((it) => it.ownerKey === ownerKey);
    await deleteIds(mine.map((it) => it.id));
    return mine.length;
  } catch {
    return 0;
  }
}

/** 刪掉一筆(送成功、或使用者自己決定不要了) */
export async function removePending(id: string): Promise<boolean> {
  if (!queueSupported()) return false;
  try {
    await deleteIds([id]);
    return true;
  } catch {
    return false;
  }
}

/** 更新一筆的重送結果(次數與最後一次的失敗原因) */
async function markAttempt(item: QueuedItem, error: string | null): Promise<void> {
  try {
    const db = await openDb();
    const next: QueuedItem = { ...item, attempts: item.attempts + 1, lastError: error };
    await promisify(tx(db, 'readwrite').put(next) as unknown as IDBRequest<IDBValidKey>);
  } catch {
    /* 更新失敗不影響重送結果本身,下次列出來時就是舊的次數 */
  }
}

/**
 * 呼叫端(頁面)實際送出去的結果。
 *   sent   送成功,從佇列刪掉
 *   retry  這次沒成功,但下次可能會(沒網路、5xx)。留著
 *   drop   送出去了但伺服器明確拒絕,再送幾次都一樣(400 / 404 / 403)。
 *          留著並記下原因,由使用者決定要不要刪 —— 直接刪掉等於把他現場拍的東西
 *          在他不知情的狀況下丟掉
 */
export type SendOutcome =
  { kind: 'sent' } | { kind: 'retry'; message: string } | { kind: 'drop'; message: string };

export interface FlushSummary {
  sent: number;
  failed: number;
  /** 因為照片超過 24 小時而根本沒送的 */
  lapsed: number;
  /** 每一筆的結果,畫面用來寫訊息 */
  messages: string[];
}

/**
 * 重送目前登入者的待送出。
 *
 * send 由呼叫端提供(頁面知道 API base 與 cookie 怎麼帶),這一支不碰 fetch,
 * 所以可以在 node 裡整段測。
 *
 * 只送 ownerKey 對得上的那些:共用裝置上換帳號登入之後,前一個人的打卡
 * 不會被送出去,更不會掛在現在這個人的名下。
 */
export async function flushPending(
  ownerKey: string,
  send: (item: QueuedItem) => Promise<SendOutcome>,
  now: number,
): Promise<FlushSummary> {
  const summary: FlushSummary = { sent: 0, failed: 0, lapsed: 0, messages: [] };
  if (!ownerKey) return summary;
  const { items } = await listPending(ownerKey, now);
  for (const item of items) {
    if (resendWindow(item, now) === 'lapsed') {
      summary.lapsed += 1;
      summary.messages.push(`${item.customerName}:照片拍攝時間已超過 24 小時,伺服器不會接受`);
      await markAttempt(item, '照片拍攝時間已超過 24 小時,伺服器不會接受');
      continue;
    }
    let outcome: SendOutcome;
    try {
      outcome = await send(item);
    } catch {
      outcome = { kind: 'retry', message: '送出失敗,請稍後再重送' };
    }
    if (outcome.kind === 'sent') {
      summary.sent += 1;
      await removePending(item.id);
      continue;
    }
    summary.failed += 1;
    summary.messages.push(`${item.customerName}:${outcome.message}`);
    await markAttempt(item, outcome.message);
    // 送不出去就不要再往下送了:後面那幾筆一定是同樣的下場,
    // 每一筆都跑一次逾時只會讓使用者多等好幾十秒
    if (outcome.kind === 'retry') break;
  }
  return summary;
}
