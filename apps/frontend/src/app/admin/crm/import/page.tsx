'use client';

// 匯入名單(/admin/crm/import)。原本是 /admin/crm 頁裡的收合區塊,拆頁後獨立。
// 兩條路徑:下載 CSV 範本填好上傳(.csv),或直接貼上 CSV。
// 送出時分批(每批最多 100 筆或 90KB),逐批累計結果;單筆過長的列自成一批,由後端 413 回報。
// 批次識別碼在這一頁產生一次,整次匯入的每一批都帶同一個值(後端沒收到才自己生)。
// 不這樣做的話,一次 300 列的匯入會產生三個識別碼,「刪掉這一批」只收得回其中 100 筆。
// 匯入完成後把這個識別碼與筆數顯示出來,資料管理頁的「整批處理匯入的客戶」貼它就能整批收回;
// 整批那三支是主管級的,所以那一段說明對訪查人員換一種講法(見 canBatchUndo)。
// 分批不是交易:中途失敗時前面幾批已經寫進資料庫且不會回退,所以失敗訊息要說出
// 「檔案的第幾筆已經進來、從第幾筆起沒送出、重送同一個檔案會被當成重複略過」。
// 資料來源:POST /api/admin/crm/import。
//
// 錯誤要指到「第幾列第幾欄」:
//   解析階段就知道列號(csv-import 的 rowNumber),字數超過上限的格子在送出之前
//   全部列出來、整批擋下,不要送一半才發現;送出時每一列都帶著列號,
//   後端查不到的進度、查不到的分類、與既有客戶重複這幾種問題也會照列號回報。
// 無障礙:單一 h1、匯入進度與結果 role="status" aria-live、按鈕 >= 44px(.btn 已含)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useState } from 'react';
import Link from 'next/link';
import { apiErrorMessage } from '@/lib/api-error';
import { canUseCrm, crmApiBase, isViewAllRole, useCrmRole } from '@/lib/crm-shared';
import { useLookupLabel } from '@/lib/app-settings';
import {
  decodeCsvBuffer,
  formatCellError,
  isUploadTooLarge,
  parseCsv,
  uploadTooLargeMessage,
  type CellError,
  type ParsedCsv,
  type ParsedRow,
} from '@/lib/csv-import';

/** 匯入分批:每批最多幾筆、每批 JSON 最大 bytes(後端 body 上限之下留餘裕) */
const IMPORT_BATCH_ROWS = 100;
const IMPORT_BATCH_BYTES = 90 * 1024;

/**
 * 這一次匯入的批次識別碼。整次匯入(不管切成幾批 POST)共用同一個值。
 * crypto.randomUUID 在非 https 的舊環境可能不存在,退回一個格式一樣的組法 ——
 * 後端 DTO 是用 @IsUUID('4') 驗的,格式錯會整批 400。
 */
function newImportBatchId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** 畫面上最多列幾條「第幾列第幾欄」,其餘用「還有 N 條」帶過 */
const ERRORS_SHOWN = 20;

/** 讀到的文字帶著解碼失敗的替代字元時,整批擋下並說清楚下一步 */
const ENCODING_BLOCKED_MESSAGE =
  '這個檔不是 UTF-8,讀出來會是亂碼,已經整批擋下,沒有送出任何資料。' +
  '請回到試算表軟體用「另存新檔」選「CSV UTF-8(逗號分隔)」再匯入一次。';

