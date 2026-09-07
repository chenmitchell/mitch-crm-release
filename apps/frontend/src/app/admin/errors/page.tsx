'use client';

import { Fragment, useEffect, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { redirectToLogin } from '@/lib/api-error';
import { useOrgTimeFormat } from '@/lib/app-settings';

interface ErrorRow {
  id: string;
  level: 'error' | 'warn';
  message: string;
  path: string | null;
  method: string | null;
  statusCode: number | null;
  userId: string | null;
  ip: string | null;
  createdAt: string;
  stack: string | null;
}

export default function AdminErrorsPage() {
  // 時間一律照組織設定的時區顯示,不吃看的人的裝置時區與語系
  const fmtTime = useOrgTimeFormat();
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${getApiBase()}/api/admin/errors?limit=200`, {
        credentials: 'include',
      });
      // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      if (r.status === 401) {
        // 401 全站同一套處理(見 lib/api-error):導回登入頁並帶上 next
        redirectToLogin();
        return;
      }
      if (r.status === 403) {
        // 403 是「這個人不是系統管理員」,不是系統壞了。以前這裡跟其他狀態碼
        // 共用一句「載入失敗 (403)」,訪查人員看到只會以為系統掛了,還會去回報。
        setError('這一頁只有系統管理員看得到。如果你需要查系統錯誤,請找系統管理員');
        return;
      }
      if (!r.ok) {
        setError('載入失敗,請確認網路連線後重新整理');
        return;
      }
      const d = await r.json();
      setRows((d.errors ?? []) as ErrorRow[]);
    } catch {
      // 原始的 JS 例外(Failed to fetch 之類,有時還帶主機名)不畫在畫面上,
      setError('載入失敗,請確認網路連線後重新整理');
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="space-y-4">
      <header className="space-y-1">
        <p className="text-xs text-muted-foreground">內部管理</p>
        <h1>錯誤記錄</h1>
        <p className="text-sm text-muted-foreground">
          系統最近 200 筆錯誤(server 端 5xx + 預期外 exception)。一般 4xx (Bad Request /
          Unauthorized 等)不寫入,避免量大塞爆。
        </p>
      </header>

      <div className="flex gap-2">
        <button type="button" onClick={() => void load()} disabled={loading} className="btn btn-sm">
          {loading ? '載入中...' : '重新整理'}
        </button>
      </div>

      {error ? (
        <p role="alert" className="flash flash-error">
          {error}
        </p>
      ) : null}

      {!loading && rows.length === 0 ? (
        <section className="rounded-lg border border-dashed border-border bg-surface p-8 text-center text-sm text-muted-foreground">
          目前沒有任何錯誤記錄
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">時間</th>
                <th className="hidden md:table-cell px-3 py-2">層級</th>
                <th className="px-3 py-2">Method / Path</th>
                <th className="hidden lg:table-cell px-3 py-2">狀態</th>
                <th className="px-3 py-2">訊息</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
                <Fragment key={r.id}>
                  <tr className="transition-colors hover:bg-muted/30 align-top">
                    <td className="px-3 py-2 text-xs whitespace-nowrap font-mono">
                      {fmtTime(r.createdAt)}
                    </td>
                    <td className="hidden md:table-cell px-3 py-2">
                      <span
                        className={`badge ${r.level === 'error' ? 'badge-danger' : 'badge-warning'}`}
                      >
                        {r.level === 'error' ? 'error 錯誤' : 'warn 警告'}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.method ? <span className="font-semibold mr-1">{r.method}</span> : null}
                      {r.path ?? '—'}
                    </td>
                    <td className="hidden lg:table-cell px-3 py-2 font-mono text-xs">
                      {r.statusCode ?? '—'}
                    </td>
                    <td className="px-3 py-2 max-w-md">
                      <p className="break-words">{r.message}</p>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.stack ? (
                        <button
                          type="button"
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          className="text-xs underline"
                        >
                          {expanded === r.id ? '收合' : '看 stack'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {expanded === r.id && r.stack ? (
                    <tr className="bg-muted/20">
                      <td colSpan={6} className="px-3 py-2">
                        <pre className="text-xs whitespace-pre-wrap font-mono break-all">
                          {r.stack}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </article>
  );
}
