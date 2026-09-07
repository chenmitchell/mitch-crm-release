// ref:3687 mc/陳彥輔/米球®
/**
 * 匯出用的 CSV 產生與 HTTP 標頭(純函式,不碰 Nest 也不碰 Prisma)。
 *
 * ── 為什麼要有匯出 ──────────────────────────────────────────────
 * 「三年後我要換掉你,資料怎麼帶走」是導入會議一定會被問的問題。
 * 在這之前這套系統資料進得來出不去:後端沒有任何一支端點會回附件,
 * 前端唯一的 download 是匯入範本。答不出這個問題的系統,採購那一關就過不了。
 *
 * ── 三件一定要做對的事 ─────────────────────────────────────────
 * 1. **UTF-8 BOM**。沒有 BOM 的 UTF-8 CSV,Excel(尤其是繁體中文的 Windows)
 *    會用系統的 ANSI 字碼頁去猜,中文全部變亂碼。使用者的結論是「匯出壞掉」,
 *    而檔案其實是好的。BOM 三個位元組解決這件事,LibreOffice 與 Numbers 也吃。
 * 2. **CRLF 換行**。RFC 4180 的規定,舊版 Excel 對純 LF 的多行欄位處理會走鐘。
 * 3. **Content-Disposition 的檔名要兩種都給**。純 ASCII 的 filename= 給舊瀏覽器,
 *    RFC 5987 的 filename*=UTF-8'' 給現代瀏覽器,中文檔名才不會變成一串問號。
 *
 * ── 試算表公式注入 ──────────────────────────────────────────────
 * CSV 的欄位如果以等號、加號、減號或小老鼠開頭,Excel 會把它當公式執行(DDE 那一類)。
 * 客戶名稱與備註是使用者輸入的,所以要處理。但是不能無腦加單引號 ——
 * 這份檔案的用途之一就是「匯出 → 修 → 匯入」,每個電話號碼前面多一個單引號
 * 就等於毀掉往返。折衷是:看起來像號碼的值(+886-2-1234-5678 這種)原樣輸出,
 * 其餘以危險字元開頭的才加單引號。見 sanitizeForSpreadsheet。
 */

/**
 * 檔案開頭的 UTF-8 BOM(U+FEFF)。Excel 靠它認出這是 UTF-8。
 * 寫成逸出序列而不是直接貼那個字元:BOM 在編輯器裡看不見,
 * 貼在原始碼裡的話,任何一次「順手清掉看起來多餘的空白」都可能把它弄掉。
 */
export const UTF8_BOM = '\uFEFF';

/** RFC 4180 的換行 */
const CRLF = '\r\n';

/**
 * 看起來像號碼的值:數字、加減號、括號、空白、連字號、井號、星號、點、逗號。
 * 這一類原樣輸出,不加防注入的單引號 —— 台灣的手機號碼寫成 +886-9xx 很常見,
 * 每一支都被加上單引號的話,匯出的檔案就不能直接改完再匯回來。
 */
