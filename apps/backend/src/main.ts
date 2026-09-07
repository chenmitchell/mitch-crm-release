/**
 * Mitch CRM backend bootstrap.
 *
 * 硬性規則:code 裡不可 hardcode 8080 或 8787。
 *    一律 `process.env.PORT ?? 8787`(預設 fallback,見 common/env.ts)。
 *    部署時要換連接埠,設 PORT 環境變數即可,不用改 code。
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { runStartupMigrations } from './prisma/startup-migrations';
import { reportMigrationWarnings } from './prisma/migration-warnings';
import { ensureSeedAdmin } from './setup/seed-admin';
import { ATTRIBUTION_ROW_ID, seedAttribution } from './setup/seed-attribution';
import { EXPORT_EXPOSED_HEADERS } from './crm/export/export-headers';
import {
  loadEnv,
  publicUrlLocalhostWarning,
  cookieSecureMismatchWarning,
  cookieSameSiteWarning,
} from './common/env';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** body-parser 的預設 JSON 上限(明寫出來,避免有人以為 Nest 預設 parser 還在) */
const DEFAULT_JSON_LIMIT = '100kb';
/** 拜訪打卡存證路徑專用的 JSON 上限(照片 base64 夾在 JSON 內) */
const CRM_CHECKIN_JSON_LIMIT = '5mb';
/** 全域路徑前綴;setGlobalPrefix 與打卡路徑判斷共用同一個常數,改一處兩邊一起變 */
const GLOBAL_PREFIX = 'api';
/** 含全域前綴的打卡路徑(body-parser 在 setGlobalPrefix 之前跑,這裡要比完整路徑) */
const CRM_CHECKIN_PATH_RE = new RegExp(`^/${GLOBAL_PREFIX}/admin/crm-checkin(/|$)`);

/** 只看路徑(去掉 query string)是不是打卡存證 API;且只放行 POST(GET / DELETE 不該帶大 body) */
function isCrmCheckinUpload(req: IncomingMessage): boolean {
  if (req.method !== 'POST' || !req.url) return false;
  const q = req.url.indexOf('?');
  return CRM_CHECKIN_PATH_RE.test(q >= 0 ? req.url.slice(0, q) : req.url);
}

/**
 * ── 回應壓縮的過濾條件 ────────────────────────────────────────────────────
 *
 * 為什麼要壓:看板一次回上千列客戶,JSON 大小是幾百 KB 起跳,而那是純文字,
 * gzip 通常剩下一成上下。docker compose 那條部署路徑上 Caddy 有
 * `encode zstd gzip` 會幫忙壓,但直接把容器對外的那條(例如 PaaS 直連)沒有,
 * 同一份程式碼在兩種部署上差了一個量級的下載量。壓縮掛在應用程式這一層,
 * 兩條路徑就一致了(前面若已經有反向代理壓過,它看到 Content-Encoding 就不會再壓)。
 *
 * 為什麼不是全部都壓(BREACH):壓縮率會洩漏「回應內容裡有沒有出現攻擊者送進來的字串」。
 * 只要同一份回應同時滿足三件事,攻擊者就能一個字元一個字元把機密猜出來:
 *   (1) 回應本文裡有機密,(2) 同一份回應裡反射了攻擊者控制的輸入,
 *   (3) 攻擊者能誘使受害者反覆發出這個請求並觀察密文長度。
 * 這個系統目前最接近的是 `POST /api/invites` —— 它的回應本文帶著一條只出現一次的
 * 邀請連結 token。session 走 httpOnly cookie,cookie 在標頭裡,不受本文壓縮影響。
 *
 * 所以這裡只壓**安全方法**(GET / HEAD)的回應:
 *   - 帶機密的回應都是 POST(邀請連結、登入),整批排除,不必逐條維護白名單。
 *   - 會被跨站誘發、又能重複發出的請求,絕大多數也是 GET 以外的方法在改狀態;
 *     GET 的回應裡沒有一次性機密。
 *   - 新增端點的人不必記得來這裡加例外:預設就是「不是 GET 就不壓」。
 * 之後若真的出現「GET 回應本文裡帶機密」的端點,要嘛不要那樣設計,
 * 要嘛在這裡把那條路徑排除掉,兩件事一起做。
 *
 * text/event-stream 另外排除:壓縮會把事件緩衝住,推播就不即時了。
 * 現在沒有這種端點,先寫在這裡免得之後有人加了才在找為什麼卡住。
 */
