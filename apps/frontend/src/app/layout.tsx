import type { Metadata, Viewport } from 'next';
import { Noto_Sans_TC } from 'next/font/google';
import { SkipLink } from '@/components/a11y/skip-link';
import { RouteAnnouncer } from '@/components/a11y/route-announcer';
import { SITE_TITLE } from '@/components/a11y/route-titles';
import { AbbrKeyboardFocus } from '@/components/a11y/abbr-keyboard-focus';
import { SiteHeader } from '@/components/layout/site-header';
import { OfflineBanner } from '@/components/layout/offline-banner';
import { SiteFooter } from '@/components/layout/site-footer';
import Watermark from '@/components/Watermark';
import { getPublicEnv } from '@/lib/env';
import { inlineBootScript } from '@/lib/theme';
import { OrgAppearance } from '@/components/layout/org-appearance';
import { AppSettingsProvider } from '@/lib/app-settings';
import { MeProvider } from '@/lib/me-context';
import { SetupGate } from '@/components/setup-gate';
import './globals.css';

// Noto Sans TC — 主要正體中文字體,CSS var 透過 Tailwind --font-sans 串接
const notoSansTC = Noto_Sans_TC({
  variable: '--font-noto-sans-tc',
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
});

/**
 * 署名(不可見於畫面,只出現在 HTML 原始碼)
 *
 * 法律定位照 LICENSE:本軟體係著作人自行研發之著作,著作權(含財產權與人格權)
 * 歸著作人所有,以 MPL-2.0 加姓名表示權附款釋出。這裡標的是著作人。
 *
 * 單一來源,以下四處共用:metadata、head meta、body 開頭註解、body 結尾 JSON-LD。
 */
const AUTHOR_NAME = 'Mitchell Chen (陳彥輔) aka 米球®';
const COPYRIGHT_OWNER = 'Mitchell Chen(陳彥輔)';
const COPYRIGHT_OWNER_EN = 'Mitchell Chen';
const COPYRIGHT_NOTICE = `Copyright (c) 2026 ${COPYRIGHT_OWNER} aka 米球®;依 MPL-2.0 加姓名表示權附款釋出,詳見 LICENSE`;

const ATTRIBUTION_COMMENT = `<!--
  著作人 / Author: Mitchell Chen(陳彥輔)aka 米球®
  Copyright (c) 2026 Mitchell Chen(陳彥輔)

  本系統由著作人自行研發,著作權歸著作人所有,依 MPL-2.0 加姓名表示權附款釋出。
  本頁及原始碼中的作者標示不得移除或竄改。
  「米球」為著作人之個人註冊商標,不隨授權移轉。

  Independently developed. Copyright is held by the author and released
  under MPL-2.0 with an attribution addendum. Author credits in this page
  and in the source code must not be removed or altered. "米球" is a
  registered trademark of the author and does not transfer with the license.

  詳見專案根目錄 LICENSE / See LICENSE at the project root.
-->`;
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

/**
 * schema.org CreativeWork(輸出成 application/ld+json)
 *
 * 選這個做法而不是再放一段 HTML 註解:
 * 1. 它是每個網站都有的結構化資料,看起來就是 SEO 用的東西,不像署名區塊那樣
 *    一眼就想順手刪掉。
 * 2. 機器可讀。爬蟲、驗證工具、任何 structured data parser 都能把 author /
 *    creator 抓出來,日後要舉證「這頁一直帶著作者標示」有客觀依據。
 * 3. 位置在 body 結尾,跟 body 開頭那段註解形式不同、內容不同,兩處互為備援。
 * 4. type 是 application/ld+json,瀏覽器不執行也不算 script 內容,畫面完全不受影響。
 */
const ATTRIBUTION_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'CreativeWork',
  name: 'Mitch CRM',
  inLanguage: 'zh-TW',
  author: {
    '@type': 'Person',
    name: 'Mitchell Chen',
    alternateName: ['陳彥輔', '米球'],
  },
  creator: {
    '@type': 'Person',
    name: 'Mitchell Chen',
    alternateName: ['陳彥輔', '米球'],
  },
  copyrightYear: 2026,
  copyrightHolder: {
    '@type': 'Person',
    name: COPYRIGHT_OWNER_EN,
    alternateName: ['陳彥輔', '米球'],
  },
  copyrightNotice: COPYRIGHT_NOTICE,
  creditText: '著作人暨著作權人 Mitchell Chen(陳彥輔)aka 米球®',
  usageInfo: '授權條款見專案根目錄 LICENSE',
};
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

// `</script>` 不可能出現在上面的靜態物件裡,這行是純防呆:
// 就算日後有人往裡面加了帶尖括號的字串,也不會把 script 標籤提早關掉。
const ATTRIBUTION_JSONLD_TEXT = JSON.stringify(ATTRIBUTION_JSONLD).replace(/</g, '\\u003c');

