// ref:3687 mc/陳彥輔/米球®
'use client';

// 組織部門維護(系統設定的「組織部門」頁籤)。
//
// 為什麼要有這一頁:訪查主管的可見範圍是「所屬主管指向他的人」加上「他所屬部門子樹裡的人」,
// 兩者都只有安裝精靈設得了的話,裝完就再也改不動 —— 升上來的主管看板永遠是空的。
// 部門的四支端點(GET / POST / PATCH / DELETE /api/admin/departments)本來就在,
// 缺的只是介面。
//
// 為什麼不跟系統設定的「儲存全部設定」一起送:部門是自己的資料表,
// 每一筆是獨立的 CRUD,不是 app-settings 那包 JSON。混在一起的話,
// 「按了儲存全部設定,部門卻沒存到」會變成一個查不出來的問題。所以這裡每個動作即時送出,
// 畫面上也寫清楚。
//
// 無障礙:每個輸入都有 <label>;按鈕與輸入框最小 44px;
// 成功與失敗都用文字寫出來(role=status / role=alert),不只靠顏色;
// 刪除要二次確認,確認狀態同樣是文字不是只換顏色。

import { useCallback, useEffect, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';

export interface DepartmentRow {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  /** 直接掛在這個部門底下的人數(不含子部門) */
  memberCount: number;
}

type Flash = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null;

/**
 * 依上下層關係排出顯示順序,並算出每一列的深度。
 *
 * 有環也不會無限迴圈:走過的節點不再展開。部門是人維護的資料,
 * 「A 的上層是 B、B 的上層是 A」遲早會出現,而它在畫面上造成的是整頁當掉。
 * 連不到根的節點(上層被刪掉、或就是環的一部分)一律補在最後面,深度算 0,
 * 不能讓它們從畫面上消失 —— 看不到就改不掉。
 */
export function orderDepartments(
  rows: readonly DepartmentRow[],
): Array<{ row: DepartmentRow; depth: number }> {
  const childrenOf = new Map<string | null, DepartmentRow[]>();
  for (const r of rows) {
    const key = r.parentId;
    const list = childrenOf.get(key) ?? [];
    list.push(r);
    childrenOf.set(key, list);
  }
  const byOrder = (a: DepartmentRow, b: DepartmentRow) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-Hant');
  for (const list of childrenOf.values()) list.sort(byOrder);

  const out: Array<{ row: DepartmentRow; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const row of childrenOf.get(parentId) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const row of [...rows].sort(byOrder)) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      out.push({ row, depth: 0 });
    }
  }
  return out;
}

/** 這個部門可以選哪些上層:自己與自己的子樹都不行(那會讓這一段從根連不到) */
export function allowedParents(rows: readonly DepartmentRow[], id: string): DepartmentRow[] {
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = childrenOf.get(r.parentId) ?? [];
    list.push(r.id);
    childrenOf.set(r.parentId, list);
  }
  const banned = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const child of childrenOf.get(cur) ?? []) {
      if (banned.has(child)) continue;
      banned.add(child);
      queue.push(child);
    }
  }
  return rows.filter((r) => !banned.has(r.id));
}

/**
 * 後端錯誤訊息一律走 lib/api-error 的 apiErrorMessage:規則(只有 4xx 且訊息含中文
 * 才原樣顯示,其餘退回自己的說明)定義在那一支的檔頭,不在這裡各寫一份。
 * 這裡原本自己解析 body.message,而它會把 5xx 的框架英文錯誤直接顯示給使用者。
 */
function readError(res: Response): Promise<string> {
  return apiErrorMessage(res, `操作失敗(HTTP ${res.status})`);
}

