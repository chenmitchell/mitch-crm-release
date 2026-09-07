'use client';

// 日報彙整頁(/admin/crm/daily-reports)。
// 主管/admin:頂部顯示今天誰交了、誰還沒(GET today-status),下方列全隊日報,可篩日期與人,
// 每篇可展開內容、標已讀、寫批註(PATCH :id)。業務:只看到自己的歷史日報,沒有批註功能。
// 資料來源:GET /api/admin/crm-daily-reports、GET .../today-status、PATCH .../:id、GET /api/admin/crm/sales-users(人員下拉)。
// 無障礙:狀態訊息 role="status" aria-live、已讀/未讀用文字 badge 不只靠顏色、展開用原生 details/summary、按鈕 ≥44px。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { addCalendarDays, formatOrgDateTime, orgToday } from '@mitchcrm/shared';
import { useAppSettings, useStatMetricLabel } from '@/lib/app-settings';
import { canUseCrm, isViewAllRole, useCrmRole } from '@/lib/crm-shared';

interface ReportRow {
  id: string;
  userId: string;
  userName: string;
  reportDate: string;
  content: string;
  stats: Record<string, number> | null;
  submittedAt: string;
  readAt: string | null;
  managerNote: string | null;
}

interface TodayStatus {
  date: string;
  submitted: { userId: string; userName: string }[];
  missing: { userId: string; userName: string }[];
}

interface SalesUser {
  id: string;
  name: string;
}

const DEFAULT_RANGE_DAYS = 7;
const MANAGER_NOTE_MAX = 2000;

/** 組織時區的日曆日 YYYY-MM-DD(offset 為距今天數,負數往前) */
function orgDate(timeZone: string, offsetDays = 0): string {
  return addCalendarDays(orgToday(new Date(), timeZone), offsetDays);
}

/** 送出時間以組織時區顯示(不是看報表的人所在的時區,不然主管出差時看到的時間會跟業務對不上) */
function fmtDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatOrgDateTime(d, timeZone, { seconds: false }).replace(/-/g, '/');
}

