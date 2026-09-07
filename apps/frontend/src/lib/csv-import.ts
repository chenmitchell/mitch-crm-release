// ref:3687 mc/陳彥輔/米球®
// 匯入名單的 CSV 解析(純函式,無 React 相依,方便單元測試)。
// 頁面在 app/admin/crm/import/page.tsx。

/**
 * 匯入欄位順序:識別碼, 公司名, 聯絡人, 電話, 分類, 進度, 備註,
 * 實際營業地址, 登記地址, 聯絡地址。
 *
 * 解析一律照「欄位位置」,不比對標題文字 —— 第一欄的標題在不同地區叫什麼
 * 由後台設定決定(lookupLabel),拿標題文字當 key 的話,一改設定舊檔就匯不進來。
 *
 * ## 改這個陣列之前必讀
 *
 * 既然是位置式解析,這個陣列的順序**就是**檔案格式本身:第 n 個元素對應
 * CSV 的第 n 欄。所以
 *
 *   - **新欄位一律加在最後面**。插在中間或調換順序,等於使用者手上所有既有的
 *     CSV 一夜之間全部錯位:電話跑進分類、備註跑進進度,而且匯入不會報錯,
 *     它只會把每一格照位置填進錯的欄位。
 *   - **不要刪中間的元素**。真的要停用某一欄,留著佔位比拿掉安全。
 *   - 改了順序或長度,記得一起更新三個地方:columnLabel() 的名稱對應、
 *     public/crm-import-template.csv 這份下載範本,以及 csv-import 的測試
 *     (測試會紅,但它報的是「第幾欄的值不對」,看不出根因是欄位順序被動過)。
 */
const IMPORT_COLS = [
  'taxId',
  'companyName',
  'contactName',
  'contactPhone',
  'category',
  'stage',
  'note',
  // 地址三欄是後加的,所以照規矩接在最後面(不能為了「讀起來順」插到備註前面,
  // 那會讓使用者手上所有既有的 CSV 一夜錯位)。
  //
  // 三欄的順序刻意對齊後端 pickAddress() 的取用優先序(實際 → 登記 → 聯絡):
  // 只填一欄的人幾乎都是填第一欄,而第一欄正好就是拜訪地圖真正拿去做地理編碼的那一欄。
  // 沒有這三欄的話,匯進來的客戶三個地址全空,hasAddress() 為假 ->
  // 永遠不進 pendingGeocode、lat 永遠 null -> 拜訪地圖上不存在,
  // 打卡的 distanceM 也一律 null,假定位偵測對這批客戶等於關閉。
  'actualAddress',
  'registeredAddress',
  'contactAddress',
] as const;

export type ImportColumn = (typeof IMPORT_COLS)[number];

/**
 * 欄位的中文名稱。識別碼那一欄在當地叫什麼由後台設定決定(lookupLabel),
 * 所以它是唯一一個要由呼叫端帶進來的名字,其餘固定。
 */
export function columnLabel(field: string, lookupLabel: string): string {
  const fixed: Record<string, string> = {
    companyName: '公司名',
    contactName: '聯絡人',
    contactPhone: '電話',
    category: '分類',
    stage: '進度',
    note: '備註',
    actualAddress: '實際營業地址',
    registeredAddress: '登記地址',
    contactAddress: '聯絡地址',
  };
  if (field === 'taxId') return lookupLabel;
  return fixed[field] ?? field;
}

/**
 * 每一欄的字數上限,對齊後端 ImportRowDto(那一份又對齊 schema.prisma 的欄位長度)。
 * 兩邊必須一樣:這裡放行、後端擋下的話,使用者拿到的是一整批 400,
 * 而不是「第幾列第幾欄太長」。改任何一邊都要改另一邊。
 */
export const COLUMN_MAX_LENGTH: Record<ImportColumn, number> = {
  taxId: 16,
  companyName: 200,
  contactName: 100,
  contactPhone: 40,
  category: 40,
  stage: 20,
  note: 8000,
  // 三個地址在 schema.prisma 都是 VarChar(300),CreateDevCustomerDto 也是 300
  actualAddress: 300,
  registeredAddress: 300,
  contactAddress: 300,
};