export function DepartmentsEditor() {
  const [rows, setRows] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<Flash>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newParentId, setNewParentId] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/departments`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setFlash({ kind: 'error', text: await readError(res) });
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { departments?: DepartmentRow[] };
      setRows(data.departments ?? []);
      setLoading(false);
    } catch (err) {
      setFlash({ kind: 'error', text: (err as Error).message });
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      setFlash({ kind: 'error', text: '請先填部門名稱' });
      return;
    }
    setCreating(true);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/departments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          parentId: newParentId || null,
          sortOrder: (rows.length + 1) * 10,
        }),
      });
      if (!res.ok) {
        setFlash({ kind: 'error', text: await readError(res) });
        return;
      }
      setNewName('');
      setNewParentId('');
      setFlash({ kind: 'success', text: `已新增部門「${name}」` });
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function patch(row: DepartmentRow, body: Record<string, unknown>, okText: string) {
    setBusyId(row.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/departments/${row.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setFlash({ kind: 'error', text: await readError(res) });
        await load();
        return;
      }
      setFlash({ kind: 'success', text: okText });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(row: DepartmentRow) {
    setBusyId(row.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/departments/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        // 底下還有人或還有子部門時後端會說清楚是哪一種、還有幾筆,原樣顯示
        setFlash({ kind: 'error', text: await readError(res) });
        return;
      }
      setFlash({ kind: 'success', text: `已刪除部門「${row.name}」` });
      setConfirmId(null);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const ordered = orderDepartments(rows);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="page-h2">組織部門</h2>
        <p className="page-subtle max-w-[70ch]">
          訪查主管看得到自己所屬部門子樹裡每一位成員的客戶,所以部門結構直接決定可見範圍。
          成員要掛哪個部門,在使用者管理的編輯視窗裡改。
        </p>
        <p className="page-subtle max-w-[70ch]">
          這一頁的每個動作按下去就直接生效,不必按底下的「儲存全部設定」。
        </p>
      </div>

      {flash ? (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          className={`flash ${flash.kind === 'success' ? 'flash-success' : 'flash-error'}`}
        >
          {flash.text}
        </p>
      ) : null}

      <form
        onSubmit={onCreate}
        className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-3"
      >
        <label className="block">
          <span className="mb-1 block text-sm font-medium">新增部門名稱</span>
          <input
            type="text"
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={100}
            disabled={creating}
            placeholder="例:北區訪查一課"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">上層部門</span>
          <select
            className="input"
            value={newParentId}
            onChange={(e) => setNewParentId(e.target.value)}
            disabled={creating}
          >
            <option value="">最上層</option>
            {ordered.map(({ row, depth }) => (
              <option key={row.id} value={row.id}>
                {'　'.repeat(depth)}
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={creating} className="btn btn-primary min-h-[44px] px-4">
            {creating ? '新增中...' : '新增部門'}
          </button>
        </div>
      </form>

      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          載入中...
        </p>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          還沒有任何部門。沒有部門也能用,訪查主管的範圍就只靠「所屬主管」那一欄算。
        </p>
      ) : (
        <ul className="space-y-2">
          {ordered.map(({ row, depth }) => (
            <li
              key={row.id}
              className="rounded-md border border-border p-3"
              style={{ marginInlineStart: `${Math.min(depth, 4) * 1.5}rem` }}
            >
              <div className="grid gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">部門名稱</span>
                  <input
                    type="text"
                    className="input"
                    defaultValue={row.name}
                    maxLength={100}
                    disabled={busyId === row.id}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (!next || next === row.name) return;
                      void patch(row, { name: next }, `已改名為「${next}」`);
                    }}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    改完離開欄位就會存檔
                  </span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">上層部門</span>
                  <select
                    className="input"
                    value={row.parentId ?? ''}
                    disabled={busyId === row.id}
                    onChange={(e) =>
                      void patch(
                        row,
                        { parentId: e.target.value || null },
                        `已調整「${row.name}」的上層部門`,
                      )
                    }
                  >
                    <option value="">最上層</option>
                    {allowedParents(rows, row.id).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-col justify-end gap-1">
                  <p className="text-xs text-muted-foreground">直屬成員 {row.memberCount} 人</p>
                  {confirmId === row.id ? (
                    <div className="flex flex-wrap gap-2">
                      <span className="text-xs text-foreground">確定要刪除?</span>
                      <button
                        type="button"
                        onClick={() => void onDelete(row)}
                        disabled={busyId === row.id}
                        className="btn btn-danger min-h-[44px] px-4"
                      >
                        確定刪除
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="btn min-h-[44px] px-4"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setFlash(null);
                        setConfirmId(row.id);
                      }}
                      disabled={busyId === row.id}
                      className="btn min-h-[44px] px-4"
                    >
                      刪除部門
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
