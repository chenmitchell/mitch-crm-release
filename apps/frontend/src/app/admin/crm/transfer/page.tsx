'use client';

// ref:3687 mc/陳彥輔/米球®
// 批次轉派(/admin/crm/transfer)。限訪查主管與系統管理員。
//
// 為什麼需要這一頁:匯入名單一律把客戶歸在匯入者名下,而客戶卡上的移交一次只能一筆。
// 一份兩千筆的名單要分給二十幾位訪查人員,沒有這一頁就只能開兩千張客戶卡。
//
// 資料來源:GET /api/admin/crm(依負責人篩選 / 關鍵字)、GET /api/admin/crm/sales-users、
//          POST /api/admin/crm/transfer-batch(一次最多 200 筆,超過就自動分批送)。
// 送出結果逐筆回報:轉成功幾筆、哪幾筆沒成功、為什麼。
// 無障礙:單一 h1、勾選有對應 label、結果 role="status" aria-live、按鈕 >= 44px(.btn 已含)。

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiErrorMessage } from '@/lib/api-error';
import {
  canUseCrm,
  crmApiBase,
  fetchCustomers,
  isViewAllRole,
  useCrmRole,
  type DevCustomer,
} from '@/lib/crm-shared';
import { useLookupLabel } from '@/lib/app-settings';

/**
 * 後端 TransferBatchDto 的 TRANSFER_BATCH_MAX。兩邊要一樣:
 * 這裡放行、後端擋下的話,使用者拿到的是一整批 400,而不是「已經轉了幾筆」。
 */
const TRANSFER_BATCH_MAX = 200;

/** 一次從清單載幾筆(後端 clampListTake 的上限之內) */
const LIST_TAKE = 500;

interface SalesUser {
  id: string;
  name: string;
}