/**
 * 上傳檔案的大小上限(bytes)。
 *
 * 這一條要擋在 file.arrayBuffer() **之前**。那一支會把整個檔案讀成一塊 ArrayBuffer
 * 放進記憶體:選到一個 500MB 的 csv,分頁就是直接吃掉 500MB 再開始解析,
 * 行動裝置上多半在那之前就被系統回收,而使用者看到的只是「按了沒反應」。
 * 一次匯入上限 1000 列,正常的名單檔是幾百 KB 到幾 MB,20MB 已經很寬 ——
 * 超過這個大小幾乎一定是選錯檔(整個資料夾的備份、影片、資料庫傾印)。
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 這個檔太大了嗎 */
export function isUploadTooLarge(size: number): boolean {
  return size > MAX_UPLOAD_BYTES;
}

/**
 * 檔案過大時要講的話。三件事都要講到:沒有讀取也沒有匯入、上限是多少、下一步怎麼辦。
 * 只說「檔案太大」的話,使用者不知道該砍到多小,也不知道系統有沒有動到資料。
 */
export function uploadTooLargeMessage(fileName: string, size: number): string {
  const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
  const got = (size / (1024 * 1024)).toFixed(1);
  return (
    `「${fileName}」有 ${got}MB,超過單檔 ${mb}MB 的上限,沒有讀取也沒有匯入。` +
    `匯入一次最多 1000 列,正常的名單檔遠小於這個大小,請確認選到的是要匯入的 CSV;` +
    '名單真的很大的話請在試算表軟體裡拆成幾個檔分次匯入。'
  );
}

/** 解碼失敗時 TextDecoder 會塞進來的替代字元(U+FFFD,顯示成菱形問號) */
export const REPLACEMENT_CHAR = '\uFFFD';

/** 這份文字裡有沒有解碼失敗留下的替代字元 */
export function hasReplacementChar(text: string): boolean {
  return text.includes(REPLACEMENT_CHAR);
}

/** 空字元(U+0000)。文字檔裡不會有,解出來有就代表這份文字是用錯的編碼讀的 */
export const NUL_CHAR = '\u0000';

/**
 * 這份文字裡有沒有空字元(U+0000)。
 *
 * 為什麼要單獨看它:替代字元不是唯一的「讀錯了」的證據。一份 UTF-16LE 的 CSV
 * (Excel 的「Unicode 文字」另存出來就是)每一個 ASCII 字後面都跟著一個 0x00
 * 位元組。UTF-8 的 fatal 解碼會失敗,於是落到 Big5 那一支;Big5 把 0x00 直接
 * 解成 U+0000,結果是一份「有字、沒有半個替代字元」的文字,前面每一關都會放行。
 * 送出去之後,帶著 U+0000 的字串進 PostgreSQL 會被驅動層擋下(那個型別不接受
 * 空字元),使用者拿到的是一個 500,而不是一句看得懂的「這個檔不是 UTF-8」。
 */
export function hasNulChar(text: string): boolean {
  return text.includes(NUL_CHAR);
}

/**
 * 這份文字看起來是不是用錯的編碼讀出來的。
 * 兩個證據任一成立就算:解碼失敗的替代字元,或不該出現在文字檔裡的空字元。
 */
export function looksMisdecoded(text: string): boolean {
  return hasReplacementChar(text) || hasNulChar(text);
}

/** decodeCsvBuffer 的結果。fail 代表兩種編碼都讀不成一份像樣的文字 */
export type CsvDecodeResult =
  | { ok: true; encoding: 'utf-8'; text: string }
  | { ok: true; encoding: 'big5'; text: string; sample: string[] }
  | { ok: false; encoding: null };

/**
 * 取前幾筆的公司名(第二欄),給「這個檔要不要用 Big5 讀」的確認畫面當樣本。
 * 用完整的 parseCsv 太重也會被字數檢查干擾,這裡只要肉眼能判斷是不是亂碼就夠。
 */
function previewCompanyNames(text: string, max = 3): string[] {
  const out: string[] = [];
  const records = parseCsvRecords(text);
  for (let i = 1; i < records.length && out.length < max; i++) {
    const name = (records[i]?.[1] ?? '').trim();
    if (name) out.push(name.slice(0, 40));
  }
  return out;
}