const NUMBER_LIKE = /^[+-]?[0-9()\s\-+#*.,]+$/;

/**
 * Excel / LibreOffice / Google Sheets 會當成公式起手式的字元。
 *
 * 四個都要擋:`=`、`+`、`-`、`@`。只擋 `=` 與 `@` 是不夠的,三套試算表都吃
 * `+` 與 `-` 開頭的算式,`+cmd|' /C calc'!A0` 這種 DDE 酬載正是靠 `+` 起手。
 * 另外把前導的定位與歸位字元也算進來:Excel 會把它們吃掉,剩下的部分照樣當公式。
 *
 * 順序很重要:NUMBER_LIKE 的白名單在這一條之前就 return,所以 `+886-2-1234-5678`
 * 這種號碼不會被加上單引號,「匯出 → 修 → 匯回」的往返不受影響。
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * 防試算表公式注入。以危險字元開頭、而且不像號碼的值,前面補一個單引號。
 * 單引號在 Excel 裡是「這一格當文字看」的既有慣例,顯示時不會出現。
 */
export function sanitizeForSpreadsheet(value: string): string {
  if (value.length === 0) return value;
  if (NUMBER_LIKE.test(value)) return value;
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/**
 * 一格的值轉成 CSV 欄位。
 *
 * 一律加雙引號,不是「有需要才加」:值裡有逗號、換行或引號時本來就必須加,
 * 而混著加的檔案在人工比對時很難看出哪一格被動過。全部加也讓
 * 「這一格是空字串」與「這一格是 NULL」在檔案上長得一樣,
 * 那正是匯入端的行為(空字串視為未填),兩邊一致。
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const safe = sanitizeForSpreadsheet(raw).replace(/"/g, '""');
  return `"${safe}"`;
}

/** 一列值轉成 CSV 的一行(不含換行) */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * 標題列加資料列,組成完整的 CSV 文字(含 BOM,CRLF 換行,結尾有換行)。
 * 沒有資料列時仍然輸出標題列:空檔案會讓人以為匯出失敗,只有標題的檔案不會。
 *
 * ── 為什麼要在這裡檢查每一列的長度 ──────────────────────────────
 * 匯出的檔案同時就是匯入的格式,而匯入是**位置式解析**(見前端 lib/csv-import.ts)。
 * 資料列少一格,那一格之後的每一欄都往前挪一位;多一格則是往後挪。
 * 兩種情況匯回來都不會報錯,它只會把每一格照位置填進錯的欄位 ——
 * 登記地址寫進聯絡地址、備註寫進進度,而且沒有任何一關會亮燈。
 *
 * 這是程式錯誤(select 少撈一欄、body 少 map 一格),不是使用者輸入的問題,
 * 所以直接丟例外:寧可這一支匯出當場失敗,也不要安靜輸出一份會污染資料的檔案。
 * 開發與測試階段就會炸開,上線之後真的發生也留得下 error_logs。
 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const width = headers.length;
  rows.forEach((row, i) => {
    if (row.length !== width) {
      throw new Error(
        `匯出的第 ${i + 1} 列有 ${row.length} 格,表頭是 ${width} 欄。` +
          '欄數對不上會讓匯回來的每一格錯位,這一份檔案不能輸出。',
      );
    }
  });
  const lines = [csvRow(headers), ...rows.map(csvRow)];
  return UTF8_BOM + lines.join(CRLF) + CRLF;
}

/**
 * 檔名裡要換掉的字元:控制字元(0x00-0x1F 與 0x7F)加上路徑與標頭上有意義的那幾個。
 *
 * 這裡的 `\x00-\x1f\x7f` 一定要寫成逸出序列,不能把那三個位元組直接打進原始碼。
 * 功能完全一樣,但**檔案本身**會因此含有裸控制位元組,git 就把整個 .ts 判定成
 * binary:`git diff` 只會印一行「Binary files differ」,GitHub 上點進去也看不到內容。
 * 這是公開 repo,一個沒有人 review 得了的原始碼檔比它擋掉的那幾個字元嚴重得多。
 * ref:3687 mc/陳彥輔/米球®
 */
const CONTROL_AND_PATH_CHARS = /[\x00-\x1f\x7f"\\/:*?<>|,;]/g;

/**
 * 檔名裡不能出現的字元換成底線,並限制長度。
 * 檔名有一部分來自組織名稱(使用者輸入),沒有這一道的話,
 * 一個帶引號或換行的組織名就能把 Content-Disposition 這個標頭撐開。
 */
export function safeFileNamePart(value: string, max = 40): string {
  return value.replace(CONTROL_AND_PATH_CHARS, '_').trim().slice(0, max);
}

/**
 * 匯出檔名:前綴加時間戳再加 .csv。
 * 時間戳用的是呼叫端算好的當地時間字串,不在這裡自己取 new Date() ——
 * 純函式才測得出來,而且時區要跟系統其他地方一樣由 OrgTimeService 決定。
 */
export function exportFileName(prefix: string, stamp: string): string {
  return `${safeFileNamePart(prefix)}-${safeFileNamePart(stamp, 20)}.csv`;
}

/**
 * Content-Disposition 的值。
 *
 * 兩種檔名都給:
 *   filename=   非 ASCII 一律換成底線的保守版本,給看不懂 filename* 的舊瀏覽器
 *   filename*=  RFC 5987 的 UTF-8 百分比編碼,現代瀏覽器優先採用
 * 只給前者的話中文檔名會變問號,只給後者的話舊瀏覽器會存成沒有副檔名的檔案。
 */
export function attachmentDisposition(fileName: string): string {
  const safe = safeFileNamePart(fileName, 120);
  const ascii = safe.replace(/[^ -~]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/** 匯出回應的完整標頭。no-store:客戶名單不該留在瀏覽器或中間代理的快取裡 */
export function csvResponseHeaders(fileName: string): Record<string, string> {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': attachmentDisposition(fileName),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
