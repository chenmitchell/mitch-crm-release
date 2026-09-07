'use client';

// 資料管理頁(/admin/crm/data):匯出與回收桶。
//
// 這一頁回答兩個「一家公司上線前一定會問」的問題:
//   1. 匯錯了怎麼收回去    → 回收桶(軟刪除的客戶,可以逐筆或整批還原)
//   2. 換系統時資料怎麼帶走 → 三支匯出(客戶、互動紀錄、存證照片清單)
//
// 資料來源:
//   GET  /api/admin/crm-export/customers | interactions | photos   CSV 附件
//   GET  /api/admin/crm-trash                                      回收桶清單
//   GET  /api/admin/crm-trash/import-batches                       最近幾次匯入(給下拉挑)
//   POST /api/admin/crm-trash/:id/restore                          還原
//   POST /api/admin/crm-trash/import-batch/delete | restore        整批
//   DELETE /api/admin/crm-trash/:id                                永久刪除(只有 admin)
//
// 匯出走 fetch 而不是 <a download>:一次最多 5000 筆,超過的部分會被截斷,
// 而「這一次有沒有被截斷、下一段從第幾筆開始」只在回應標頭裡(X-Export-Truncated /
// X-Export-Next-Offset),<a download> 讀不到任何一個標頭。匯出又有每分鐘 6 次的
// 速率限制,用 <a download> 時 429 的 JSON 會被瀏覽器當成一份文件開起來,
// 使用者看到的是一頁 {"statusCode":429,...}。兩件事都只有 fetch 拿得到。
// 跨網域部署時那幾個標頭還要後端 enableCors 的 exposedHeaders 放行(見 apps/backend/src/main.ts)。
//
// 角色:匯出是 admin / 訪查人員 / 訪查主管都能用,範圍由後端依 ViewScope 限縮;
//       回收桶與整批處理(列批次 / 整批刪除 / 整批還原)是 admin / 訪查主管;
//       永久刪除只有 admin。前端隱藏只是輔助,實際擋在後端。
//       整批刪除原本訪查人員也按得下去,而回收桶與還原是 403 —— 一個動作可以把
//       兩千筆推進一個自己看不到也還不回來的地方。兩端門檻已經對齊(見後端 controller)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { canUseCrm, isViewAllRole, useCrmRole, useStageMeta } from '@/lib/crm-shared';
import {
  EXPORT_RATE_LIMITED_MESSAGE,
  describeExportSuccess,
  fileNameFromDisposition,
} from '@/lib/export-result';
import { describeBatchDelete, describeBatchRestore, type RestoreSkipped } from '@/lib/batch-result';

interface ImportBatchRow {
  importBatchId: string;
  count: number;
  firstCreatedAt: string | null;
}

interface TrashRow {
  id: string;
  companyName: string;
  taxId: string | null;
  stage: string;
  ownerName: string | null;
  deletedAt: string | null;
  deletedByName: string | null;
  deleteReason: string | null;
  importBatchId: string | null;
  interactions: number;
  photos: number;
}

/** 匯出的三支端點。名稱與說明放在同一處,新增一支不會漏掉說明 */
const EXPORTS = [
  {
    path: 'customers',
    label: '客戶清單',
    hint: '前十欄與匯入格式相同,改完可以直接從「匯入名單」匯回來。',
  },
  {
    path: 'interactions',
    label: '互動紀錄',
    hint: '含拜訪打卡、備註與系統紀錄(移交、成交),每列標明客戶與記錄者。',
  },
  {
    path: 'photos',
    label: '存證照片清單',
    hint: '照片本身不在這份檔案裡。每列有下載路徑與 SHA-256,照著逐張取回並驗證。',
  },
] as const;

/** 一次匯出跑完之後,畫面要講的話與(被截斷時)下一段從第幾筆開始 */
interface ExportState {
  message: string;
  /** 被截斷時的下一段起點;沒有就是這一支已經匯完了 */
  nextOffset: number | null;
  busy: boolean;
}