/**
 * 把上傳的檔案位元組解成文字。
 *
 * ## 為什麼不能直接用 File.text()
 *
 * File.text() 固定以 UTF-8 解碼,而且**不會丟例外**:遇到不是合法 UTF-8 的位元組,
 * 它安靜地換成 U+FFFD 就回傳。於是一份 Big5 的 CSV 會變成一份「格式完全合法、
 * 每一欄都在字數上限內、解析零錯誤」的亂碼,整批寫進資料庫,而畫面顯示
 * 「已匯入 2000 筆」。事後雖然可以從回收桶把那一批整批刪掉,但那已經是在收拾,
 * 而且中間只要有人在那些客戶上寫過互動或打過卡,收拾就不再乾淨。
 *
 * 而這個情境不是邊角案例:介面是正體中文,使用者多半是 zh-TW Windows + Excel,
 * 那個環境的「CSV」預設另存出來就是 Big5。匯入頁那行「請選 CSV UTF-8」的灰字
 * 是提醒,不是把關。
 *
 * ## 做法
 *
 * 1. 先用 fatal 模式解 UTF-8。合法就照 UTF-8 收,行為與原本相同。
 * 2. 解不開(丟 TypeError)代表這份檔不是 UTF-8。再用 Big5 解一次
 *    (TextDecoder('big5') 是瀏覽器與 Node 都內建的編碼,不必外掛套件)。
 *    Big5 解得出「沒有替代字元」的文字才算數,並回傳前幾筆公司名當樣本 ——
 *    呼叫端要拿這個樣本問使用者「這樣讀對不對」,不自作主張直接匯入:
 *    別種編碼(GBK、Shift_JIS)也可能被 Big5 解成一串看似有字的亂碼。
 * 3. 兩種都不成就回 ok:false,由呼叫端請使用者改存成 CSV UTF-8。
 */
export function decodeCsvBuffer(buf: ArrayBuffer): CsvDecodeResult {
  const bytes = new Uint8Array(buf);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 「解得開 UTF-8」還不等於「這是一份 UTF-8 文字檔」。一份英文內容的 UTF-16LE
    // 檔,每個字後面跟著一個 0x00,而 0x00 本身是合法的 UTF-8,所以 fatal 模式
    // 一聲不吭就解完了,解出來是 T\0a\0x\0I\0d 這種東西。空字元不會出現在
    // 任何一份真的文字檔裡,出現就代表讀錯了,在這裡就擋掉。
    if (!hasNulChar(text)) return { ok: true, encoding: 'utf-8', text };
  } catch {
    // 不是合法 UTF-8,往下試 Big5
  }
  try {
    const text = new TextDecoder('big5').decode(bytes);
    // 空字元也算讀錯了:UTF-16LE 的檔會走到這裡,而它被 Big5 解出來的東西
    // 沒有半個替代字元,只有一半的字元是 U+0000。放行的話會一路送到後端,
    // 在資料庫那一層變成 500,而不是一句看得懂的「請另存成 CSV UTF-8」。
    if (!looksMisdecoded(text)) {
      return { ok: true, encoding: 'big5', text, sample: previewCompanyNames(text) };
    }
  } catch {
    // 這個執行環境沒有 big5 這個編碼(理論上不會,瀏覽器都內建)
  }
  return { ok: false, encoding: null };
}

/**
 * 一格的問題。row 是**試算表看到的列號**(標題是第 1 列,第一筆資料是第 2 列),
 * field 是欄位代碼(顯示時用 columnLabel 轉成當地的名稱)。
 *
 * 這是「匯入錯誤指到第幾列第幾欄」的資料結構:解析階段就知道列號,
 * 不要等送到後端才發現,那時候列號已經不在了。
 */
export interface CellError {
  row: number;
  field: string;
  message: string;
}

/**
 * 把一格的問題轉成一句話。row 小於 1 代表對不到列號(直接打 API 的來源沒有列號),
 * 那時候寧可講明「對不到列號」,也不要印出「第 0 列」這種騙人的位置。
 */
