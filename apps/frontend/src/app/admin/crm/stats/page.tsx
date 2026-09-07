'use client';

// 主管戰情(/admin/crm/stats)。原本是 /admin/crm 頁下半部的兩塊,拆頁後獨立,只有訪查主管與 admin 看得到。
// 內容:各訪查人員狀態表(開發中/有意願/逾期跟進)+ 最近到訪 + 戰情圖表元件(sales-charts)。
// 資料來源:GET /api/admin/crm/by-sales、GET /api/admin/crm-checkin/recent;
//   圖表資料由 sales-charts 自己打 /api/admin/crm-stats/*。
//
// 為什麼「最近到訪」在這一頁:下面的圖表已經給出「這段期間有幾筆可疑打卡」,
// 但只有數字,主管看不到是哪幾筆,只能去匯出檔裡翻。這一張表就是那個數字的明細。
//
// 無障礙:單一 h1、表格有表頭、載入與錯誤訊息 role="status" / role="alert"、
// 逾期數字與可疑標示都不只靠顏色(同時有粗體與「可疑」兩個字)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import SalesCharts from '@/components/crm/sales-charts';
import { crmApiBase, isViewAllRole, useCrmRole } from '@/lib/crm-shared';
import { useAppSettings, useStatMetricLabel } from '@/lib/app-settings';
import { fmtOrgDateTime } from '@/lib/crm-dates';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';

/** GET /api/admin/crm-checkin/recent 回的一列(欄位對應後端 crm-checkin.service 的 RecentRow) */
interface RecentVisitRow {
  id: string;
  customerId: string;
  companyName: string;
  userName: string;
  occurredAt: string;
  /** 打卡點與客戶地址的距離(公尺)。沒有座標就是 null */
  distanceM: number | null;
  gpsSuspicious: boolean;
  gpsSuspiciousReason: string | null;
  photoCount: number;
}

/** 最近到訪要看幾天。與後端的預設一致,超過 90 天後端會自己夾回去 */
const RECENT_DAYS = 7;

interface SalesRow {
  salesId: string;
  salesName: string;
  /** 帳號還啟用嗎;停用(離職)帳號一樣列出、名下客戶一樣算,只是標示出來 */
  active?: boolean;
  inDev: number;
  interested: number;
  overdue: number;
}