function shouldCompressResponse(req: IncomingMessage, res: ServerResponse): boolean {
  // 慣例的逃生口:除錯或代理要求不要壓時,帶這個標頭
  if (req.headers['x-no-compression']) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const type = res.getHeader('Content-Type');
  if (typeof type === 'string' && type.split(';')[0]?.trim() === 'text/event-stream') return false;
  // 其餘交給 compression 自己那套(依 Content-Type 判斷壓不壓得動、有沒有 Accept-Encoding)
  return compression.filter(req as never, res as never);
}

/** 小於這個大小就不壓:壓縮的固定成本比省下來的位元組還多 */
const COMPRESSION_THRESHOLD_BYTES = 1024;

/** Content-Type 是不是 application/json(允許 ; charset=... 參數),與 body-parser 預設 type 一致 */
function isJsonRequest(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  if (!ct) return false;
  return ct.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // 安全關鍵:真實客戶端 IP,rate limiting 的正確性完全靠這一行。
  //    線路是 Client → Cloudflare → Caddy → 這個 Node 程序。
  //    不設 trust proxy 的話,Express 的 `req.ip` 永遠是 Caddy 的位址(127.0.0.1),
  //    throttler 會把全世界的請求算進同一個桶子:一個人打滿,所有人一起 429。
  //
  //    這裡用「hop 數」而不是直接讀 CF-Connecting-IP,因為 CF-Connecting-IP 是
  //    一個可以任意偽造的 header,只要有人繞過 Cloudflare 直接打到 Caddy,
  //    他就能自帶一個假的來源 IP,rate limit 形同虛設。用 hop 數至少是從
  //    X-Forwarded-For 的尾端(靠近實際 TCP 對端那側)往回數,偽造成本高一些。
  //
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  //    部署前提:Caddy 必須只接受來自 Cloudflare IP 範圍的連線
  //    (或自行覆寫 X-Forwarded-For)。否則攻擊者直連 Caddy 並自帶
  //    `X-Forwarded-For: a, b, c` 一樣能把 req.ip 頂成任意值。
  //    hop 數與實際 proxy 層數必須一致:設太小 = 大家共用一個桶,設太大 = 可被偽造。
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  // 回應壓縮。掛在最前面(在 helmet 與 body parser 之前),下游寫出去的東西才吃得到。
  // 過濾條件與 BREACH 的取捨見 shouldCompressResponse 的說明:只壓 GET / HEAD。
  app.use(compression({ filter: shouldCompressResponse, threshold: COMPRESSION_THRESHOLD_BYTES }));

  // 安全關鍵:CSP 針對純 API server — 我們不發 HTML,所以最嚴格 default-src 'none' 即可。
  //    拒絕任何 <script>/<iframe>/<img> 等被夾帶進 API 回應時意外執行。
  //    frame-ancestors 'none' 額外擋 clickjacking(與 X-Frame-Options DENY 雙保險)。
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(cookieParser());

  // JSON body 上限:只有拜訪打卡存證(/api/admin/crm-checkin/**)放大到 5mb,
  // 因為照片以 base64 夾在 JSON 內(service 另限每張 600KB、每批 3MB、每客戶 20MB、每人每日 100MB);
  // 其他所有路徑維持 body-parser 預設 100kb。
  //
  // 做法說明:body-parser 不是本專案的直接相依(pnpm 嚴格模式下 import 不到),
  // 所以不能 app.use('/api/admin/crm-checkin', json({ limit: '5mb' }));改用 Nest 的
  // useBodyParser 掛兩個 json parser:第一個用 `type` 函式只認打卡路徑的 JSON 請求(5mb),
  // 第二個是預設額度(100kb)給其餘路徑。同一請求只會被其中一個解析:
  // body-parser 解析過會設 req._body,後面的 parser 看到就直接 next()。
  // 注意:Nest 在 init() 時若已看到名為 jsonParser 的 middleware 就不會再掛自己的預設 json parser
  // (useBodyParser 掛的正是 jsonParser),所以第二個「預設額度」的 parser 一定要自己掛,不能省。
  // urlencoded parser 沒被動到,Nest 仍會照常掛預設的那個。
  app.useBodyParser('json', {
    limit: CRM_CHECKIN_JSON_LIMIT,
    type: (req) => isJsonRequest(req) && isCrmCheckinUpload(req),
  });
  app.useBodyParser('json', { limit: DEFAULT_JSON_LIMIT });

  // CORS — 僅允許已知 frontend origin
  //
  // exposedHeaders 不能省。跨網域時瀏覽器預設只讓 JavaScript 讀到七個
  // 安全清單內的回應標頭,其餘一律看不到 —— 沒有錯誤、沒有警告,
  // res.headers.get('X-Export-Truncated') 就只是回 null。
  // 匯出頁靠這幾個標頭才說得出「這一次有沒有踩到 5000 筆上限、下一段從第幾筆開始」,
  // 少了這一行,那個畫面在單網域部署下是對的、換成前後端不同網域就安靜地失效。
  // Content-Disposition 也要列進來:下載的檔名是從那個標頭讀出來的。
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: [...EXPORT_EXPOSED_HEADERS],
  });

  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: ['healthz', 'readyz'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Shutdown hooks(接 SIGTERM,容器平台停服務時會送)
  app.enableShutdownHooks();

  // 啟動時套用 additive 的資料庫遷移。放在 listen 之前,服務對外開放時結構已經就緒;
  // 單步失敗只記錄不中斷,詳見 prisma/startup-migrations.ts 的說明。
  const prisma = app.get(PrismaService);
  await runStartupMigrations(prisma);

  // 遷移跑完之後盤點一次:哪一道「有重複就先不建」的索引仍然沒有建起來。
  // 那幾步用的 RAISE WARNING 只進 PostgreSQL 的 server log,大部分部署方讀不到,
  // 所以這裡把同一件事寫成一列 error_logs,管理員在後台的錯誤記錄頁看得見。
  // 失敗不擋啟動(見 prisma/migration-warnings.ts)。
  await reportMigrationWarnings(prisma);

  // 署名紀錄(system_settings#3687)。idempotent:那一列在就跳過。
  // 以前這件事只由 compose 的一次性 bootstrap 容器做,但那個容器根本跑不起來
  // (共用 backend 的 env 而 JWT_ACCESS_SECRET 是空的、沒掛 app-secrets volume、
  // 用 builder stage 所以自動產生金鑰的 ENTRYPOINT 不會執行),於是零設定安裝的人
  // 只會看到一個 exited(1) 的容器,而署名從來沒寫進去。搬到這裡之後
  // Docker 與 Zeabur 兩條安裝路線跑的是同一份程式碼。
  // 寫不進去不擋啟動:資料庫暫時不通不該讓整個服務起不來,記一筆警告就好。
  const startupLogger = new Logger('Bootstrap');
  try {
    const attribution = await seedAttribution(prisma);
    if (attribution === 'created') {
      startupLogger.log(`已寫入署名紀錄 system_settings#${ATTRIBUTION_ROW_ID}`);
    }
  } catch (err) {
    startupLogger.warn(`寫入署名紀錄失敗(不影響啟動):${String(err)}`);
  }

  // 資料庫裡一個使用者都沒有,而且設了 SEED_ADMIN_EMAIL 與 SEED_ADMIN_PASSWORD 時,
  // 建第一個管理員。沒設就什麼都不做,讓人走 /setup 安裝精靈。
  // 有任何既有帳號時整段跳過,不會覆寫任何人(見 setup/seed-admin.ts)。
  await ensureSeedAdmin(prisma, env);

  const port = env.PORT;
  await app.listen(port, '0.0.0.0');

  const logger = startupLogger;
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  logger.log(`Mitch CRM backend listening on :${port} (NODE_ENV=${env.NODE_ENV})`);
  // 對外網址還停在 localhost 的話喊一聲(理由見 publicUrlLocalhostWarning)
  const publicUrlWarning = publicUrlLocalhostWarning(env);
  if (publicUrlWarning) logger.warn(publicUrlWarning);
  // 對外是 https、cookie 卻不帶 Secure 的話喊一聲(理由見 cookieSecureMismatchWarning)
  const cookieWarning = cookieSecureMismatchWarning(env);
  if (cookieWarning) logger.warn(cookieWarning);
  // SameSite=None 卻不是 https 的話也喊一聲(理由見 cookieSameSiteWarning)
  const sameSiteWarning = cookieSameSiteWarning(env);
  if (sameSiteWarning) logger.warn(sameSiteWarning);
}

bootstrap().catch((err) => {
  console.error('[Mitch CRM] fatal bootstrap error:', err);
  process.exit(1);
});