export default function CrmTransferPage() {
  const role = useCrmRole();
  const lookupLabel = useLookupLabel();
  const [users, setUsers] = useState<SalesUser[]>([]);
  const [fromOwnerId, setFromOwnerId] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<DevCustomer[]>([]);
  /** 清單還有下一頁沒載進來(後端有筆數上限)。畫面要說出來,不能安靜截斷 */
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toUserId, setToUserId] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 逐筆失敗原因;成功的不列(列出來只是噪音) */
  const [failures, setFailures] = useState<Array<{ id: string; message: string }>>([]);

  const allowed = canUseCrm(role) && isViewAllRole(role);

  useEffect(() => {
    if (!allowed) return;
    void (async () => {
      try {
        const res = await fetch(`${crmApiBase()}/sales-users`, { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as { rows?: SalesUser[] };
        setUsers(Array.isArray(data.rows) ? data.rows : []);
      } catch {
        // 名單載不到不擋操作,下面的訊息會說「請重新整理」
      }
    })();
  }, [allowed]);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    setFailures([]);
    try {
      const out = await fetchCustomers({
        ownerId: fromOwnerId || undefined,
        q: q.trim() || undefined,
        limit: LIST_TAKE,
      });
      if (!out) {
        setMsg('載入客戶清單失敗,請稍後再試。');
        return;
      }
      setRows(out.rows);
      setMore(out.nextCursor !== null);
      // 換一批清單就把勾選清掉:留著上一批的勾選,使用者按下轉派時會轉到看不見的客戶
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [fromOwnerId, q]);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }

  async function submit() {
    if (working) return;
    const ids = [...selected];
    if (ids.length === 0) {
      setMsg('請先勾選要轉派的客戶。');
      return;
    }
    if (!toUserId) {
      setMsg('請先選擇要轉給誰。');
      return;
    }
    setWorking(true);
    setFailures([]);
    let transferred = 0;
    const failed: Array<{ id: string; message: string }> = [];
    let stopped: string | null = null;
    /*
     * 超過後端上限就自己分批送。分批不是交易:前面幾批已經寫進資料庫且不會回退,
     * 所以中途失敗時要說出「已經轉了幾筆、從第幾筆起沒送出」,跟匯入頁同一個口徑。
     */
    try {
      for (let i = 0; i < ids.length; i += TRANSFER_BATCH_MAX) {
        const chunk = ids.slice(i, i + TRANSFER_BATCH_MAX);
        setMsg(`轉派中:已完成 ${transferred} / ${ids.length} 筆…`);
        const res = await fetch(`${crmApiBase()}/transfer-batch`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerIds: chunk, toUserId }),
        });
        if (!res.ok) {
          stopped = await apiErrorMessage(res, '轉派失敗,請稍後再試');
          break;
        }
        const data = (await res.json()) as {
          transferred?: number;
          failed?: Array<{ id?: unknown; message?: unknown }>;
        };
        transferred += typeof data.transferred === 'number' ? data.transferred : 0;
        for (const f of data.failed ?? []) {
          if (typeof f.id === 'string' && typeof f.message === 'string')
            failed.push({ id: f.id, message: f.message });
        }
      }
      setFailures(failed);
      const who = users.find((u) => u.id === toUserId)?.name ?? '所選人員';
      const base = `已轉派 ${transferred} 筆給${who}${failed.length > 0 ? `,${failed.length} 筆沒轉成功` : ''}`;
      setMsg(
        stopped
          ? `${stopped}。${base};已經轉出去的不會自動退回,可以重新勾選剩下的再送一次。`
          : `${base}。`,
      );
      await load();
    } catch {
      setMsg(
        transferred > 0
          ? `轉派中斷,請稍後再試。已轉派 ${transferred} 筆,已經轉出去的不會自動退回。`
          : '轉派失敗,請稍後再試。沒有任何客戶被轉派。',
      );
    } finally {
      setWorking(false);
    }
  }

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!allowed) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">批次轉派</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          批次轉派僅限訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">批次轉派</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        匯入的客戶都歸在匯入者名下。這一頁可以一次把多筆客戶轉給別人,一次最多 {TRANSFER_BATCH_MAX}{' '}
        筆(勾更多會自動分批送出)。可轉派的對象與可看到的客戶都依你的可見範圍決定。
      </p>

      <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>目前負責人</span>
            <select
              className="min-h-[44px] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={fromOwnerId}
              onChange={(e) => setFromOwnerId(e.target.value)}
            >
              <option value="">(全部)</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>關鍵字(公司名 / {lookupLabel} / 聯絡人 / 電話)</span>
            <input
              className="min-h-[44px] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
            {loading ? '載入中…' : '查詢'}
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>轉給</span>
            <select
              className="min-h-[44px] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={toUserId}
              onChange={(e) => setToUserId(e.target.value)}
            >
              <option value="">(請選擇)</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={working || selected.size === 0 || !toUserId}
            onClick={() => void submit()}
          >
            {working ? '轉派中…' : `轉派已勾選的 ${selected.size} 筆`}
          </button>
          <button type="button" className="btn" disabled={rows.length === 0} onClick={toggleAll}>
            {selected.size === rows.length && rows.length > 0 ? '全部取消勾選' : '勾選這一頁全部'}
          </button>
        </div>

        {more ? (
          <p role="status" className="text-xs font-semibold text-foreground">
            符合條件的客戶超過一次能載入的 {LIST_TAKE} 筆,下面顯示的不是全部。
            請用「目前負責人」或關鍵字縮小範圍,分幾次轉派。
          </p>
        ) : null}

        <div role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-foreground">
          {msg}
        </div>

        {failures.length > 0 ? (
          <div className="text-sm">
            <p className="font-medium">沒轉成功的客戶:</p>
            <ul className="mt-1 list-inside list-disc">
              {failures.slice(0, 20).map((f) => (
                <li key={f.id}>
                  {rows.find((r) => r.id === f.id)?.companyName ?? f.id}:{f.message}
                </li>
              ))}
            </ul>
            {failures.length > 20 ? (
              <p className="mt-1 text-muted-foreground">
                還有 {failures.length - 20} 筆沒有列出來。
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">可轉派的客戶清單</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="p-2">
                  勾選
                </th>
                <th scope="col" className="p-2">
                  公司名
                </th>
                <th scope="col" className="p-2">
                  {lookupLabel}
                </th>
                <th scope="col" className="p-2">
                  目前負責人
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="p-2">
                    {/* 勾選框包在 label 裡面(不是用 htmlFor 當兄弟):globals.css 的 44px 命中區
                        是靠 label:has(> input[type='checkbox']) 撐的,兄弟寫法選擇器不成立。
                        高度那一半由那條規則給,寬度這一半要自己補:名稱是 sr-only(絕對定位,
                        不佔寬),所以 20px 的勾選框左右各加 12px 內距補到 44px。
                        用內距不用 min-width:min-width 的 utility 會整層蓋掉 base 立下的
                        命中區保證,那是 p2 探針在擋的東西。 */}
                    <label htmlFor={`pick-${r.id}`} className="justify-center px-3">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        id={`pick-${r.id}`}
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                      <span className="sr-only">勾選{r.companyName}</span>
                    </label>
                  </td>
                  <td className="p-2">{r.companyName}</td>
                  <td className="p-2">{r.taxId ?? '—'}</td>
                  <td className="p-2">{r.owner?.name ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="p-2 text-muted-foreground">
                    沒有符合條件的客戶。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-6 text-sm">
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回訪查首頁
        </Link>
      </p>
    </div>
  );
}