export default function CrmStatsPage() {
  const role = useCrmRole();
  // 表頭跟下面的圖表吃同一份標籤(見 lib/app-settings 的 useStatMetricLabel)。
  // 這一張表原本寫死「有意願」,管理員把那一階改名之後,表頭跟數字就對不上了。
  const metricLabel = useStatMetricLabel();
  const { timezone } = useAppSettings();
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentVisitRow[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);

  const viewAll = isViewAllRole(role);

  const load = useCallback(async () => {
    if (role === null) return;
    if (!viewAll) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${crmApiBase()}/by-sales`, { credentials: 'include' });
      if (!res.ok) {
        // 401 走全站共用規則(見 lib/api-error):訊息換成「登入已過期」並導回登入頁
        setError(await apiErrorMessage(res, '各訪查人員狀態載入失敗,請稍後再試'));
        return;
      }
      const data = (await res.json()) as { rows?: SalesRow[] };
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setError('各訪查人員狀態載入失敗,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, viewAll]);

  const loadRecent = useCallback(async () => {
    if (role === null) return;
    if (!viewAll) {
      setRecentLoading(false);
      return;
    }
    setRecentLoading(true);
    setRecentError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/crm-checkin/recent?days=${RECENT_DAYS}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        // 401 走全站共用規則(見 lib/api-error):訊息換成「登入已過期」並導回登入頁
        setRecentError(await apiErrorMessage(res, '最近到訪載入失敗,請稍後再試'));
        return;
      }
      const data = (await res.json()) as { rows?: RecentVisitRow[] };
      setRecent(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setRecentError('最近到訪載入失敗,請稍後再試');
    } finally {
      setRecentLoading(false);
    }
  }, [role, viewAll]);

  useEffect(() => {
    void load();
    void loadRecent();
  }, [load, loadRecent]);

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!viewAll) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">主管戰情</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          沒有權限。主管戰情僅限訪查主管與系統管理員檢視。
        </div>
        <p className="mt-4 text-sm">
          <Link href="/admin/crm/home" className="underline underline-offset-2">
            回我的首頁
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">主管戰情</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            各訪查人員目前的跟進狀態與期間戰情圖表。
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void load();
            void loadRecent();
          }}
        >
          重新整理
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm"
          style={{ color: 'var(--color-destructive)' }}
        >
          {error}
        </div>
      ) : null}

      <section className="mt-4 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-base font-semibold">各訪查人員狀態</h2>
        {/* 口徑要寫在畫面上:同一頁的三張表(這一張、漏斗、貢獻度分級)算的是同一批客戶,
            包含已停用帳號名下的。少了這句話,使用者只會覺得「數字對不起來」。 */}
        <p className="mb-3 mt-1 text-xs text-muted-foreground">
          目前手上的客戶統計。「跟進中」是所有還沒結案的階段加總,「{metricLabel.overdue}
          跟進」是已過跟進日期還沒動作的筆數。停用(離職)帳號名下的客戶一樣計入,該列會標「已停用」,提醒你把客戶移交出去;這一張表、下面的漏斗與貢獻度分級算的是同一批客戶,合計對得起來。
        </p>
        {loading ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            載入中…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有訪查人員資料。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">訪查人員</th>
                  {/* 「跟進中」算的是所有還沒結案的階段的加總,不是某一階,
                      所以它不吃 useStatMetricLabel,改名任何一階都不影響這個數字 */}
                  <th className="py-2 pr-3 font-medium">跟進中</th>
                  <th className="py-2 pr-3 font-medium">{metricLabel.interested}</th>
                  <th className="py-2 pr-3 font-medium">{metricLabel.overdue}跟進</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.salesId} className="border-b border-border">
                    <td className="py-2 pr-3">
                      {r.salesName}
                      {r.active === false ? (
                        // 只用顏色表達「已停用」不合格,直接寫成文字
                        <span className="ml-1 rounded border border-border px-1 text-xs font-semibold">
                          已停用
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">{r.inDev}</td>
                    <td className="py-2 pr-3">{r.interested}</td>
                    <td
                      className="py-2 pr-3"
                      style={
                        r.overdue > 0
                          ? { color: 'var(--color-destructive)', fontWeight: 600 }
                          : undefined
                      }
                    >
                      {r.overdue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-base font-semibold">最近 {RECENT_DAYS} 天的到訪</h2>
        <p className="mb-3 mt-1 text-xs text-muted-foreground">
          你看得到的客戶身上,最近 {RECENT_DAYS}{' '}
          天的到訪打卡。距離是打卡當下的位置與客戶地址的直線距離;標成可疑的那幾筆下面的圖表不計入到訪數,另外算一欄,原因寫在該列裡。
        </p>
        {recentError ? (
          <div role="alert" className="text-sm" style={{ color: 'var(--color-destructive)' }}>
            {recentError}
          </div>
        ) : recentLoading ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            載入中…
          </p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">最近 {RECENT_DAYS} 天沒有到訪打卡紀錄。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">最近 {RECENT_DAYS} 天的到訪打卡明細</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    時間
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    客戶
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    訪查人員
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    距離
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    存證照片
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    標示
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {fmtOrgDateTime(r.occurredAt, timezone)}
                    </td>
                    <td className="py-2 pr-3">
                      <Link
                        href={`/admin/crm/${r.customerId}`}
                        className="underline underline-offset-2"
                      >
                        {r.companyName}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{r.userName}</td>
                    <td className="py-2 pr-3 tabular-nums whitespace-nowrap">
                      {r.distanceM === null ? '—' : `${Math.round(r.distanceM)} 公尺`}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{r.photoCount}</td>
                    <td className="py-2 pr-3">
                      {r.gpsSuspicious ? (
                        // 只用顏色表達「可疑」不合格,先寫成文字再談顏色
                        <>
                          <span
                            className="font-semibold"
                            style={{ color: 'var(--color-destructive)' }}
                          >
                            可疑
                          </span>
                          {r.gpsSuspiciousReason ? (
                            <span className="block text-xs text-muted-foreground">
                              {r.gpsSuspiciousReason}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <SalesCharts />
      </section>

      <p className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link href="/admin/crm/board" className="underline underline-offset-2">
          去看客戶看板
        </Link>
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回我的首頁
        </Link>
      </p>
    </div>
  );
}
