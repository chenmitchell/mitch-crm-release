'use client';

import Link from 'next/link';
import { useAppSettings, useLogoText } from '@/lib/app-settings';

interface SiteFooterProps {
  showEnvBadge?: boolean;
  envLabel?: string;
}

/**
 * SiteFooter — 3.2.3 Consistent Navigation + 3.3.5 Help
 *
 * 提供聯絡窗口、無障礙聲明、環境徽章(非 production 才顯示)
 */
export function SiteFooter({ showEnvBadge = false, envLabel = 'development' }: SiteFooterProps) {
  const year = new Date().getFullYear();
  // 產品名與組織名都讀後台設定;沒設定就只顯示產品名,不編一個公司名出來
  const settings = useAppSettings();
  const logoText = useLogoText();
  return (
    <footer className="mt-12 border-t-4 border-sidebar bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">
              {settings.organizationDisplayName
                ? `${settings.organizationDisplayName} · ${logoText}`
                : logoText}
            </p>
            {settings.organizationName ? (
              <p className="text-sm text-muted-foreground">
                © {year} {settings.organizationName}
              </p>
            ) : null}
          </div>
          {/* 2.5.5 AAA 命中區:這三條是獨立的導覽項,不是句子裡的行內連結,
              所以行內例外套不上,實際框要有 44px 高。
              class 一定要是 .footer-nav-link(globals.css):@layer base 的
              a[href]{min-height:44px} 對 display:inline 的元素沒有作用 ——
              CSS 規定非替換行內元素忽略 min-height / min-width,computed value
              是 44px 但用起來還是 16px 高。.footer-nav-link 把它改成 inline-flex
              才真的撐得開。 */}
          <nav aria-label="頁尾連結">
            <ul className="flex flex-wrap gap-x-4 text-sm">
              <li>
                <Link href="/accessibility" className="footer-nav-link">
                  無障礙聲明
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="footer-nav-link">
                  隱私權政策
                </Link>
              </li>
              <li>
                <Link href="/contact" className="footer-nav-link">
                  聯絡管道
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        {showEnvBadge ? (
          // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
          <p className="mt-6 text-xs text-muted-foreground">
            <span className="env-badge" aria-label={`目前環境:${envLabel}`}>
              {envLabel.toUpperCase()}
            </span>
            <span className="ml-2">非 production,此站僅供內部驗收</span>
          </p>
        ) : null}
      </div>
    </footer>
  );
}
