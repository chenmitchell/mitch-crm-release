import Link from 'next/link';

export const metadata = {
  title: '找不到頁面',
};

export default function NotFound() {
  return (
    <div role="alert" aria-live="polite" className="mx-auto max-w-prose space-y-5 py-10">
      <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">404</p>
      <h1>找不到這個頁面</h1>
      <p>您要找的頁面可能已經移動、暫未開通,或網址打錯了。請從下列入口重新進入。</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/" className="btn btn-primary min-h-[44px] px-5">
          回首頁
        </Link>
        <Link href="/contact" className="btn min-h-[44px] px-5">
          聯絡業務窗口
        </Link>
      </div>
    </div>
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  );
}
