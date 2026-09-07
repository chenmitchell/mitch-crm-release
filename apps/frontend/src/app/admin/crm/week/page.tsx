'use client';

// 本週工作報告(/admin/crm/week):本週(週一到週日,以組織設定的時區計)的拜訪排程按日列出。
// 上方是本週摘要(排了幾家、完成幾家、未完成幾家),每一天有小計,狀態用文字標籤。
// 主管 / admin 可以切換看哪一位訪查人員(GET 帶 ownerId,業務清單走 /api/admin/crm/sales-users)。
// 資料來源:GET /api/admin/crm-visit-plans?from=週一&to=週日[&ownerId=]。
// 無障礙:單一 h1、每天一個 h2、狀態訊息 role="status" aria-live、狀態文字不只靠顏色、
//   下拉與連結 ≥44px(.input / .btn 已含)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { canUseCrm, isViewAllRole, useCrmRole } from '@/lib/crm-shared';
import {
  VISIT_PLAN_STATUS_COLORS,
  VISIT_PLAN_STATUS_LABEL,
  addDays,
  fmtDateZh,
  type VisitPlanRow,
} from '@/components/crm/visit-plan-panel';
import { orgToday } from '@mitchcrm/shared';
import { useAppSettings, useLookupLabel } from '@/lib/app-settings';

interface SalesUser {
  id: string;
  name: string;
}

/** 這一週的週一(YYYY-MM-DD);週日算成該週的最後一天 */
export function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0 = 週日
  return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
}

export default function CrmWeekPage() {
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();

  // 角色走共用 hook(見 lib/crm-shared 的 useCrmRole),整站對 /api/auth/me 只有一個呼叫點
  const role = useCrmRole();
  const [rows, setRows] = useState<VisitPlanRow[]>([]);
  const [users, setUsers] = useState<SalesUser[]>([]);
  const [ownerId, setOwnerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 角色判斷一律走 lib/crm-shared,不要在各頁各寫一份(改角色時一定漏掉某一頁)
  const canUse = canUseCrm(role);
  const isManager = isViewAllRole(role);

  // 「今天」以組織設定的時區計,不是瀏覽器時區也不是寫死的台北
  const { timezone } = useAppSettings();
  const today = orgToday(new Date(), timezone);
  const monday = useMemo(() => mondayOf(today), [today]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const sunday = addDays(monday, 6);

  // 主管才需要業務清單
  useEffect(() => {
    if (!isManager) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/admin/crm/sales-users`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { rows?: SalesUser[] };
        if (alive) setUsers(data.rows ?? []);
      } catch {
        // 業務清單抓不到不影響本頁主要內容,維持「全部業務」
      }
    })();
    return () => {
      alive = false;
    };
  }, [isManager]);

  const load = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: monday, to: sunday });
      if (isManager && ownerId) qs.set('ownerId', ownerId);
      const res = await fetch(`${getApiBase()}/api/admin/crm-visit-plans?${qs.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setError(`本週排程載入失敗:${await apiErrorMessage(res, '請稍後再試')}`);
        setRows([]);
        return;
      }
      const data = (await res.json()) as { rows?: VisitPlanRow[] };
      setRows(data.rows ?? []);
      setError('');
    } catch {
      setError('本週排程載入失敗:網路連線異常,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canUse, isManager, ownerId, monday, sunday]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, VisitPlanRow[]>();
    for (const d of days) m.set(d, []);
    for (const r of rows) m.get(r.plannedDate)?.push(r);
    return m;
  }, [days, rows]);

  const summary = useMemo(() => {
    const done = rows.filter((r) => r.status === 'done').length;
    const missed = rows.filter((r) => r.status === 'missed').length;
    const planned = rows.filter((r) => r.status === 'planned').length;
    const cancelled = rows.filter((r) => r.status === 'cancelled').length;
    return { total: rows.length, done, missed, planned, cancelled };
  }, [rows]);

  if (role === null) {
    return <div className="p-4 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">本週工作報告</h1>
        <p className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用客戶管理。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">
          本週工作報告
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {fmtDateZh(monday)} 到 {fmtDateZh(sunday)}
          </span>
        </h1>
        <Link href={'/admin/crm/home' as Route} className="btn">
          回我的首頁
        </Link>
      </div>

      {isManager ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="owner-filter" className="field-label">
            看哪一位訪查人員
          </label>
          <select
            id="owner-filter"
            className="input"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
          >
            <option value="">全部訪查人員</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || '(未命名)'}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <section
        aria-labelledby="week-summary-title"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="week-summary-title" className="text-base font-semibold">
          本週摘要
        </h2>
        <p className="mt-2 text-sm text-foreground">
          排了 {summary.total} 家,完成 {summary.done} 家,未完成 {summary.missed} 家,待拜訪{' '}
          {summary.planned} 家,已取消 {summary.cancelled} 家
        </p>
      </section>

      <p role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-foreground">
        {loading ? '載入中…' : error}
      </p>

      {days.map((d) => {
        const list = byDay.get(d) ?? [];
        const done = list.filter((r) => r.status === 'done').length;
        return (
          <section
            key={d}
            aria-labelledby={`day-${d}`}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <h2 id={`day-${d}`} className="text-base font-semibold">
              {fmtDateZh(d)}
              {d === today ? '(今天)' : ''}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                排 {list.length} 家、完成 {done} 家
              </span>
            </h2>
            {list.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">沒有排程</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {list.map((r) => {
                  // 後端之後新增狀態時不要整頁壞掉:配色與標籤都退回 planned
                  const c = VISIT_PLAN_STATUS_COLORS[r.status] ?? VISIT_PLAN_STATUS_COLORS.planned;
                  return (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
                    >
                      <Link
                        href={`/admin/crm/${r.customerId}` as Route}
                        className="text-sm font-semibold underline"
                      >
                        {r.companyName}
                      </Link>
                      <span
                        className="rounded px-2 py-0.5 text-xs font-semibold"
                        style={{ backgroundColor: c.bg, color: c.fg }}
                      >
                        {VISIT_PLAN_STATUS_LABEL[r.status] ?? VISIT_PLAN_STATUS_LABEL.planned}
                      </span>
                      {isManager && !ownerId ? (
                        <span className="text-xs text-muted-foreground">{r.ownerName}</span>
                      ) : null}
                      {r.taxId ? (
                        <span className="text-xs text-muted-foreground">
                          {lookupLabel} {r.taxId}
                        </span>
                      ) : null}
                      {r.note ? (
                        <span className="text-sm text-muted-foreground">{r.note}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
