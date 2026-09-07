// ref:3687 mc/陳彥輔/米球®
// 匯出結果的判讀與說法(純函式,無 React 相依,方便單元測試)。
// 畫面在 app/admin/crm/data/page.tsx。
//
// ── 這一支在救哪兩件事 ──────────────────────────────────────────────
// 1. 匯出一次最多 5000 筆,超過的部分後端會截斷,並用 X-Export-Truncated 與
//    X-Export-Next-Offset 兩個標頭交代。舊版的匯出是一個 <a href download>,
//    而 <a download> 讀不到任何一個回應標頭 —— 使用者拿到的是一個看起來很完整的
//    檔案,少掉的那幾千筆不會有人發現。
// 2. 匯出有速率限制(每分鐘 6 次,以對外 IP 計算)。用 <a download> 時,429 的
//    JSON 會被瀏覽器當成一份文件開起來,畫面變成一頁 {"statusCode":429,...}。
//
// 兩件事都只有 fetch 拿得到,所以匯出改走 fetch,判讀的部分放在這裡。
// 跨網域部署時那幾個標頭還要後端的 CORS exposedHeaders 放行
// (見 apps/backend/src/crm/export/export-headers.ts),沒放行時這裡一律讀到 null,
// 那時候寧可少講一句,也不要顯示「已下載 0 筆」這種騙人的數字。

/** 從回應標頭讀到的原始字串(讀不到就是 null,跨網域沒放行時就是這樣) */
export interface ExportHeaderValues {
  count: string | null;
  truncated: string | null;
  nextOffset: string | null;
  /** 只有存證照片清單那一支會有 */
  totalBytes: string | null;
}

/** 判讀完的結果。nextOffset 不是 null 就代表還沒匯完,畫面要給「繼續下載下一段」 */
export interface ExportOutcome {
  message: string;
  nextOffset: number | null;
}

/**
 * 超過速率限制時要講的話。
 *
 * 要講到「為什麼明明是我第一次按也會被擋」為止:限制是每個對外 IP 每分鐘 6 次,
 * 一整間辦公室走同一條網路出去時,這個額度是全辦公室一起用的。
 * 少了這一句,使用者的結論會是「匯出功能壞掉了」。
 */
export const EXPORT_RATE_LIMITED_MESSAGE =
  '匯出太頻繁,這一次沒有匯出。匯出是每分鐘最多 6 次,而且是以對外 IP 計算的:' +
  '同一間辦公室共用一條網路時,額度是大家一起用的。請等一分鐘再按一次。';

/** 位元組數轉成人看得懂的大小 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 標頭裡的數字。讀不到、空的、不是數字都回 null,不要自己編一個 0 出來 */
function num(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 一次成功的匯出要跟使用者說什麼。
 *
 * 三種情況:
 *   截斷了      講出這一次幾筆、下一段從第幾筆開始,並讓畫面長出「繼續下載下一段」
 *   沒截斷      講出這一次幾筆,並明說「這一支已經全部匯完」
 *   標頭讀不到  只說「已下載」。跨網域沒放行 exposedHeaders 時就是這樣,
 *               這時候講「已下載 0 筆」是騙人的,講「已全部匯完」更糟。
 */
export function describeExportSuccess(label: string, h: ExportHeaderValues): ExportOutcome {
  const count = num(h.count);
  const total = num(h.totalBytes);
  const next = num(h.nextOffset);
  const truncated = h.truncated === 'true';

  const countPart = count === null ? '已下載' : `已下載 ${count} 筆`;
  const sizePart = total === null ? '' : `,這一批的照片本體合計約 ${fmtBytes(total)}`;

  if (truncated && next !== null) {
    return {
      message:
        `${label}:${countPart}${sizePart}。這一次到達單次 5000 筆的上限,還沒有匯完;` +
        `按下面的「繼續下載下一段」會從第 ${next + 1} 筆接著下載,` +
        '每一段各自是一個檔案,合併請在試算表軟體裡做。',
      nextOffset: next,
    };
  }
  if (truncated) {
    // 說被截斷卻沒給下一段的位置:這是後端或 CORS 的問題,但使用者要知道檔案不完整
    return {
      message:
        `${label}:${countPart}${sizePart}。這一次到達單次 5000 筆的上限,還沒有匯完,` +
        '但系統沒有回報下一段從第幾筆開始。請在網址後面自己加上 offset 參數取下一段。',
      nextOffset: null,
    };
  }
  if (count === null) {
    return {
      message:
        `${label}:${countPart}${sizePart}。系統沒有回報這一次的筆數(跨網域部署時可能讀不到),` +
        '請自行確認檔案的列數是否符合預期。',
      nextOffset: null,
    };
  }
  return { message: `${label}:${countPart}${sizePart}。這一支已經全部匯完。`, nextOffset: null };
}

/** 從 Content-Disposition 取檔名。取不到就用預設,不要讓檔案變成沒有名字 */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  // RFC 5987 的 filename*=UTF-8''… 優先,那一份才有中文
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // 百分比編碼壞掉就往下用 ASCII 那一份
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}
