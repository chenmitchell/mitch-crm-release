'use client';

// 我聯絡過的客戶(/admin/crm/field/contacts)。原本在 /admin/crm/field 頁的第三區,拆頁後獨立並改用互動紀錄。
// 定義:期間內有過任何互動(拜訪、電話、LINE、Email、報價、備註)的客戶,依最近互動時間由新到舊,
// 顯示公司名、階段、最近互動的管道與時間、下一步,點整列進客戶卡。
// 資料來源:GET /api/admin/crm-contacts?days=&limit=(業務只回自己的客戶,主管與 admin 全部)。
// 無障礙:單一 h1、天數用原生 select 有 label、載入與錯誤訊息 role="status" / role="alert"、
//   階段用文字標籤加配色(fg 對 bg >= 7:1),不只靠顏色。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { useStageMeta, canUseCrm, fmtDateTime, useCrmRole } from '@/lib/crm-shared';
import { labelOf, useAppSettings, useCrmVocab, useLookupLabel } from '@/lib/app-settings';

interface ContactRow {
  customerId: string;
  companyName: string | null;
  taxId: string | null;
  stage: string;
  ownerName: string | null;
  lastChannel: string;
  lastAt: string;
  lastNote: string | null;
  nextAction: string | null;
  nextFollowUpAt: string | null;
}

const DAYS_OPTIONS = [7, 30, 90, 365];

export default function FieldContactsPage() {
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();

  const role = useCrmRole();
  // 時間一律以組織設定的時區顯示:外勤的人可能在別的時區,而後端的逾期與
  // 「今天要拜訪」全部走組織時區,兩邊用不同的口徑會差一天
  const { timezone } = useAppSettings();
  // 管道名稱同樣由後台設定供應,不在畫面裡寫第二份對照表
  const { channels } = useCrmVocab();
  // 階段標籤與配色由後台設定供應
  const stageMeta = useStageMeta();
  const stageStyle = (stage: string) => {
    const c = stageMeta.colors(stage);
    return { backgroundColor: c.bg, color: c.fg, borderColor: c.fg };
  };
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canUse = canUseCrm(role);

  const load = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/crm-contacts?days=${days}&limit=100`, {
        credentials: 'include',
      });
      if (res.status === 403) {
        setError('你沒有使用外勤拜訪的權限');
        return;
      }
      if (!res.ok) {
        // 401 走全站共用規則(見 lib/api-error):訊息換成「登入已過期」並導回登入頁
        setError(await apiErrorMessage(res, '清單載入失敗,請稍後再試'));
        return;
      }
      const data = (await res.json()) as { rows?: ContactRow[] };
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setError('清單載入失敗,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canUse, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">我聯絡過的客戶</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用外勤拜訪。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">我聯絡過的客戶</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        期間內有打過電話、傳過 LINE、拜訪過或留過備註的客戶,最近聯絡的排在最上面。
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor="contacts-days" className="flex flex-col gap-1 text-sm">
          <span>期間</span>
          <select
            id="contacts-days"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            style={{ minHeight: 44 }}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>
                最近 {d} 天
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={() => void load()}>
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

      <div className="mt-4">
        {loading ? (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            載入中…
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
            這段期間還沒有互動紀錄。到打卡頁或客戶卡記一筆之後就會出現在這裡。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const name =
                r.companyName || (r.taxId ? `${lookupLabel} ${r.taxId}` : '(未命名客戶)');
              const stageText = stageMeta.label(r.stage);
              return (
                <li key={r.customerId}>
                  <Link
                    href={`/admin/crm/${r.customerId}` as Route}
                    className="block rounded-md border border-border bg-surface p-3 no-underline hover:bg-muted"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{name}</span>
                      <span
                        className="rounded-full border px-2 py-0.5 text-xs font-semibold"
                        style={stageStyle(r.stage)}
                      >
                        {stageText}
                      </span>
                      {r.ownerName ? (
                        <span className="text-xs text-muted-foreground">負責:{r.ownerName}</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      最近互動:{labelOf(channels, r.lastChannel) || r.lastChannel},
                      {fmtDateTime(r.lastAt, timezone)}
                    </p>
                    {r.nextAction || r.nextFollowUpAt ? (
                      <p className="mt-1 text-sm text-foreground">
                        下一步:{r.nextAction ?? '尚未寫'}
                        {r.nextFollowUpAt
                          ? `(預計 ${fmtDateTime(r.nextFollowUpAt, timezone)})`
                          : ''}
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-muted-foreground">下一步:尚未安排</p>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link href="/admin/crm/field/checkin" className="underline underline-offset-2">
          去打卡
        </Link>
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回我的首頁
        </Link>
      </p>
    </div>
  );
}