/** 把拿到的 blob 存成檔案。用完就把 object URL 收回來,不然它會活到整頁關掉為止 */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分瀏覽器上會讓下載失敗,給它一點時間
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function CrmDataPage() {
  const role = useCrmRole();
  const stageMeta = useStageMeta();
  const canUse = canUseCrm(role);
  // 回收桶是主管級功能:業務刪掉之後要找主管還原,這是刻意的分界
  const canTrash = isViewAllRole(role);
  const isAdmin = role === 'admin';

  const [rows, setRows] = useState<TrashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batches, setBatches] = useState<ImportBatchRow[]>([]);
  /**
   * 整批還原時被跳過的那幾筆。狀態列只放得下前三筆,明細另外列出來。
   *
   * rows 是後端截斷過的明細(最多 50 筆),count 是真實總數 ——
   * 兩格分開存,畫面上的數字才不會被截斷長度蓋掉(見 lib/batch-result.ts)。
   */
  const [skippedRows, setSkippedRows] = useState<RestoreSkipped[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  /** 每一支匯出各自的狀態(訊息、下一段起點、是否進行中),key 是 EXPORTS 的 path */
  const [exportState, setExportState] = useState<Record<string, ExportState>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);

  const exportBase = `${getApiBase()}/api/admin/crm-export`;
  const trashBase = `${getApiBase()}/api/admin/crm-trash`;

  const load = useCallback(async () => {
    if (role === null) return;
    if (!canTrash) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(trashBase, { credentials: 'include' });
      if (!res.ok) {
        setError(await apiErrorMessage(res, '回收桶載入失敗,請稍後再試'));
        return;
      }
      const data = (await res.json()) as { rows?: TrashRow[] };
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setError('讀取回收桶失敗,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canTrash, trashBase]);

  /**
   * 最近幾次匯入。沒有這一份清單的話,「刪掉這一批」等於要使用者自己記住
   * 匯入當下畫面上那一串 uuid,而想用到它的時候(發現匯錯了)畫面早就關了。
   */
  const loadBatches = useCallback(async () => {
    if (role === null || !canTrash) return;
    try {
      const res = await fetch(`${trashBase}/import-batches`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as { rows?: ImportBatchRow[] };
      setBatches(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      // 這份清單只是方便挑選,讀不到就讓使用者自己貼識別碼,不要跳錯誤把整頁擋掉
    }
  }, [role, canTrash, trashBase]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  /**
   * 跑一次匯出。
   *
   * 用 fetch 不用 <a download> 的兩個理由都在畫面上看得到:
   *   1. 一次最多 5000 筆。超過的部分後端會截斷,並用 X-Export-Truncated 與
   *      X-Export-Next-Offset 交代 —— 那兩個標頭 <a download> 讀不到,
   *      使用者只會拿到一個「看起來很完整」的檔,少掉的那幾千筆不會有人發現。
   *   2. 每分鐘 6 次的速率限制。用 <a download> 時,429 的 JSON 會被瀏覽器
   *      當成一份文件開起來,畫面變成一頁 {"statusCode":429,...}。
   *
   * 代價是整份 CSV 會先進記憶體再存檔。上限 5000 筆的 CSV 是幾 MB 的量級,
   * 在這個代價與「使用者不知道自己少匯了幾千筆」之間,選前者。
   */
  async function runExport(path: string, label: string, offset: number) {
    setExportState((prev) => ({
      ...prev,
      [path]: { message: `匯出中:${label}…`, nextOffset: null, busy: true },
    }));
    const done = (message: string, nextOffset: number | null) =>
      setExportState((prev) => ({ ...prev, [path]: { message, nextOffset, busy: false } }));
    try {
      const url = offset > 0 ? `${exportBase}/${path}?offset=${offset}` : `${exportBase}/${path}`;
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 429) {
        // 速率限制是「每個對外 IP 每分鐘 6 次」。一整間辦公室走同一個 NAT 出去時,
        // 這個額度是全辦公室一起算的,所以要講明白,不然使用者會以為是自己按太快。
        // 舊版的 <a download> 在這裡會把 429 的 JSON 直接導成一個頁面。
        done(EXPORT_RATE_LIMITED_MESSAGE, null);
        return;
      }
      if (!res.ok) {
        done(`匯出失敗:${await apiErrorMessage(res, '匯出失敗,請稍後再試')}`, null);
        return;
      }
      const blob = await res.blob();
      const fallback = `${path}.csv`;
      saveBlob(blob, fileNameFromDisposition(res.headers.get('Content-Disposition'), fallback));

      // 判讀與說法在 lib/export-result(純函式,測得到)。這裡只負責把標頭遞進去。
      // 讀不到標頭時那一支會少講一句,而不是顯示「已下載 0 筆」——
      // 跨網域部署下沒被 exposedHeaders 放行的話,這幾個 get() 一律是 null。
      const outcome = describeExportSuccess(label, {
        count: res.headers.get('X-Export-Count'),
        truncated: res.headers.get('X-Export-Truncated'),
        nextOffset: res.headers.get('X-Export-Next-Offset'),
        totalBytes: res.headers.get('X-Export-Total-Bytes'),
      });
      done(outcome.message, outcome.nextOffset);
    } catch {
      done('匯出失敗:連線異常,請稍後再試。沒有任何資料被帶出系統。', null);
    }
  }

  async function restore(row: TrashRow) {
    setBusyId(row.id);
    setStatus(`還原中:${row.companyName}`);
    try {
      const res = await fetch(`${trashBase}/${row.id}/restore`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setStatus(`還原失敗:${await apiErrorMessage(res, '還原失敗,請稍後再試')}`);
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setStatus(`已還原:${row.companyName},階段與負責人都沒有變`);
      headingRef.current?.focus();
    } catch {
      setStatus('還原失敗:連線異常,請稍後再試');
    } finally {
      setBusyId(null);
    }
  }

  async function purge(row: TrashRow) {
    setBusyId(row.id);
    setStatus(`永久刪除中:${row.companyName}`);
    try {
      const res = await fetch(`${trashBase}/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        setStatus(`永久刪除失敗:${await apiErrorMessage(res, '永久刪除失敗,請稍後再試')}`);
        return;
      }
      const data = (await res.json()) as { interactions?: number; photos?: number };
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setConfirmPurgeId(null);
      setStatus(
        `已永久刪除:${row.companyName},一併移除 ${data.interactions ?? 0} 筆互動與 ${data.photos ?? 0} 張存證照片`,
      );
      headingRef.current?.focus();
    } catch {
      setStatus('永久刪除失敗:連線異常,請稍後再試');
    } finally {
      setBusyId(null);
    }
  }

  async function batchAction(kind: 'delete' | 'restore') {
    const id = batchId.trim();
    if (!id) {
      setStatus('請先填入匯入批次識別碼(匯入完成的畫面上會顯示)');
      return;
    }
    setBatchBusy(true);
    setSkippedRows([]);
    setSkippedCount(0);
    setStatus(kind === 'delete' ? '整批刪除中…' : '整批還原中…');
    try {
      const res = await fetch(`${trashBase}/import-batch/${kind}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'delete' ? { importBatchId: id, reason: '整批匯入錯誤' } : { importBatchId: id },
        ),
      });
      if (!res.ok) {
        setStatus(`操作失敗:${await apiErrorMessage(res, '這一批處理失敗,請確認識別碼')}`);
        return;
      }
      if (kind === 'delete') {
        const data = (await res.json()) as { deleted?: number; blockedCount?: number };
        setStatus(describeBatchDelete(data.deleted ?? 0, data.blockedCount ?? 0));
      } else {
        /*
         * skipped 一定要印出來。
         *
         * 整批還原會逐筆檢查「階段還在不在、案件編號有沒有被佔走」,擋下來的那幾筆
         * 留在回收桶裡並附上原因。只印 restored 的話,使用者看到「已還原 8 筆」
         * 但回收桶裡還剩 2 筆,而畫面沒有任何一句話交代為什麼 ——
         * 整批刪除那一半有好好印 blockedCount,這一半沒有。
         */
        const data = (await res.json()) as {
          restored?: number;
          skipped?: RestoreSkipped[];
          skippedCount?: number;
        };
        const skipped = Array.isArray(data.skipped) ? data.skipped : [];
        // 總數吃 skippedCount。skipped 只是明細,而且後端最多回 50 筆:
        // 拿它的長度當總數,一批 60 筆整批被擋時畫面會寫「另有 50 筆」,
        // 回收桶裡實際上還有 60 筆。skippedCount 沒回來(舊版後端)才退回明細長度。
        const total = typeof data.skippedCount === 'number' ? data.skippedCount : skipped.length;
        setStatus(describeBatchRestore(data.restored ?? 0, skipped, total));
        setSkippedRows(skipped);
        setSkippedCount(total);
      }
      await load();
      await loadBatches();
      headingRef.current?.focus();
    } catch {
      setStatus('操作失敗:連線異常,請稍後再試');
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="outline-none">
            資料管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            把資料帶出系統,以及把刪掉的客戶救回來。刪除是可還原的:客戶會從清單、看板、秒查、查重、統計與地圖消失,資料本身還在。
          </p>
        </div>
        <Link href="/admin/crm/home" className="btn">
          回我的首頁
        </Link>
      </header>

      <p role="status" aria-live="polite" className="min-h-[1.5rem] text-sm text-foreground">
        {status}
      </p>

      {role !== null && !canUse && (
        <p className="rounded-md border border-border bg-surface p-3 text-sm text-foreground">
          你的帳號沒有客戶管理的使用權限,請找系統管理員開通。
        </p>
      )}

      {canUse && (
        <section className="card" aria-labelledby="export-title">
          <h2 id="export-title" className="section-title">
            匯出資料
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            檔案是 UTF-8 帶 BOM 的 CSV,Excel 直接打得開。你匯得到的範圍與你在系統裡看得到的一樣。
            每一次匯出都會留下稽核紀錄。一次最多 5000 筆,超過的時候按鈕下面會直接出現
            「繼續下載下一段」,不必自己算<code className="mx-1">offset</code>。匯出是每分鐘最多 6
            次,而且以對外 IP 計算:同一間辦公室共用一條網路時,這個額度是大家一起用的。
          </p>
          <ul className="flex flex-col gap-3">
            {EXPORTS.map((e) => {
              const st = exportState[e.path];
              return (
                <li key={e.path} className="rounded-md border border-border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{e.label}</span>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={st?.busy ?? false}
                      onClick={() => void runExport(e.path, e.label, 0)}
                    >
                      {st?.busy ? '匯出中…' : `下載 ${e.label} CSV`}
                    </button>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{e.hint}</p>
                  {/* 每一支各自一個 live region:三支共用一個的話,按第二支時
                      螢幕閱讀器會把第一支的結果一起重念一次 */}
                  <p
                    role="status"
                    aria-live="polite"
                    className="mt-1 min-h-[1.25rem] text-sm text-foreground"
                  >
                    {st?.message ?? ''}
                  </p>
                  {st && !st.busy && st.nextOffset !== null && (
                    <button
                      type="button"
                      className="btn mt-1"
                      onClick={() => void runExport(e.path, e.label, st.nextOffset ?? 0)}
                    >
                      繼續下載下一段(從第 {st.nextOffset + 1} 筆起)
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            整套資料庫的搬移(含照片本體)請看安裝與部署文件的「資料如何取出」那一節,做法是{' '}
            <code>pg_dump</code>。
          </p>
        </section>
      )}

      {canTrash && (
        <section className="card" aria-labelledby="batch-title">
          <h2 id="batch-title" className="section-title">
            整批處理匯入的客戶
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            匯入完成的畫面上會顯示這一批的識別碼。貼進來就能一次刪掉整批匯錯的資料,或把刪掉的整批還原。
            這一批裡如果有客戶已經被拜訪過、拍過照或已成交,那幾筆會被保留下來並逐筆說明。
          </p>
          {batches.length > 0 && (
            <div className="mb-3">
              <label className="field-label" htmlFor="batch-pick">
                最近幾次匯入
              </label>
              <select
                id="batch-pick"
                className="input"
                value={batches.some((b) => b.importBatchId === batchId) ? batchId : ''}
                onChange={(ev) => setBatchId(ev.target.value)}
                disabled={batchBusy}
              >
                <option value="">自己貼識別碼…</option>
                {batches.map((b) => (
                  <option key={b.importBatchId} value={b.importBatchId}>
                    {fmtTime(b.firstCreatedAt)} 匯入的 {b.count} 筆
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 basis-72">
              <label className="field-label" htmlFor="batch-id">
                匯入批次識別碼
              </label>
              <input
                id="batch-id"
                className="input"
                value={batchId}
                onChange={(ev) => setBatchId(ev.target.value)}
                placeholder="例:0f6a2c1e-...."
                autoComplete="off"
                spellCheck={false}
                disabled={batchBusy}
              />
            </div>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void batchAction('delete')}
              disabled={batchBusy || batchId.trim().length === 0}
            >
              刪除這一批
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void batchAction('restore')}
              disabled={batchBusy || batchId.trim().length === 0}
            >
              還原這一批
            </button>
          </div>

          {skippedCount > 0 && (
            <div className="mt-3 rounded-md border border-border bg-surface p-3">
              <h3 className="text-sm font-medium text-foreground">
                還留在回收桶的 {skippedCount} 筆
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-foreground">
                {skippedRows.map((r, i) => (
                  <li key={r.id ?? `${r.companyName}-${i}`}>
                    {r.companyName}:{r.message}
                  </li>
                ))}
              </ul>
              {skippedCount > skippedRows.length && (
                <p className="mt-2 text-sm text-muted-foreground">
                  以上只列出前 {skippedRows.length} 筆,其餘 {skippedCount - skippedRows.length}{' '}
                  筆的原因相同或相近,處理完再按一次還原即可。
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {role !== null && canUse && !canTrash && (
        <p className="rounded-md border border-border bg-surface p-3 text-sm text-foreground">
          回收桶與整批處理都要訪查主管或系統管理員。整批刪除與整批還原是同一個門檻,
          按得下去的人就救得回來。刪錯了請聯絡主管還原,資料還在。
        </p>
      )}

      {canTrash && (
        <section className="card" aria-labelledby="trash-title">
          <h2 id="trash-title" className="section-title">
            回收桶
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            已刪除的客戶。還原之後階段、負責人、互動與照片都跟刪除前一樣,一格都不會變。
          </p>

          {loading && <p className="text-sm text-muted-foreground">載入中…</p>}

          {error && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-3 text-sm">
              <span className="text-foreground">{error}</span>
              <button type="button" className="btn" onClick={() => void load()}>
                重新讀取
              </button>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <p className="text-sm text-foreground">回收桶是空的。</p>
          )}

          {rows.length > 0 && (
            <ul className="flex flex-col gap-3" aria-label="已刪除的客戶">
              {rows.map((r) => {
                const busy = busyId === r.id;
                const confirming = confirmPurgeId === r.id;
                return (
                  <li key={r.id} className="rounded-md border border-border bg-background p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-foreground">
                          {r.companyName || r.taxId || '(未命名)'}
                        </p>
                        <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm text-muted-foreground sm:grid-cols-2">
                          <div>
                            <dt className="inline">刪除時間:</dt>
                            <dd className="inline"> {fmtTime(r.deletedAt)}</dd>
                          </div>
                          <div>
                            <dt className="inline">刪除者:</dt>
                            <dd className="inline"> {r.deletedByName ?? '(帳號已不存在)'}</dd>
                          </div>
                          <div>
                            <dt className="inline">負責人:</dt>
                            <dd className="inline"> {r.ownerName ?? '—'}</dd>
                          </div>
                          <div>
                            <dt className="inline">刪除前階段:</dt>
                            <dd className="inline"> {stageMeta.label(r.stage)}</dd>
                          </div>
                          <div>
                            <dt className="inline">原因:</dt>
                            <dd className="inline"> {r.deleteReason ?? '(未填)'}</dd>
                          </div>
                          <div>
                            <dt className="inline">連帶資料:</dt>
                            <dd className="inline">
                              {' '}
                              {r.interactions} 筆互動、{r.photos} 張存證照片
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => void restore(r)}
                          disabled={busy}
                        >
                          還原
                        </button>
                        {isAdmin && !confirming && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setConfirmPurgeId(r.id)}
                            disabled={busy}
                          >
                            永久刪除
                          </button>
                        )}
                      </div>
                    </div>
                    {isAdmin && confirming && (
                      <div className="mt-2 rounded-md border border-border bg-surface p-3 text-sm">
                        <p className="text-foreground">
                          永久刪除會連 {r.interactions} 筆互動與 {r.photos}{' '}
                          張存證照片一起移除,而且救不回來。確定嗎?
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => void purge(r)}
                            disabled={busy}
                          >
                            確定永久刪除
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setConfirmPurgeId(null)}
                            disabled={busy}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