/**
 * 產品名的預設值。畫面上看得到的地方(站頭商標、頁尾)一律讀後台設定
 * (見 lib/app-settings.tsx),但 metadata 是伺服器端在 render 前就要決定的,
 * 那時還沒有辦法問設定 API,所以這裡放預設值。
 * 要換瀏覽器分頁標題,改後台設定之外還要在這裡改;這是刻意的取捨,
 * 為了不讓每一頁的 <title> 都得等一次 API 才畫得出來。
 */
export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_TITLE}`,
  },
  description: '實地訪查型客戶關係管理系統:客戶看板、到訪打卡與照片存證、拜訪地圖與日報',
  applicationName: 'Mitch CRM',
  // PWA 最小可安裝:只有 manifest + iOS 主畫面標題,不做 service worker(避免快取到舊 bundle)。
  // 因為沒有 service worker,離線時「沒開過的頁面」打不開,所以 manifest 的 display 是
  // minimal-ui 而不是 standalone —— 留著瀏覽器自己的網址列與重新整理鈕,技師才看得出
  // 那是一個需要連線的網頁,而不是壞掉的 App。理由寫在 public/manifest.webmanifest 旁的文件。
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Mitch CRM' },
  // iOS 加到主畫面用的圖示(manifest 的 icons iOS 不讀)
  icons: { apple: '/icons/icon-192.png' },
  authors: [{ name: AUTHOR_NAME }],
  creator: AUTHOR_NAME,
  publisher: COPYRIGHT_OWNER,
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  robots: {
    // 內部作業系統,不對外 index
    index: false,
    follow: false,
  },
};

// 2.5.5 AAA Target Size — 不鎖 user-scalable;允許放大到 5x
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  // 使用者可以在站頭選淺色 / 深色 / 跟隨系統,所以這裡不能再鎖 'light',
  // 否則瀏覽器會把捲軸與原生表單控制項畫成跟頁面相反的色。
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const env = getPublicEnv();
  const showEnvBadge = env.appEnv !== 'production';

  return (
    <html lang="zh-TW" className={notoSansTC.variable} suppressHydrationWarning>
      <head>
        {/* 佈景 boot script:同步（非 defer / 非 useEffect）讀 localStorage,
            在任何樣式套用前把 data-scheme / data-theme / data-sidebar 寫上 <html>,
            避免第一畫面閃錯色。內容是 lib/theme.ts 裡的純字串常數,沒有拼接任何外部輸入。
            <html> 已經有 suppressHydrationWarning,所以這個屬性差異不會噴 hydration 警告。 */}
        <script dangerouslySetInnerHTML={{ __html: inlineBootScript }} />
        {/* 版權標示,不影響畫面 */}
        <meta name="copyright" content={COPYRIGHT_NOTICE} />
        <meta name="author" content={AUTHOR_NAME} />
      </head>
      <body>
        {/* 原始碼署名區塊:輸出為 HTML 註解,畫面上不可見 */}
        <div
          hidden
          aria-hidden="true"
          style={{ display: 'none' }}
          dangerouslySetInnerHTML={{ __html: ATTRIBUTION_COMMENT }}
        />
        <SkipLink targetId="main-content" />
        {/* 2.4.2 Page Titled:整站二十幾頁是 client component 拿不到 metadata,
            標題與換頁播報由這一支負責(見 components/a11y/route-announcer.tsx)。 */}
        <RouteAnnouncer />
        {/* 3.1.3 AAA:讓 <abbr title> 可以被鍵盤聚焦(聚焦時的說明框在 globals.css) */}
        <AbbrKeyboardFocus />
        {/* 全站設定(產品名、階段清單、照片檢查表、功能區配色、主機時間)的單一供應點。
            包在最外層,站頭、頁尾與浮水印也要用得到 —— 浮水印原本在這個 Provider 外面,
            所以它只能自己再打一次同一支設定端點。 */}
        <AppSettingsProvider>
          {/* 目前登入者的單一供應點。站頭、admin 外框、浮水印與 CRM 各頁共用同一份,
              整站對 /api/auth/me 只有這一個呼叫點。 */}
          <MeProvider>
            <Watermark />
            <OrgAppearance />
            {/* 還沒跑過安裝精靈時,任何路徑都先送去 /setup */}
            <SetupGate />
            <SiteHeader />
            {/* 沒有網路時,每一頁最上面都要看得出來「是沒網路」,而不是白畫面或
                「請稍後再試」。這套系統沒有 service worker,離線時重新整理打不開,
                所以這一條提示只在頁面已經載入的情況下有用 —— 那也正是外勤的常態。 */}
            <OfflineBanner />
            <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-8">
              {children}
            </main>
            <SiteFooter showEnvBadge={showEnvBadge} envLabel={env.appEnv} />
          </MeProvider>
        </AppSettingsProvider>
        {/* 結構化資料:著作人與授權關係,不產生任何可見內容 */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: ATTRIBUTION_JSONLD_TEXT }}
        />
      </body>
    </html>
  );
}
