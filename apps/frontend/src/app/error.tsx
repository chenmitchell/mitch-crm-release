'use client';

/**
 * App Router 全站錯誤邊界。
 * - 3.3.1 Error Identification:說清楚出了什麼事
 * - 3.3.3 Error Suggestion:給「重試」與「回首頁」兩條路
 * - aria-live="assertive" 立即念給 screen reader
 */
import Link from 'next/link';
import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 前端沒有日誌服務,錯誤只能進瀏覽器 console(no-console 規則本來就允許 error)
    console.error('[frontend] 未預期的錯誤', error);
  }, [error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto max-w-prose space-y-5 rounded-lg border border-destructive bg-surface p-6"
    >
      <h1 className="text-destructive">發生錯誤,頁面無法完整載入</h1>
      <p>
        系統在處理您的請求時遇到問題。您的資料尚未送出,請重試或返回首頁。若問題持續,請截圖下方錯誤代碼回報給業務窗口。
      </p>
      {error.digest ? (
        // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
        <p className="rounded border border-border bg-muted px-3 py-2 font-mono text-sm">
          錯誤代碼:<code>{error.digest}</code>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={reset} className="btn btn-primary min-h-[44px] px-5">
          重試
        </button>
        <Link href="/" className="btn min-h-[44px] px-5">
          回首頁
        </Link>
      </div>
    </div>
  );
}
