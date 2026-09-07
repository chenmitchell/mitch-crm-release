'use client';

// 拜訪日報(/admin/crm/field/report)。原本在 /admin/crm/field 頁的第二區,拆頁後獨立。
// 上半:當日自動彙整的日報文字(可複製);下半:daily-report-submit 元件,把內容送給主管(同日再送會覆蓋)。
// 資料來源:GET /api/admin/crm/report?range=today&scope=me;送出由元件自己打 /api/admin/crm-daily-reports。
// 離線:日報一定要連線才載得到(它是後端當日彙整出來的)。載不到時要說得出「是沒網路」,
//   不要退成「請稍後再試」—— 那句話沒說出原因,而它建議的動作在沒訊號的地方永遠不會成功。
//   已經打好、還沒送出的日報內容留在畫面上,不會被清掉。
// 無障礙:單一 h1、複製結果 role="status" aria-live、唯讀 textarea 有 label、按鈕 >= 44px(.btn 已含)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import DailyReportSubmit from '@/components/crm/daily-report-submit';
import { canUseCrm, crmApiBase, useCrmRole } from '@/lib/crm-shared';
import { isNetworkError, reportNetworkFailure, reportNetworkSuccess } from '@/lib/network-status';

export default function FieldReportPage() {
  const role = useCrmRole();
  const [reportText, setReportText] = useState<string>('');
  const [reportStats, setReportStats] = useState<Record<string, number> | undefined>(undefined);
  const [reportLoading, setReportLoading] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const canUse = canUseCrm(role);

  const loadReport = useCallback(async () => {
    if (role === null || !canUse) return;
    setReportLoading(true);
    setCopyMsg(null);
    try {
      const res = await fetch(`${crmApiBase()}/report?range=today&scope=me`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setReportText('拜訪日報載入失敗,請稍後再試。');
        return;
      }
      reportNetworkSuccess();
      const data = (await res.json()) as { text?: string; stats?: Record<string, unknown> };
      setReportText(data.text ?? '');
      // stats 只留數字欄位,原樣交給 DailyReportSubmit 一起送後端
      const st: Record<string, number> = {};
      if (data.stats && typeof data.stats === 'object') {
        for (const [k, v] of Object.entries(data.stats))
          if (typeof v === 'number' && Number.isFinite(v)) st[k] = v;
      }
      setReportStats(Object.keys(st).length > 0 ? st : undefined);
    } catch (e) {
      if (isNetworkError(e)) {
        reportNetworkFailure();
        setReportText(
          '目前沒有網路連線,載不到今天的日報彙整。\n' +
            '日報是後端當天算出來的,一定要連線才看得到。回到有網路的地方按「重新整理」即可。\n' +
            '在這裡自己打的內容不會因為沒有網路而消失,但也還沒送出去。',
        );
      } else {
        setReportText('拜訪日報載入失敗,請稍後再試。');
      }
    } finally {
      setReportLoading(false);
    }
  }, [role, canUse]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  async function handleCopy() {
    if (reportLoading) return;
    setCopyMsg(null);
    if (!reportText) {
      setCopyMsg('目前沒有可複製的日報內容');
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(reportText);
        setCopyMsg('已複製到剪貼簿');
      } else {
        setCopyMsg('此瀏覽器不支援複製,請手動選取文字');
      }
    } catch {
      setCopyMsg('複製失敗,請手動選取文字');
    }
  }

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">拜訪日報</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用外勤拜訪。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">拜訪日報(當日)</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        上面是今天的自動彙整,下面可以改寫後送給主管;同一天再送一次會覆蓋前一次。
      </p>

      <section className="mt-4 rounded-lg border border-border bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            <label htmlFor="field-report-text">今日彙整</label>
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn"
              onClick={() => void handleCopy()}
              aria-busy={reportLoading}
            >
              複製日報內容
            </button>
            <button type="button" className="btn" onClick={() => void loadReport()}>
              重新整理
            </button>
          </div>
        </div>

        <textarea
          id="field-report-text"
          readOnly
          value={reportLoading ? '日報載入中…' : reportText}
          rows={8}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="今日尚無拜訪日報內容。"
        />

        <p
          role="status"
          aria-live="polite"
          className="mt-2 min-h-[1.25rem] text-xs text-muted-foreground"
        >
          {copyMsg}
        </p>
      </section>

      {/* 日報送主管:預填上面的日報文字,可改後送出 */}
      <section className="mt-4">
        <DailyReportSubmit defaultText={reportText} stats={reportStats} />
      </section>

      <p className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link href="/admin/crm/field/checkin" className="underline underline-offset-2">
          回到打卡
        </Link>
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回我的首頁
        </Link>
      </p>
    </div>
  );
}
