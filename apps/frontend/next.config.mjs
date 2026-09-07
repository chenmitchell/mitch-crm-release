// @ts-check
// ref:3687 mc/陳彥輔/米球®
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_ORIGIN_FROM_ENV = process.env.NEXT_PUBLIC_API_BASE_URL;
const IS_PROD_BUILD =
  process.env.NODE_ENV === 'production' || process.env.NEXT_PHASE === 'phase-production-build';

/**
 * production build 需要的 NEXT_PUBLIC_* env var,在 config 載入時就一次擋掉。
 *
 * 為什麼兩個都要擋:src/lib/env.ts 的 zod schema 同時要求 apiBaseUrl 與 siteUrl,
 * 但那個檢查要等到 render 才跑。只擋 API_BASE_URL 的話,少了 SITE_URL 會一路
 * build 到 prerender 才炸,錯誤訊息還是 zod 的堆疊,看不出是漏了 env。
 * 這裡提早失敗,訊息直接指名缺哪一個。
 */
const REQUIRED_PUBLIC_ENV = [
  ['NEXT_PUBLIC_API_BASE_URL', 'https://api.example.com'],
  ['NEXT_PUBLIC_SITE_URL', 'https://crm.example.com'],
];
if (IS_PROD_BUILD) {
  const missing = REQUIRED_PUBLIC_ENV.filter(([key]) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      '[next.config] production build 缺少必要環境變數:\n' +
        missing.map(([key, example]) => `  - ${key}(例:${example})`).join('\n') +
        '\n請先設定這些環境變數再 build。說明見 apps/frontend/.env.example,' +
        '整套部署的環境需求見 docs/。',
    );
  }
}

// 開發時的後端預設埠。正式部署一律由 NEXT_PUBLIC_API_BASE_URL 指定,
// 這個值只在本機沒設 env 時當開發預設。
const API_ORIGIN = API_ORIGIN_FROM_ENV ?? 'http://localhost:8787';

/**
 * CSP。**只有 script-src 分環境**,其他每一條 production 與 development 一模一樣。
 *
 * 為什麼 development 要放 'unsafe-eval':`next dev` 的 HMR runtime 用 eval 載入
 * 更新後的模組。少了它,瀏覽器直接擋下來:
 *
 *   EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval'
 *   is not an allowed source of script in the following CSP directive:
 *   "script-src 'self' 'unsafe-inline'"
 *
 * 而 React 一次都沒有 hydrate 的症狀不是「壞掉」,是「畫面永遠停在載入中」,
 * 表單一個都按不動 —— 看起來像前端寫壞了,實際上是這一行。
 * CONTRIBUTING.md 叫貢獻者跑 `pnpm dev`,所以這一行等於
 * 讓每一個照文件走的貢獻者拿到一個不能操作的畫面。
 *
 * ★ production **絕對不放** 'unsafe-eval'。那是 XSS 打進來之後把字串變成程式碼的
 *   主要途徑,而正式產物根本不需要 eval(HMR 只存在於 dev server)。
 *
 * ★ 判斷方式是「fail closed」:只有**確定是 dev server**才放行,其餘一律當 production。
 *   不能只寫 `NODE_ENV !== 'production'`,理由是這個標頭是 **build 時**算好寫進
 *   .next/routes-manifest.json 的(`next start` 只是照著送,實測過:
 *   `NODE_ENV=development next start` 送出來的仍然是 build 當下算的那一份),
 *   而 Next 的 CLI 對 NODE_ENV 是 `process.env.NODE_ENV || 預設值` ——
 *   已經設成別的值就照留,只多印一行 non-standard NODE_ENV 的警告。
 *   也就是說 `NODE_ENV=staging pnpm build`、`NODE_ENV=test pnpm build`,或任何
 *   在 build 前把 NODE_ENV 設成 development 以便裝 devDependencies 的平台,
 *   都會把 'unsafe-eval' 烤進正式產物,而且之後怎麼跑都改不掉。
 *   zeabur/template.yaml 把 NODE_ENV 開成使用者可改的變數,那條路徑是真的走得到的。
 *   所以這裡同時看 NEXT_PHASE:`next build` 是 phase-production-build,
 *   一旦是它就絕不放行(檔案上方的 IS_PROD_BUILD 早就用同一個訊號)。
 *
 * 'unsafe-inline' 兩邊都留著:Next.js 的 App Router 會在頁面裡放 inline 的
 * bootstrap script(RSC payload、路由狀態),那不是 dev 專屬的東西。
 * 要拿掉必須改成 nonce,那是另一件事,不在這一次的範圍。
 *
 * @param {boolean} allowEval 只有確定是 dev server 才是 true
 * @returns {string}
 */
function cspFor(allowEval) {
  const scriptSrc = allowEval
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https://fonts.gstatic.com",
    `connect-src 'self' ${API_ORIGIN}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @mitchcrm/shared 現在有自己的建置步驟(dist/*.js + .d.ts),Next 不必再轉譯原始碼。
  // 留著這一行是為了 pnpm workspace 的 symlink:transpilePackages 會讓 Next 把它
  // 當成自家程式碼處理,不會因為它在 node_modules 底下就跳過。
  transpilePackages: ['@mitchcrm/shared'],
  poweredByHeader: false,
  output: 'standalone',
  // build context 是 **monorepo root**,不是 apps/frontend。
  // 前端有 workspace 相依(@mitchcrm/shared),node_modules/@mitchcrm/shared 是一條
  // 指向 ../../packages/shared 的 symlink,tracing root 收在 apps/frontend 的話
  // standalone 產物會漏掉那個套件,容器一啟動就 MODULE_NOT_FOUND。
  // 這個值也決定 standalone 的目錄結構:產物是 .next/standalone/apps/frontend/server.js,
  // 對應的 COPY 路徑寫在 apps/frontend/Dockerfile。
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  typedRoutes: true,
  // 雙保險:webpack alias 顯式定義 @/* → ./src/*
  // (即使 tsconfig.paths 沒被 next 讀到,webpack 也會解)
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@': path.join(__dirname, 'src'),
    };
    return config;
  },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    // 只有「NODE_ENV 剛好是 development」而且「不是 production build」才放行 eval,
    // 理由見 cspFor 上面那一段。任何其他組合(staging / test / 沒設 / build 階段)
    // 一律走 production 的那一條,寧可 dev server 少一個便利,也不要讓正式產物帶著 eval。
    const isDevServer =
      process.env.NODE_ENV === 'development' && process.env.NEXT_PHASE !== 'phase-production-build';
    const base = [
      { key: 'Content-Security-Policy', value: cspFor(isDevServer) },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(self), microphone=(), geolocation=(self), payment=(self)',
      },
    ];
    const prod = [
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    ];
    return [{ source: '/:path*', headers: isProd ? [...base, ...prod] : base }];
  },
};

export default nextConfig;
