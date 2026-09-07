// ref:3687 mc/陳彥輔/米球®
/**
 * 錯誤記錄的「同一件事」判斷。
 *
 * 為什麼需要:error_logs 原本只寫不刪也不合併。一種錯誤被打一萬次就是一萬列,
 * 每列 message 1000 字加 stack 8000 字。審查抓到的深層巢狀 body 就是這樣灌記錄的 ——
 * 一次不需要憑證的請求換一列,重複打就把表灌爆,後台的錯誤頁也一起變成噪音。
 *
 * 指紋要「同一種錯誤算同一個,不同錯誤不要撞在一起」。所以取:
 *   level + statusCode + method + 遮蔽後的路徑骨架 + 訊息骨架
 * 訊息骨架是把訊息裡會變動的部分(數字、UUID、引號內容)換成佔位符之後的樣子,
 * 不然 `找不到客戶 <每次不同的 id>` 每一次都是新指紋,合併等於沒做。
 *
 * 這裡刻意不用密碼學雜湊:指紋不是安全機制,只是分組的鍵,可讀比不可讀好查。
 * 但長度要壓在 varchar(64) 之內,所以用 FNV-1a 這種短、穩定、沒有相依的做法。
 */

/** 路徑裡看起來像識別碼的片段,一律換成佔位符,不然每一筆客戶都是一個新指紋 */
const PATH_ID_RE =
  /\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{24,})(?=\/|$)/gi;

/** 訊息裡會逐次變動的東西 */
const MESSAGE_NOISE: ReadonlyArray<readonly [RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>'],
  [/\d+/g, '<n>'],
  [/["'`][^"'`]*["'`]/g, '<v>'],
  [/\s+/g, ' '],
];

/** 訊息骨架。長度也截短:指紋只需要開頭那一段就足以分辨是哪一種錯誤 */
export function messageSkeleton(message: string): string {
  let out = message;
  for (const [re, sub] of MESSAGE_NOISE) out = out.replace(re, sub);
  return out.trim().slice(0, 200);
}

/** 路徑骨架 */
export function pathSkeleton(path: string | undefined): string {
  if (!path) return '';
  // query string 對「是哪一種錯誤」沒有幫助,而且它是最會變動的部分
  const q = path.indexOf('?');
  const bare = q >= 0 ? path.slice(0, q) : path;
  return bare.replace(PATH_ID_RE, '/<id>').slice(0, 200);
}

/** FNV-1a 32 位元,轉成 8 個十六進位字元。純分組用,不是安全雜湊 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface FingerprintInput {
  level?: string;
  statusCode?: number;
  method?: string;
  path?: string;
  message: string;
}

/**
 * 這一筆錯誤的指紋。形狀是 `<status>-<method>-<雜湊>`,長度遠小於 64,
 * 前面兩段保持可讀,查資料庫時看得出大概是什麼。
 */
export function errorFingerprint(input: FingerprintInput): string {
  const parts = [
    input.level ?? 'error',
    String(input.statusCode ?? 0),
    input.method ?? '',
    pathSkeleton(input.path),
    messageSkeleton(input.message),
  ];
  return `${input.statusCode ?? 0}-${(input.method ?? 'x').toLowerCase()}-${fnv1a(parts.join('|'))}`;
}
// ref:3687 mc/陳彥輔/米球®
