'use client';

// 秒查客戶(/admin/crm/search)。原本是 /admin/crm 頁裡的一區,拆頁後獨立。
// 關鍵字交給後端查(GET /api/admin/crm?q=&limit=),不再把客戶整批撈到前端過濾:
// 清單有筆數上限,整批撈的結果是超過上限的客戶永遠查不到,而畫面上不會說少了什麼。
// 資料來源:GET /api/admin/crm?q=。
// 無障礙:單一 h1、錯誤訊息 role="alert"、查詢狀態由 quick-search 元件播報、連結與按鈕 >= 44px(.btn 已含)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback } from 'react';
import Link from 'next/link';
import QuickSearch, { MAX_RESULTS, type QuickSearchResult } from '@/components/crm/quick-search';
import {
  canUseCrm,
  crmApiBase,
  isViewAllRole,
  useCrmRole,
  type DevCustomer,
} from '@/lib/crm-shared';
import { useLookupLabel } from '@/lib/app-settings';

/**
 * 一次跟後端要幾筆。
 *
 * 多要一筆是為了知道「還有更多」:要 9 筆而回了 9 筆,就表示至少還有第 9 筆以後的,
 * 畫面才講得出「符合的客戶不只這些」。不多要那一筆的話,剛好 8 筆與超過 8 筆
 * 在回應上長得一模一樣。
 */
const SEARCH_TAKE = MAX_RESULTS + 1;

export default function CrmSearchPage() {
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();

  const role = useCrmRole();

  const search = useCallback(
    async (q: string, signal: AbortSignal): Promise<QuickSearchResult | null> => {
      const params = new URLSearchParams({ q, limit: String(SEARCH_TAKE) });
      const res = await fetch(`${crmApiBase()}?${params.toString()}`, {
        credentials: 'include',
        signal,
      });
      if (!res.ok) return null;
      // 型別走前後端共用的回應契約(DevCustomer,見 lib/crm-shared)。
      // 這裡原本是就地手寫的 inline 型別,而且比契約更鬆(companyName 寫成
      // `string | null`,契約是 `string`)—— 那等於在這一頁上把契約關掉:
      // 後端真的少給一格時這一頁仍然編得過,畫面照樣空白,沒有任何錯誤訊息。
      const data = (await res.json()) as { rows?: DevCustomer[] };
      const rows = Array.isArray(data.rows) ? data.rows : [];
      return { rows: rows.slice(0, MAX_RESULTS), more: rows.length > MAX_RESULTS };
    },
    [],
  );

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUseCrm(role)) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">秒查客戶</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用客戶管理。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">秒查客戶</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            輸入公司名、{lookupLabel}、聯絡人或電話的任一片段,停一下就會查。
            {isViewAllRole(role) ? '你看得到全部訪查人員的客戶。' : '你看得到自己負責的客戶。'}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <QuickSearch search={search} />
      </div>

      <p className="mt-6 text-sm">
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回我的首頁
        </Link>
      </p>
    </div>
  );
}