export default function DailyReportsPage() {
  // 計數欄位的顯示名稱:兩個跟階段有關的跟著後台設定走(見 lib/app-settings)
  const statLabel = useStatMetricLabel();
  // 日期一律以組織設定的時區計
  const { timezone } = useAppSettings();
  // 角色走共用 hook(見 lib/crm-shared 的 useCrmRole),整站對 /api/auth/me 只有一個呼叫點
  const role = useCrmRole();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<TodayStatus | null>(null);
  const [salesUsers, setSalesUsers] = useState<SalesUser[]>([]);

  const [from, setFrom] = useState<string>(() => orgDate(timezone, -(DEFAULT_RANGE_DAYS - 1)));
  const [to, setTo] = useState<string>(() => orgDate(timezone, 0));
  const [filterUser, setFilterUser] = useState<string>('');

  // 批註編輯狀態(每篇一份草稿)
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>('');

  const base = `${getApiBase()}/api/admin/crm-daily-reports`;
  const isManager = isViewAllRole(role);
  const canUse = canUseCrm(role);

  // 列表只在首次載入與按「查詢」(或「最近 7 天」)時才打;改日期不會自動查。
  // 每次先中止上一次還沒回來的請求,舊回應不會蓋掉新的。
  const rowsAcRef = useRef<AbortController | null>(null);
  const loadRows = useCallback(
    async (q?: { from: string; to: string; userId: string }) => {
      const f = q?.from ?? from;
      const t = q?.to ?? to;
      const u = q?.userId ?? filterUser;
      rowsAcRef.current?.abort();
      const ac = new AbortController();
      rowsAcRef.current = ac;
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (f) qs.set('from', f);
        if (t) qs.set('to', t);
        if (isManager && u) qs.set('userId', u);
        const res = await fetch(`${base}?${qs.toString()}`, {
          credentials: 'include',
          signal: ac.signal,
        });
        if (!res.ok) {
          const text = await apiErrorMessage(res, '日報載入失敗,請稍後再試');
          if (ac.signal.aborted) return;
          setError(text);
          setRows([]);
          return;
        }
        const data = (await res.json()) as { rows?: ReportRow[] };
        if (ac.signal.aborted) return;
        setRows(Array.isArray(data.rows) ? data.rows : []);
      } catch {
        if (ac.signal.aborted) return;
        setError('日報載入失敗,請稍後再試');
        setRows([]);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [base, from, to, filterUser, isManager],
  );

  const loadToday = useCallback(async () => {
    try {
      const res = await fetch(`${base}/today-status`, { credentials: 'include' });
      if (res.ok) setToday((await res.json()) as TodayStatus);
    } catch {
      /* 今日狀態載不到不擋列表 */
    }
  }, [base]);

  // 首次(角色確認可用後)載入一次;之後 loadRows 因日期改變而換新版本也不再自動打
  const firstLoadDone = useRef(false);
  useEffect(() => {
    if (!canUse || firstLoadDone.current) return;
    firstLoadDone.current = true;
    void loadRows();
  }, [canUse, loadRows]);

  // 離開頁面時中止還在飛的請求
  useEffect(() => () => rowsAcRef.current?.abort(), []);

  useEffect(() => {
    if (!isManager) return;
    void loadToday();
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/admin/crm/sales-users`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = (await res.json()) as { rows?: SalesUser[] };
          setSalesUsers(Array.isArray(data.rows) ? data.rows : []);
        }
      } catch {
        /* 下拉載不到就只能不篩人 */
      }
    })();
  }, [isManager, loadToday]);

  async function patchReport(
    row: ReportRow,
    body: { managerNote?: string; markRead?: boolean },
    okText: string,
  ) {
    setBusyId(row.id);
    setMsg('');
    try {
      const res = await fetch(`${base}/${row.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setMsg(`操作失敗:${await apiErrorMessage(res, '請稍後再試')}`);
        return;
      }
      const updated = (await res.json()) as ReportRow;
      setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
      setMsg(`${row.userName} ${row.reportDate} 的日報:${okText}`);
      void loadToday();
    } catch {
      setMsg('操作失敗:網路連線異常,請稍後再試');
    } finally {
      setBusyId(null);
    }
  }

  const unreadCount = useMemo(() => rows.filter((r) => !r.readAt).length, [rows]);

  // ---- render ----
  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">日報彙整</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用外勤拜訪。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div>
        <h1 className="text-lg font-semibold">日報彙整</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isManager
            ? '查看訪查人員每天送來的日報,標記已讀並寫批註。'
            : '這裡是你送給主管的歷史日報,主管的批註會顯示在各篇下方。'}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-foreground"
        >
          {error}
        </div>
      )}

      {/* 今日繳交狀態(主管) */}
      {isManager && (
        <section
          aria-labelledby="today-title"
          className="mt-6 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="today-title" className="text-base font-semibold">
            今日繳交狀態{today ? `(${today.date})` : ''}
          </h2>
          {!today ? (
            <p className="mt-2 text-sm text-muted-foreground">今日狀態載入中…</p>
          ) : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold">已交({today.submitted.length})</h3>
                {today.submitted.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">尚無人送出</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {today.submitted.map((u) => (
                      <li key={u.userId} className="badge badge-success">
                        {u.userName}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-sm font-semibold">還沒交({today.missing.length})</h3>
                {today.missing.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">全部訪查人員都已送出</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {today.missing.map((u) => (
                      <li key={u.userId} className="badge badge-warning">
                        {u.userName}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            對象為目前啟用中的訪查人員帳號;訪查主管與系統管理員不計入。
          </p>
        </section>
      )}

      {/* 篩選 */}
      <section
        aria-labelledby="filter-title"
        className="mt-6 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="filter-title" className="text-base font-semibold">
          日報列表
        </h2>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void loadRows();
          }}
        >
          <div>
            <label htmlFor="dr-from" className="field-label">
              起日
            </label>
            <input
              id="dr-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="dr-to" className="field-label">
              迄日
            </label>
            <input
              id="dr-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          {isManager && (
            <div>
              <label htmlFor="dr-user" className="field-label">
                訪查人員
              </label>
              <select
                id="dr-user"
                value={filterUser}
                onChange={(e) => setFilterUser(e.target.value)}
              >
                <option value="">全部</option>
                {salesUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="submit" className="btn" disabled={loading}>
            {loading ? '查詢中…' : '查詢'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const f = orgDate(timezone, -(DEFAULT_RANGE_DAYS - 1));
              const t = orgDate(timezone, 0);
              setFrom(f);
              setTo(t);
              setFilterUser('');
              void loadRows({ from: f, to: t, userId: '' });
            }}
          >
            最近 7 天
          </button>
        </form>

        <p
          role="status"
          aria-live="polite"
          className="mt-3 min-h-[1.25rem] text-sm text-foreground"
        >
          {msg ||
            (!loading && rows.length > 0 && isManager
              ? `共 ${rows.length} 篇,未讀 ${unreadCount} 篇`
              : '')}
        </p>

        {loading ? (
          <p className="mt-2 text-sm text-muted-foreground" aria-busy="true">
            日報載入中…
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">這段期間沒有日報。</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {rows.map((r) => {
              const draft = noteDraft[r.id] ?? r.managerNote ?? '';
              const noteId = `note-${r.id}`;
              const statEntries = r.stats ? Object.entries(r.stats) : [];
              return (
                <li key={r.id} className="rounded-lg border border-border bg-background">
                  <details>
                    <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="font-semibold">{r.reportDate}</span>
                      {isManager && <span>{r.userName}</span>}
                      <span className={r.readAt ? 'badge badge-muted' : 'badge badge-primary'}>
                        {r.readAt ? '已讀' : '未讀'}
                      </span>
                      {r.managerNote && <span className="badge badge-success">有批註</span>}
                      <span className="text-muted-foreground">
                        送出 {fmtDateTime(r.submittedAt, timezone)}
                      </span>
                    </summary>
                    <div className="border-t border-border px-3 py-3">
                      {statEntries.length > 0 && (
                        <dl className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                          {statEntries.map(([k, v]) => (
                            <div key={k} className="flex gap-1">
                              <dt className="text-muted-foreground">{statLabel[k] ?? k}</dt>
                              <dd className="font-semibold">{v}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
                        {r.content}
                      </pre>

                      {isManager ? (
                        <div className="mt-4 border-t border-border pt-3">
                          <label htmlFor={noteId} className="field-label">
                            主管批註
                          </label>
                          <textarea
                            id={noteId}
                            rows={3}
                            value={draft}
                            maxLength={MANAGER_NOTE_MAX}
                            onChange={(e) =>
                              setNoteDraft((prev) => ({ ...prev, [r.id]: e.target.value }))
                            }
                            className="w-full rounded-md border border-border-strong bg-background px-2 py-1.5 text-sm"
                            placeholder="給訪查人員的回饋或指示(選填)"
                          />
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busyId === r.id}
                              onClick={() =>
                                void patchReport(r, { managerNote: draft }, '批註已儲存')
                              }
                            >
                              儲存批註
                            </button>
                            {r.readAt ? (
                              <button
                                type="button"
                                className="btn"
                                disabled={busyId === r.id}
                                onClick={() =>
                                  void patchReport(r, { markRead: false }, '已改回未讀')
                                }
                              >
                                標為未讀
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn"
                                disabled={busyId === r.id}
                                onClick={() =>
                                  void patchReport(r, { markRead: true }, '已標為已讀')
                                }
                              >
                                標為已讀
                              </button>
                            )}
                            <span className="text-sm text-muted-foreground">
                              {draft.length} / {MANAGER_NOTE_MAX} 字
                              {r.readAt ? `,已讀於 ${fmtDateTime(r.readAt, timezone)}` : ''}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-4 border-t border-border pt-3 text-sm">
                          <h3 className="font-semibold">主管批註</h3>
                          {r.managerNote ? (
                            <p className="mt-1 whitespace-pre-wrap text-foreground">
                              {r.managerNote}
                            </p>
                          ) : (
                            <p className="mt-1 text-muted-foreground">
                              {r.readAt
                                ? `主管已於 ${fmtDateTime(r.readAt, timezone)} 讀過,尚無批註`
                                : '主管尚未讀取'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