/** 切批:每批 <= IMPORT_BATCH_ROWS 筆,且序列化後 <= IMPORT_BATCH_BYTES */
function splitImportBatches(rows: ParsedRow[]): ParsedRow[][] {
  const batches: ParsedRow[][] = [];
  let cur: ParsedRow[] = [];
  for (const row of rows) {
    const next = [...cur, row];
    const tooBig = new Blob([JSON.stringify({ rows: next })]).size > IMPORT_BATCH_BYTES;
    if (cur.length > 0 && (next.length > IMPORT_BATCH_ROWS || tooBig)) {
      batches.push(cur);
      cur = [row];
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** 把列號串成「3、7、12」;超過六個就只列前六個再加「等」 */
function rowList(rows: number[]): string {
  const shown = rows.slice(0, 6).join('、');
  return rows.length > 6 ? `${shown} 等 ${rows.length}` : shown;
}

export default function CrmImportPage() {
  const role = useCrmRole();
  /*
   * 整批那三支(列出匯入批次 / 整批刪除 / 整批還原)已經一起拉到主管級 ——
   * 原本訪查人員按得下整批刪除,而回收桶與還原是 403,手滑之後完全沒有自救路徑
   * (見資料管理頁 app/admin/crm/data/page.tsx 的檔頭)。門檻對齊之後,
   * 匯入頁對訪查人員說「一個動作就能整批收回」「可以直接從最近幾次匯入挑」
   * 就變成不成立的話:他點進去只會拿到 403。目的地那一頁對非主管已經有正確的說明,
   * 只是匯入頁這一段的措辭沒跟著改。
   */
  const canBatchUndo = isViewAllRole(role);
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();
  const [csvText, setCsvText] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  /** 逐列逐欄的問題,每一條都指到第幾列第幾欄 */
  const [cellErrors, setCellErrors] = useState<CellError[]>([]);
  /** cellErrors 只留前 ERRORS_SHOWN 條時,這裡記總數 */
  const [cellErrorTotal, setCellErrorTotal] = useState(0);
  const [importing, setImporting] = useState(false);
  /**
   * 剛剛那一次匯入的批次識別碼與筆數。
   * 資料管理頁的「整批處理匯入的客戶」要的就是這一串,而想用到它的時候
   * (發現整批匯錯了)這一頁多半已經關掉,所以要在這裡就顯示出來、可以複製。
   */
  const [lastBatch, setLastBatch] = useState<{ id: string; created: number } | null>(null);
  /**
   * 「這個檔不是 UTF-8,要不要用 Big5 讀」的待確認狀態。
   *
   * 不直接拿 Big5 解出來的結果匯入:別種編碼(GBK、Shift_JIS)也可能被 Big5
   * 解出一串看似有字的東西。所以把前幾筆公司名秀出來讓使用者自己判斷,
   * 確認之後才送。取消就什麼都沒發生。
   */
  const [big5Pending, setBig5Pending] = useState<{
    text: string;
    fileName: string;
    sample: string[];
  } | null>(null);

  function showErrors(list: CellError[], total?: number) {
    setCellErrors(list.slice(0, ERRORS_SHOWN));
    setCellErrorTotal(total ?? list.length);
  }

  async function postRows(parsed: ParsedCsv, onDone?: () => void) {
    const { rows } = parsed;
    // 編碼不對就整批擋下。亂碼在後面每一關都合格(欄數對、字數也在上限內),
    // 放行等於把 2000 筆問號寫進資料庫,之後只能靠回收桶整批刪掉再重來。
    if (parsed.encodingSuspect) {
      setImportMsg(ENCODING_BLOCKED_MESSAGE);
      return;
    }
    // 送出之前就地丟掉的列(範本示範列、識別碼與公司名都空的列)要講清楚,
    // 不能像舊版那樣默默不見。
    const dropParts: string[] = [];
    if (parsed.droppedSample > 0)
      dropParts.push(
        `範本示範列 ${parsed.droppedSample} 列(第 ${rowList(parsed.droppedSampleRows)} 列)`,
      );
    if (parsed.droppedEmpty > 0)
      dropParts.push(
        `缺${lookupLabel}與公司名的列 ${parsed.droppedEmpty} 列(第 ${rowList(parsed.droppedEmptyRows)} 列)`,
      );
    const dropNote = dropParts.length > 0 ? `(自動略過:${dropParts.join('、')})` : '';

    // 字數超過上限的格子:送出去只會換回一整批 400,而那個 400 說不出是哪一列。
    // 在這裡全部列出來並擋下,使用者改完再送一次就好。
    if (parsed.errors.length > 0) {
      showErrors(parsed.errors);
      setImportMsg(
        `有 ${parsed.errors.length} 個欄位超過字數上限,這次沒有送出。修正下列欄位後再匯入一次${dropNote}`,
      );
      return;
    }

    if (rows.length === 0) {
      setImportMsg(
        `沒有可匯入的資料(請確認第一列為標題,其後每列至少有${lookupLabel}或公司名)${dropNote}`,
      );
      return;
    }
    const batches = splitImportBatches(rows);
    // 整次匯入共用一個批次識別碼。在迴圈外面產生是整件事的重點:
    // 產在迴圈裡面(或交給後端每次請求各自生)就會一次匯入長出 N 個識別碼。
    const importBatchId = newImportBatchId();
    setImporting(true);
    setLastBatch(null);
    let created = 0;
    let skipped = 0;
    const notes: string[] = [];
    let sentBatches = 0;
    let sentRows = 0;
    /** 已送出的最後一列在試算表裡的列號(標題是第 1 列);沒有就 null */
    let lastSentRowNumber: number | null = null;
    let failMsg: string | null = null;
    /** 後端逐列回報的問題(查不到的進度 / 分類、與既有客戶重複…),跨批累計 */
    const serverErrors: CellError[] = [];
    let serverErrorTotal = 0;
    const bigPrefix =
      rows.length > 1000 ? `共 ${rows.length} 筆,分 ${batches.length} 批送出。` : '';
    try {
      for (const batch of batches) {
        if (batches.length > 1) {
          setImportMsg(
            `匯入中:第 ${sentBatches + 1} / ${batches.length} 批(已匯入 ${created} 筆、略過 ${skipped} 筆)`,
          );
        }
        const res = await fetch(`${crmApiBase()}/import`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: batch, importBatchId }),
        });
        if (res.status === 413) {
          const singleTooLong =
            batch.length === 1 &&
            new Blob([JSON.stringify({ rows: batch, importBatchId })]).size > IMPORT_BATCH_BYTES;
          // 單筆自成一批還是過大 = 就是這一列太長,而且我們知道是第幾列
          const only = batch[0];
          failMsg = singleTooLong
            ? `第 ${only?.rowNumber ?? '?'} 列的資料過長(整列內容超過單次上傳上限,通常是備註欄),請縮短後再匯入`
            : '一次匯入的資料太多,請分檔匯入';
          if (singleTooLong && only) {
            serverErrors.push({
              row: only.rowNumber,
              field: 'note',
              message: '整列內容超過單次上傳上限,請縮短備註',
            });
          }
          break;
        }
        if (res.status === 403) {
          failMsg = '你沒有匯入名單的權限';
          break;
        }
        if (!res.ok) {
          failMsg = await apiErrorMessage(res, '匯入失敗,請稍後再試');
          break;
        }
        const data = (await res.json()) as {
          created?: number;
          skipped?: number;
          message?: string | null;
          errors?: unknown;
          errorCount?: number;
        };
        created += typeof data.created === 'number' ? data.created : 0;
        skipped += typeof data.skipped === 'number' ? data.skipped : 0;
        if (Array.isArray(data.errors)) {
          for (const raw of data.errors) {
            const e = raw as { row?: unknown; field?: unknown; message?: unknown };
            if (typeof e.field !== 'string' || typeof e.message !== 'string') continue;
            // 沒有列號(理論上不會,前端每一列都帶)就退回「無列號」,不要憑空編一個
            serverErrors.push({
              row: typeof e.row === 'number' ? e.row : 0,
              field: e.field,
              message: e.message,
            });
          }
        }
        serverErrorTotal += typeof data.errorCount === 'number' ? data.errorCount : 0;
        if (typeof data.message === 'string' && data.message && !notes.includes(data.message))
          notes.push(data.message);
        sentBatches += 1;
        sentRows += batch.length;
        const last = batch[batch.length - 1];
        const n = last ? (last as unknown as { rowNumber?: number }).rowNumber : undefined;
        lastSentRowNumber = typeof n === 'number' ? n : null;
      }
      showErrors(serverErrors, Math.max(serverErrorTotal, serverErrors.length));
      const summary = `已匯入 ${created} 筆、略過 ${skipped} 筆${dropNote}${notes.length > 0 ? `。${notes.join(';')}` : ''}`;
      if (failMsg) {
        /*
         * 中途失敗的現況要講到「使用者知道下一步怎麼辦」為止。
         *
         * 匯入不是一筆交易:前面幾批已經寫進資料庫了,而且沒有回退機制
         * (每一批是各自的一次 POST,失敗的那一批之後才停)。只講「前 N 批已送出」
         * 等於把一個半成品丟給使用者。所以要說出三件事:
         *   1. 已經送進去幾筆、對到檔案的第幾列(列號用 parseCsv 帶回來的 rowNumber,
         *      不是自己用序號推算的 —— 備註含換行時一筆記錄佔好幾行,推算會對不上)
         *   2. 已經進來的不會自動退掉
         *   3. 修好之後可以重送同一個檔案,已經進來的會被當成重複而略過
         *     (後端匯入用識別碼 / 公司名比對這位負責人既有的客戶,見 crm.service 的 import)
         */
        const upTo = lastSentRowNumber !== null ? `(檔案第 ${lastSentRowNumber} 列為止)` : '';
        const doneRange =
          sentRows > 0 ? `前 ${sentRows} 筆資料${upTo}已經送進系統` : '還沒有任何資料送進系統';
        setImportMsg(
          bigPrefix +
            (sentBatches > 0
              ? `${failMsg}。${doneRange}:${summary};第 ${sentRows + 1} 筆起沒有送出。已經寫進去的不會自動退掉,修正之後可以重新匯入同一個檔案,已經進來的那些會被當成重複而略過。`
              : `${failMsg}。${doneRange}。`),
        );
        // 中途失敗時前面幾批已經寫進資料庫了,那些也帶著同一個識別碼。
        // 這時候最需要「整批收回去」,所以識別碼一樣要給。
        if (created > 0) setLastBatch({ id: importBatchId, created });
      } else {
        setImportMsg(
          bigPrefix + (batches.length > 1 ? `${summary}(共 ${batches.length} 批)` : summary),
        );
        // 有東西寫進去才給識別碼:一筆都沒寫進去時那個 id 指不到任何客戶,
        // 顯示出來只會讓人以為有東西可以收回。
        if (created > 0) setLastBatch({ id: importBatchId, created });
        if (onDone) onDone();
      }
    } catch {
      setImportMsg(
        bigPrefix +
          (sentBatches > 0
            ? `匯入中斷,請稍後再試。前 ${sentRows} 筆資料${lastSentRowNumber !== null ? `(檔案第 ${lastSentRowNumber} 列為止)` : ''}已經送進系統:已匯入 ${created} 筆、略過 ${skipped} 筆;第 ${sentRows + 1} 筆起沒有送出。已經寫進去的不會自動退掉,重新匯入同一個檔案時,已經進來的那些會被當成重複而略過。`
            : '匯入失敗,請稍後再試。還沒有任何資料寫進系統。'),
      );
      if (created > 0) setLastBatch({ id: importBatchId, created });
    } finally {
      setImporting(false);
    }
  }

  async function handleImport() {
    setImportMsg(null);
    showErrors([]);
    setBig5Pending(null);
    setLastBatch(null);
    await postRows(parseCsv(csvText), () => setCsvText(''));
  }

  /** 使用者在確認畫面按下「用 Big5 讀取並匯入」 */
  async function confirmBig5() {
    const pending = big5Pending;
    if (!pending) return;
    setBig5Pending(null);
    setImportMsg(null);
    showErrors([]);
    await postRows(parseCsv(pending.text));
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setImportMsg(null);
    showErrors([]);
    setBig5Pending(null);
    setLastBatch(null);
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    /*
     * 大小要擋在 file.arrayBuffer() **之前**。那一支會把整個檔案讀成一塊
     * ArrayBuffer 放在記憶體裡,選到一個 500MB 的檔就是直接吃掉 500MB;
     * 手機上多半在解析開始之前分頁就被系統回收,使用者看到的是「按了沒反應」。
     * 一次上限 1000 列的 CSV 不可能有這種大小,所以這是「一定是選錯檔」的情況。
     */
    if (isUploadTooLarge(file.size)) {
      setImportMsg(uploadTooLargeMessage(file.name, file.size));
      input.value = '';
      return;
    }
    try {
      if (name.endsWith('.csv')) {
        /*
         * 刻意不用 file.text():那支 API 固定以 UTF-8 解碼,而且遇到不合法的位元組
         * 不丟例外,安靜換成 U+FFFD 就回傳。一份 Big5 的 CSV 因此會變成一份
         * 「解析零錯誤」的亂碼被整批寫進資料庫,事後只能靠回收桶整批刪掉再重來。
         * 改成自己拿 ArrayBuffer 分辨編碼,見 lib/csv-import 的 decodeCsvBuffer。
         */
        const decoded = decodeCsvBuffer(await file.arrayBuffer());
        if (!decoded.ok) {
          setImportMsg(ENCODING_BLOCKED_MESSAGE);
          return;
        }
        if (decoded.encoding === 'big5') {
          // 不自作主張:秀出用 Big5 讀到的前幾筆公司名,由使用者確認再匯入
          setBig5Pending({ text: decoded.text, fileName: file.name, sample: decoded.sample });
          setImportMsg(
            `「${file.name}」不是 UTF-8 檔,尚未匯入。` +
              '這通常是 Excel 在正體中文 Windows 上另存的 CSV(Big5)。請看下方用 Big5 讀出來的公司名是否正確。',
          );
          return;
        }
        await postRows(parseCsv(decoded.text));
      } else {
        // 只吃 CSV。以前這裡用 xlsx@0.18.5 直接在瀏覽器解試算表檔,那一版有
        // CVE-2023-30533(prototype pollution)與 CVE-2024-22363(ReDoS),
        // 而且是 npm 上的最後一版,不會再修。爆炸半徑雖然只有上傳者自己的分頁,
        // 但公開 repo 帶著已知有洞又沒人維護的相依,下游一掃就會被標出來。
        // 換 exceljs 會連帶拉進五十幾個套件、其中好幾個已標記 deprecated,
        // 等於用一棵更大的樹換一個洞。試算表軟體另存 CSV 只要兩下,所以收斂成
        // 只吃 CSV:少一個相依、少一個攻擊面,解析用的是這個檔自己的 parseCsv。
        setImportMsg('請上傳 .csv 檔。試算表軟體可用「另存新檔」選 CSV UTF-8 格式');
      }
    } catch {
      setImportMsg('檔案解析失敗,請確認格式後再試');
    } finally {
      // 清掉 input 讓同一檔可再次選取觸發 onChange
      input.value = '';
    }
  }

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUseCrm(role)) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">匯入名單</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用客戶管理。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">匯入名單</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        先下載範本填好再上傳,或直接貼上 CSV。匯入的客戶會歸在你名下。
      </p>

      <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          <a href="/crm-import-template.csv" download className="btn">
            下載匯入範本(CSV)
          </a>
          <span className="text-xs text-muted-foreground">
            先下載範本填好,再用下方「上傳檔案」匯入;或直接貼上 CSV。用 Excel
            編輯範本的話,存檔時要選「CSV UTF-8」。
          </span>
        </div>
        {/*
          範本的第一列標題是寫死在檔案裡的通用字樣,而第一欄實際的名稱由系統設定
          決定(lookupLabel),兩者不一定一樣。匯入是照欄位「位置」解析、不看標題文字,
          所以標題對不上不影響匯入 —— 但下載範本的人會以為自己填錯欄,所以這裡講明。
        */}
        <p className="text-xs text-muted-foreground">
          範本第一欄的標題寫的是通用字樣,在這套系統裡它叫「{lookupLabel}」。
          匯入是照欄位順序解析、不看標題文字,所以標題名稱不一樣不影響匯入,
          標題那一列也可以直接改成你習慣的稱呼。
        </p>
        {/*
          地址不是可有可無的一欄。三個地址全空的客戶不會有座標,拜訪地圖上看不到它,
          到訪打卡也算不出「離客戶地址多遠」(假定位偵測對那些客戶等於關閉)。
          匯入之後補地址只能一張一張客戶卡開,所以在這裡就講清楚。
        */}
        <p className="text-xs text-muted-foreground">
          後三欄的地址至少填一欄(建議填「實際營業地址」)。沒有地址的客戶不會出現在拜訪地圖上,
          到訪打卡也算不出與客戶地址的距離。匯入後再補地址,只能逐張客戶卡修改。
          地址匯入後要到拜訪地圖按「補齊地址座標」才會產生座標。
        </p>

        <label className="flex flex-col gap-1 text-sm">
          <span>上傳檔案(.csv)</span>
          <input
            type="file"
            accept=".csv"
            disabled={importing}
            onChange={(e) => void handleFile(e)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>
            或直接貼上 CSV,第一列是標題,欄位順序為:{lookupLabel}
            、公司名、聯絡人、電話、分類、進度、備註、實際營業地址、登記地址、聯絡地址。
            每列以逗號分隔,容忍空欄;標題文字不影響解析,順序才影響。
          </span>
          <textarea
            className="min-h-[140px] rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
            placeholder={`${lookupLabel},公司名,聯絡人,電話,分類,進度,備註,實際營業地址,登記地址,聯絡地址\n12345678,範例公司,王小明,0912345678,餐飲/飲料,名單/陌生,初次接觸,某某市某某區某某路 1 號,,`}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={importing}
            onClick={() => void handleImport()}
            className="btn btn-primary"
          >
            {importing ? '匯入中…' : '解析並匯入'}
          </button>
          <Link href="/admin/crm/board" className="btn">
            去看客戶看板
          </Link>
        </div>
        {/*
          編碼確認面板。用畫面上的按鈕而不是 window.confirm:confirm 的字串沒辦法排版、
          螢幕閱讀器體驗差,而且這裡要秀出樣本讓使用者用眼睛判斷。
        */}
        {big5Pending ? (
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="font-medium">這個檔要用 Big5 讀讀看嗎?</p>
            <p className="mt-1 text-muted-foreground">
              「{big5Pending.fileName}」不是 UTF-8 檔。正體中文 Windows 的 Excel
              另存的「CSV」預設就是 Big5。下面是改用 Big5 讀出來的前幾筆公司名:
            </p>
            <ul className="mt-2 list-inside list-disc font-mono">
              {big5Pending.sample.length > 0 ? (
                big5Pending.sample.map((v, i) => <li key={`${i}-${v}`}>{v}</li>)
              ) : (
                <li className="font-sans text-muted-foreground">(這個檔第二欄沒有內容可以預覽)</li>
              )}
            </ul>
            <p className="mt-2 text-muted-foreground">
              看起來是正確的公司名就按下面的按鈕匯入;還是亂碼的話請取消,回試算表軟體用
              「另存新檔」選「CSV UTF-8(逗號分隔)」再匯入一次。
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={importing}
                onClick={() => void confirmBig5()}
              >
                用 Big5 讀取並匯入
              </button>
              <button
                type="button"
                className="btn"
                disabled={importing}
                onClick={() => {
                  setBig5Pending(null);
                  setImportMsg('已取消,沒有匯入任何資料。');
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        <div role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-foreground">
          <p>{importMsg}</p>
          {/*
            這一批的識別碼。整次匯入(不管切成幾批 POST)只有一個,貼到資料管理頁的
            「整批處理匯入的客戶」就能把這一次匯進來的全部一次收回去。
            用 <code> 而不是輸入框:它是要被讀出來與複製的值,不是要被編輯的欄位。
          */}
          {lastBatch ? (
            <div className="mt-2 rounded-md border border-border bg-background p-3">
              <p className="font-medium">這一批的識別碼</p>
              <p className="mt-1 break-all font-mono text-sm">{lastBatch.id}</p>
              <p className="mt-1 text-muted-foreground">
                這一次匯進來的 {lastBatch.created} 筆都帶著這個識別碼(分成幾批送出不影響)。
                {canBatchUndo
                  ? '匯錯的話,把它貼到「資料管理」頁的「整批處理匯入的客戶」,一個動作就能整批收回。那一頁也可以直接從「最近幾次匯入」挑,不必自己記這一串。'
                  : '匯錯的話,把這一串交給訪查主管或系統管理員,他們在「資料管理」頁一個動作就能整批收回。整批刪除與整批還原都要主管權限,按得下去的人就救得回來。'}
              </p>
              {canBatchUndo && (
                <p className="mt-2">
                  <Link href="/admin/crm/data" className="underline underline-offset-2">
                    去資料管理頁
                  </Link>
                </p>
              )}
            </div>
          ) : null}
          {cellErrors.length > 0 ? (
            <div className="mt-2">
              <p className="font-medium">要修的欄位(指到第幾列第幾欄):</p>
              <ul className="mt-1 list-inside list-disc">
                {cellErrors.map((e) => (
                  <li key={`${e.row}-${e.field}-${e.message}`}>
                    {formatCellError(e, lookupLabel)}
                  </li>
                ))}
              </ul>
              {cellErrorTotal > cellErrors.length ? (
                <p className="mt-1 text-muted-foreground">
                  還有 {cellErrorTotal - cellErrors.length} 條沒有列出來,修完上面這些再匯入一次。
                </p>
              ) : null}
              <p className="mt-1 text-muted-foreground">列號是試算表看到的列號,標題是第 1 列。</p>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-6 text-sm">
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回我的首頁
        </Link>
      </p>
    </div>
  );
}
