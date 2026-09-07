/**
 * App Router 全站預設 loading UI。
 * 用 skeleton 而非 spinner(見 frontend-ui-engineering skill)
 * aria-busy + aria-label 讓 screen reader 說明目前狀態
 */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="頁面載入中" className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/4 max-w-prose animate-pulse rounded bg-muted" />
      <div className="h-4 w-2/3 max-w-prose animate-pulse rounded bg-muted" />
      <div className="h-32 w-full animate-pulse rounded-lg bg-muted" />
      <span className="sr-only">頁面載入中,請稍候…</span>
    </div>
  );
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