export function formatCellError(err: CellError, lookupLabel: string): string {
  const where = err.row >= 1 ? `第 ${err.row} 列` : '(對不到列號)';
  return `${where}「${columnLabel(err.field, lookupLabel)}」欄:${err.message}`;
}

/**
 * 範本示範列的辨識值。
 *
 * 下載回去的範本第二列是一筆示範資料,使用者常常直接在下面接著填、不刪那一列,
 * 於是每次匯入都憑空多一筆假客戶。這裡把它濾掉。
 *
 * 但「濾掉」不能誤傷真客戶。舊版只要識別碼剛好是 12345678、或公司名以「(有」開頭
 * 就整列丟掉,而且丟在分批之前、不計入 skipped、畫面完全看不到 —— 統編正好是
 * 12345678 的真客戶、名字以「(有限公司…」開頭的真客戶,都被當示範列人間蒸發。
 *
 * 改成:**識別碼與公司名兩個線索同時命中同一列**才判為示範列(範本的示範列本來
 * 就兩者都有)。真客戶要同時湊齊這兩個特徵的機率極低。而且就算真的誤判,被丟掉的
 * 列數與原因會回報給使用者(見 parseCsv 的回傳),不再是靜默丟資料。
 */
const SAMPLE_TAX_ID = '12345678';
const SAMPLE_NAME_PREFIXES = ['(有', '（有'] as const;

function isSampleRow(row: Record<string, string>): boolean {
  const taxMatches = row.taxId === SAMPLE_TAX_ID;
  const nameMatches = SAMPLE_NAME_PREFIXES.some((p) => row.companyName?.startsWith(p));
  return taxMatches && nameMatches;
}

/**
 * 逐字元 CSV 切割(RFC 4180 語意)。回傳每一筆記錄(欄位陣列),
 * 記錄的邊界是**引號外**的換行,不是每一個換行 —— 這是跟舊版最大的差別。
 *
 * 舊版先 split(/\r?\n/) 再逐行切欄,備註欄一旦含換行(Excel 匯出 CSV 的常態)
 * 就會從那個換行處斷成兩筆:憑空多一筆客戶、備註被截斷,而畫面還顯示「已匯入 N 筆」
 * 沒有任何警告。這支解析器把換行分成兩種:
 *   - 在引號內:是欄位內容的一部分,原樣保留
 *   - 在引號外:才是記錄的結束
 *
 * 同時處理:
 *   - 引號內的逗號(不切欄)
 *   - 跳脫的雙引號 ""(代表一個 " 字元)
 *   - CRLF 與 LF 都當換行;引號內的 CRLF 正規化成 \n
 *   - BOM(呼叫端已先拿掉,這裡再防一次)
 */
function parseCsvRecords(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let sawAny = false; // 這一筆記錄有沒有出現過任何字元(用來分辨真的空行)

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    sawAny = false;
  };

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r') {
        // 引號內的 CRLF 正規化成單一 \n,LF 原樣
        if (clean[i + 1] === '\n') i += 1;
        field += '\n';
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ',') {
      endField();
      sawAny = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      // 引號外的換行 = 記錄結束。整列都沒出現過任何字元的空行直接略過。
      if (sawAny || field !== '' || record.length > 0) endRecord();
    } else {
      field += ch;
      sawAny = true;
    }
  }
  // 收尾:檔案不以換行結束時,最後一筆記錄還在暫存區
  if (sawAny || field !== '' || record.length > 0) endRecord();
  return records;
}

/**
 * 一筆待匯入的資料。除了七個欄位,還帶著它在檔案裡的列號:
 * 沒有列號的話,後端回報「有 3 筆的進度查不到」時使用者只能自己一列一列找。
 */
export interface ParsedRow extends Record<string, string | number> {
  /** 試算表看到的列號(標題是第 1 列,第一筆資料是第 2 列) */
  rowNumber: number;
}

/**
 * parseCsv 的回傳:可匯入的列,加上「在送出之前就地丟掉了哪幾列、為什麼」,
 * 以及「哪一列的哪一欄填壞了」。dropped / errors 這兩包都會回報給使用者,
 * 不再靜默丟資料,也不再只說「有一列太長」卻不說是哪一列。
 */
export interface ParsedCsv {
  rows: ParsedRow[];
  /** 判為範本示範列而丟掉的數量 */
  droppedSample: number;
  /** 被判為範本示範列的列號 */
  droppedSampleRows: number[];
  /** 有內容但識別碼與公司名兩格都空、無法成為一筆客戶而丟掉的數量 */
  droppedEmpty: number;
  /** 上面那些列的列號 */
  droppedEmptyRows: number[];
  /** 逐格檢查出來的問題(目前是字數超過上限),指到第幾列第幾欄 */
  errors: CellError[];
  /**
   * 這份文字裡有解碼失敗留下的替代字元(U+FFFD),也就是「這不是一份 UTF-8 檔」。
   * 為真時 rows 一定是空的:整批擋下,不讓亂碼寫進資料庫。
   */
  encodingSuspect: boolean;
}

/**
 * CSV 解析(第一列是標題;欄位可用雙引號包住,欄位內可含換行)。
 * 先把 BOM 拿掉:Excel 另存 CSV(UTF-8)會在檔頭放 EF BB BF,
 * 不拿掉的話第一欄的標題會多一個看不見的字元。
 */
export function parseCsv(text: string): ParsedCsv {
  const result: ParsedCsv = {
    rows: [],
    droppedSample: 0,
    droppedSampleRows: [],
    droppedEmpty: 0,
    droppedEmptyRows: [],
    errors: [],
    encodingSuspect: false,
  };
  /*
   * 先擋編碼。U+FFFD 是解碼器讀到不合法位元組時塞進來的替代字元,出現它就代表
   * 這份文字是「用錯的編碼讀出來的」—— 最常見的是 Big5 的 CSV 被當成 UTF-8 讀。
   *
   * 空字元(U+0000)一起擋:UTF-16LE 的檔被 Big5 解出來就是這種東西,一個替代字元
   * 都沒有,卻有一半的字元是 U+0000,而那種字串送進 PostgreSQL 會變成 500。
   *
   * 這一關非做不可,因為亂碼在後面每一關都是合格的:欄數對、每一欄都在字數上限內、
   * 解析零錯誤,於是 2000 筆亂碼會安靜地寫進資料庫,只能事後靠回收桶整批收拾。
   * 上傳路徑已經先用 decodeCsvBuffer 分辨過編碼,這裡守的是貼上路徑,以及
   * 任何繞過 decodeCsvBuffer 的呼叫端。
   */
  if (looksMisdecoded(text)) {
    result.encodingSuspect = true;
    return result;
  }
  const records = parseCsvRecords(text);
  if (records.length < 2) return result;
  // 第一列是標題,跳過。
  // 列號用「記錄的序號」而不是實體行號:備註欄含換行時一筆記錄佔檔案好幾行,
  // 但使用者在試算表裡看到的就是一列,回報要對得上他眼睛看到的那一列。
  for (let i = 1; i < records.length; i++) {
    const rowNumber = i + 1;
    const parts = records[i] ?? [];
    const row: Record<string, string> = {};
    IMPORT_COLS.forEach((key, idx) => {
      row[key] = (parts[idx] ?? '').trim();
    });
    if (isSampleRow(row)) {
      result.droppedSample += 1;
      result.droppedSampleRows.push(rowNumber);
      continue;
    }
    if (row.taxId || row.companyName) {
      for (const key of IMPORT_COLS) {
        const value = row[key] ?? '';
        const max = COLUMN_MAX_LENGTH[key];
        if (value.length > max) {
          result.errors.push({
            row: rowNumber,
            field: key,
            message: `${value.length} 個字,超過上限 ${max} 個字`,
          });
        }
      }
      result.rows.push({ ...row, rowNumber });
    } else if (parts.some((c) => c.trim() !== '')) {
      // 這一列有填東西,但識別碼與公司名兩格都空,收進來也不會是一筆客戶。
      // 計數、記下列號並回報,不要像舊版那樣默默丟掉。
      result.droppedEmpty += 1;
      result.droppedEmptyRows.push(rowNumber);
    }
  }
  return result;
}
