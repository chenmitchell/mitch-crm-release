/**
 * Backend env var schema + loader
 *
 * - Zod 驗證失敗就 fail-fast(boot 時就爆,不等 runtime)
 * - 硬性規則:不 hardcode 8787,僅以 ?? 8787 當 fallback
 *
 * === 怎麼讀 env(三種寫法,各有各的用途)===
 *
 * 這一段以前寫的是「所有讀 env 的地方請 import getEnv 而非直接讀 process.env」,
 * 但實際上 repo 裡三種寫法並存。與其留一句沒有人遵守的規則,不如把三種各自
 * 什麼時候用寫清楚:
 *
 *   1. **模組載入期的 `const env = loadEnv();`**
 *      用在「值要當成模組常數」的地方:app.module.ts 的 ThrottlerModule 設定、
 *      auth.module.ts 的 JwtModule.register、jwt.strategy.ts 的 secret、
 *      各 controller 的 @Throttle() 裝飾器參數。這些位置在 Nest 建 DI 容器之前
 *      就要有值,拿不到 getEnv() 的延遲求值好處,所以直接在模組層級讀。
 *      代價寫在下面「為什麼這支要自己讀 .env」那一段:正是它逼得這支要自己載 .env。
 *
 *   2. **方法或建構子裡的 `getEnv()`**
 *      預設寫法。只要不是非在模組載入期不可,一律用這個 —— 求值延到真的要用的
 *      那一刻,測試就不必為了 import 一個檔案而先備妥整組環境變數。
 *      errors.service.ts 的建構子有一段註解正好講這件事:那一支被
 *      GlobalExceptionFilter 匯入,模組層級的 loadEnv() 會讓任何 import 到
 *      filter 的測試都得先湊齊 DATABASE_URL / JWT_ACCESS_SECRET 才跑得起來。
 *
 *   3. **直接讀 `process.env`(例外,要寫明理由)**
 *      目前只有兩處,兩處都是刻意的:
 *        - prisma.service.ts 讀 NODE_ENV:PrismaService 幾乎每一支單元測試都會
 *          碰到,走 loadEnv() 等於讓整組測試都要先有完整 env。
 *        - crm-geo.service.ts 讀 NOMINATIM_EMAIL:同上,而且那一格的真正來源是
 *          後台設定,env 只是留空時的退路。
 *      NOMINATIM_EMAIL 仍然列進下面的 envSchema —— 列進去是為了「文件有、schema
 *      也有」,填錯變數名或填了不是 email 的值會在開機時就講清楚,不是靜靜退回
 *      placeholder。新增例外請比照辦理:在使用處寫明為什麼不能走 getEnv()。
 *
 * === 為什麼這支要自己讀 .env ===
 *
 * 這個專案有一半的模組(app.module / auth/* / public-settings.controller)
 * 是在 **module import 期** 就呼叫 loadEnv() 取值當成模組常數。
 * 那個時間點比 NestJS 的 ConfigModule.forRoot() 早 —— ConfigModule 要等 Nest 開始
 * 建 DI 容器才會去讀 .env,而 import 早就跑完了。
 *
 * 結果是:只有「平台把環境變數直接注進 process」的部署方式(PaaS、docker compose
 * 的 environment:)才過得了驗證。IT 自己在機器上 `cp .env.example .env` 填好再
 * `pnpm start` 的話,loadEnv() 看到的 process.env 裡根本沒有 DATABASE_URL,
 * 直接 `DATABASE_URL: Required` 然後 process.exit(1)。
 *
 * 所以驗證之前先自己把 .env 補進 process.env。兩個硬性規則:
 *
 *   1. override: false —— 已經在 process.env 裡的值優先,.env 只補沒有的。
 *      反過來做的話,平台注入的正式值會被機器上一份過期的 .env 蓋掉,
 *      而且畫面與 log 完全正常,只有連到的資料庫悄悄變成別台。
 *   2. NODE_ENV=test 不讀 .env —— 測試只認 spec 自己塞的 process.env,
 *      不能被開發機上的 .env 汙染(不然同一支測試在別人機器上結果不一樣)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { z } from 'zod';
import { PASSWORD_MIN } from '@mitchcrm/shared';

/** 從 startDir 往上找,回傳第一個滿足 match 的目錄;找不到回 null。 */
function findUp(startDir: string, match: (dir: string) => boolean, maxLevels = 8): string | null {
  let dir = startDir;
  for (let i = 0; i <= maxLevels; i += 1) {
    if (match(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readPackageName(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * .env 的搜尋順序(先找到的先贏,因為 dotenv 不覆蓋已存在的 key)。
 *
 *   1. process.cwd()/.env         —— 你在哪裡下指令就先看哪裡,最直覺
 *   2. apps/backend/.env          —— docs/安裝與部署.md 教的位置
 *   3. monorepo 根目錄/.env       —— scripts/setup.sh 產生的位置(docker compose 用的那份)
 *
 * 2 與 3 是從這個檔案自己的位置往上推,不是從 cwd 推 —— 不管 systemd 把
 * WorkingDirectory 設在哪、或是 pnpm 從哪一層呼叫,都指得到同一份檔案。
 * 編譯後這支在 dist/common/,原始碼在 src/common/,兩種情況往上找都會先碰到
 * apps/backend/package.json。
 */
export function envFileCandidates(): string[] {
  const out: string[] = [];
  const push = (p: string | null | undefined): void => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!out.includes(abs)) out.push(abs);
  };

  push(path.join(process.cwd(), '.env'));

  const backendRoot =
    findUp(__dirname, (d) => readPackageName(d) === '@mitchcrm/backend') ??
    path.resolve(__dirname, '..', '..');
  push(path.join(backendRoot, '.env'));

  const repoRoot = findUp(backendRoot, (d) => fs.existsSync(path.join(d, 'pnpm-workspace.yaml')));
  push(repoRoot ? path.join(repoRoot, '.env') : null);

  return out;
}

let dotEnvFilesLoaded: string[] | null = null;

/**
 * 把找得到的 .env 併進 process.env,回傳實際讀到的檔案路徑(依讀取順序)。
 *
 * 只做一次(結果快取),重複呼叫是 no-op。已存在於 process.env 的 key 一律不動。
 * NODE_ENV=test 時直接回空陣列,連檔案都不看。
 *
 * seed / CLI 腳本若不需要整份 env 驗證,可以只呼叫這一支。
 */
export function loadDotEnvFiles(): string[] {
  if (dotEnvFilesLoaded) return dotEnvFilesLoaded;

  const loaded: string[] = [];
  if (process.env.NODE_ENV === 'test') {
    dotEnvFilesLoaded = loaded;
    return loaded;
  }

  for (const file of envFileCandidates()) {
    if (!fs.existsSync(file)) continue;
    const result = dotenv.config({ path: file, override: false });
    if (result.error) {
      // 讀不動就跳過(權限、目錄同名之類),不要在這裡把服務弄死 ——
      // 真的缺值的話下面的 zod 會報出到底缺哪一個,那個訊息比 EACCES 有用。
      console.warn(`[Mitch CRM] 略過讀不到的 env 檔 ${file}:${result.error.message}`);
      continue;
    }
    loaded.push(file);
  }

  dotEnvFilesLoaded = loaded;
  return loaded;
}

/**
 * 環境變數的布林值解析。
 *
 * 不用 z.coerce.boolean():那等同 Boolean(字串),除了空字串以外全部是 true,
 * 所以 `FLAG=false` 會變成 true —— 這是設定檔類 bug 裡最難自己發現的一種,
 * 因為畫面與 log 都不會有任何異狀,只有行為悄悄相反。
 *
 * 這裡只認一組明確的字面值,其餘(含拼錯的值)一律回 fallback,
 * 寧可退回安全的預設,也不要把拼錯當成「開啟」。
 */
function envBoolean(fallback: boolean) {
  const TRUE = new Set(['true', '1', 'yes', 'on']);
  const FALSE = new Set(['false', '0', 'no', 'off', '']);
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return fallback;
      const s = v.trim().toLowerCase();
      if (TRUE.has(s)) return true;
      if (FALSE.has(s)) return false;
      return fallback;
    });
}

/**
 * 「空字串等同沒填」的正規化。
 *
 * zod 的 `.optional()` 只放行 `undefined`,不放行空字串。但部署面送進來的正是空字串:
 *
 *   - `docker-compose.yml` 的 `${ENTRA_REDIRECT_URI:-}` 展開後是 `""`(key 存在、值是空的)
 *   - `.env.example` 裡的 `COOKIE_SECURE=` 被 dotenv 讀成 `""`
 *
 * 這兩種寫法都是文件明講的「留空 = 用預設值 / 關閉這個功能」,
 * 例如 `SEED_ADMIN_PASSWORD` 留空就是「不要自動建管理員,讓人走 /setup 精靈」。
 * 不正規化的話,照文件做的 IT 會在 boot 當下吃到
 * `ENTRA_REDIRECT_URI: Invalid url` 然後 exit(1) —— 而且他根本沒打算開 SSO。
 *
 * 判準直接跟 schema 走,不手寫名單:手寫的名單一定會跟 schema 走散,
 * 之後有人加欄位不會記得回來改這裡。zod 的 `isOptional()` 定義就是
 * 「`safeParse(undefined)` 會不會過」,剛好等於我們要的分類:
 *
 *   - optional 或有 default 的欄位 → 空字串視同沒設定,交給 default / undefined 分支
 *   - 必填欄位                     → 空字串仍然紅燈,只是把訊息換成看得懂的「沒填」
 *
 * 只砍「整串 trim 後是空的」的值,而且是整個 key 拿掉,不是改寫成 trim 過的值 ——
 * 有填的值一律原封不動送進 zod。
 */
export interface NormalizedEnvInput {
  /** 可以直接餵給 envSchema.safeParse() 的輸入 */
  values: Record<string, unknown>;
  /** 必填、但值是空字串的 key(要換成「沒填」的錯誤訊息) */
  blankRequired: string[];
}

export function normalizeEnvInput(raw: NodeJS.ProcessEnv): NormalizedEnvInput {
  const values: Record<string, unknown> = { ...raw };
  const blankRequired: string[] = [];

  for (const [key, field] of Object.entries(envSchema.shape)) {
    const value = values[key];
    if (typeof value !== 'string' || value.trim() !== '') continue;
    // 空字串一律從輸入拿掉,差別只在必填的要另外報「沒填」
    delete values[key];
    if (!field.isOptional()) blankRequired.push(key);
  }

  return { values, blankRequired };
}

/** 必填欄位「有這個環境變數、但值是空的」時給 IT 看的訊息 */
const BLANK_REQUIRED_MESSAGE =
  '必填項目沒有填值(環境變數有設,但內容是空字串)。請在 .env 或部署平台的環境變數填入實際的值';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  // 注意:這個值不只管 CORS。它同時是「對外網址」的來源:邀請連結與登入完成後
  //    導回的位址都用 `CORS_ORIGIN.split(',')[0]`。
  //    留在預設值 http://localhost:3000 的後果不是「CORS 比較寬鬆」,而是發出去的
  //    邀請連結都指向 localhost,收件人點不開,而且後端不會有任何錯誤 log。
  //    前後端同網址時,填使用者在瀏覽器實際打的那個網址。
  //    多個 origin 用逗號分隔,第一個會被當成對外網址。
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  // 登入權杖的效期。這是唯一的一把權杖:沒有更新權杖,續期靠滑動續期
  // (效期過半的請求會重簽一份,見 auth/session-refresh.interceptor.ts)。
  // 預設 8 小時 = 一個工作天。業務在現場填一份表、拍幾張照片、等地理編碼回來,
  // 短效期的症狀不是「比較安全」,是「填到一半整頁被清掉」。
  JWT_ACCESS_TTL: z.string().default('8h'),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

  // 選填:沒設就走首次啟動精靈,由第一個進站的人在瀏覽器設定管理員帳密。
  // 功能上它一直是選填的(seed-admin 兩個值都有才建帳號,main.ts 也是),
  // 之前 schema 卻寫成必填,逼得走精靈的部署也得在 .env 填一個用不到的值,
  // 沒填就開機 exit(1)。這裡改回選填,跟功能一致。填了的話仍要求是合法信箱。
  // 空字串也當「沒設」處理(compose 的 ${SEED_ADMIN_EMAIL:-} 展開後就是空字串)。
  SEED_ADMIN_EMAIL: z
    .string()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  // 下限用全系統共用的 PASSWORD_MIN(packages/shared/src/password.ts),不要在這裡另寫數字。
  // 原本這裡寫 8,而 setup/seed-admin.ts 用的是 12:填 8 到 11 個字元的人拿到的是
  // 「env 驗證通過、服務正常起來、啟動 log 裡一行 warn、資料庫裡一個帳號都沒有」。
  // SECURITY.md 教人用這個做法關掉「管理員帳號誰都能認領」的空窗,照做但密碼填 10 碼的人
  // 以為空窗關上了,實際上完全沒關,而且沒有任何失敗訊號。改成開機就 exit(1)。
  SEED_ADMIN_PASSWORD: z
    .string()
    .min(PASSWORD_MIN, `SEED_ADMIN_PASSWORD 至少要 ${PASSWORD_MIN} 個字元`)
    .optional(),

  // === 錯誤記錄(error_logs)===
  // 保留天數。過了就刪掉整列。原本這張表只寫不刪也不合併,一種錯誤被打一萬次
  // 就是一萬列(每列 message 1000 字 + stack 8000 字),而且後台一次撈 100 到 500 列。
  // 預設 30 天:夠久,足以回頭查上個月的事故;夠短,不會讓這張表無限長大。
  ERROR_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // 同一個指紋在多久之內視為「同一件事」,只累加次數不新增列。
  // 預設 1 小時:一次事故的連發會併成一列,隔天再發生就是新的一列,
  // 從時間序上看得出「這件事又來了」。
  ERROR_LOG_DEDUPE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

  // === 稽核記錄(audit_logs)===
  // 保留天數。過了就刪掉整列;0 = 永不刪除。
  //
  // 為什麼預設是 730(兩年)而不是跟錯誤記錄一樣的 30:
  //   稽核記錄與錯誤記錄的用途不同。錯誤記錄是給人「現在」看的,過期的那些沒有人會回頭讀;
  //   稽核記錄的價值全部在事後追查 —— 誰在什麼時候把那批客戶刪掉了、誰把整份名單匯出去了。
  //   而追查通常在事情發生很久之後才開始(人離職了才對帳、稽核每年一次、爭議走到申訴才回頭查)。
  //   設短的後果不是省下磁碟,是「要查的時候證據已經被自己刪掉了」,而那時沒有任何補救辦法。
  //   兩年蓋得住一次完整的年度稽核加上隔年的回頭查,也還在單一 Postgres 撐得住的量
  //   (六十人兩年估三十萬到一百萬列,metadata 是 JsonB,實際大小會比列數估算大好幾倍)。
  //
  // 下限刻意設在 90 天而不是 1 天:這一格是刪除安全性證據的開關,
  // 手滑填個 1 就等於把稽核軌跡清成三天份,而且不會有任何錯誤訊息。
  // 真的要保留更短的組織請自己走資料庫,不要靠這一格。要完全不刪就填 0。
  AUDIT_LOG_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(730)
    .refine((v) => v === 0 || v >= 90, {
      message: 'AUDIT_LOG_RETENTION_DAYS 要嘛是 0(永不刪除),要嘛至少 90 天',
    }),

  // === Rate limiting(@nestjs/throttler)===
  // 時間窗長度(秒)。預設 60,兩組限制共用同一個窗。
  THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  // 一般端點的上限。後台一個頁面就可能連打十幾支 API(列表 + 各種 lookup),
  // 抓太緊會誤傷正常操作,所以預設放寬到每分鐘 100 次。
  THROTTLE_LIMIT_DEFAULT: z.coerce.number().int().min(1).max(100000).default(100),
  // 憑證類端點的上限:/auth/login + 邀請連結。
  // 這兩處是「猜就有機會中」的地方(一次性代碼、密碼),
  // 正常使用者一分鐘不會打超過個位數次,所以預設 10。
  THROTTLE_LIMIT_STRICT: z.coerce.number().int().min(1).max(10000).default(10),
  // Express `trust proxy` 的 hop 數,決定 `req.ip` 取哪一個位址,
  // 也就決定了 rate limit 是「照人算」還是「全世界算成同一個 IP」。
  // 設 0(本機直連)時 req.ip 就是 socket 對端;前面每多一層可信任 proxy 就 +1。詳見 main.ts。
  // 預設 1(fail-closed):本專案的 compose 部署只有 Caddy 一層 proxy。
  // 若預設 2 而部署方忘了設,Express 會多信任一跳,攻擊者可用 X-Forwarded-For
  // 偽造來源 IP 繞過 rate limit、污染稽核 IP。前面多幾層 proxy 的部署自行調高。
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  // session cookie 要不要帶 Secure 旗標。留空 = 依 NODE_ENV 判斷(production 才帶)。
  // 自架環境如果先用 http://localhost 測,Secure cookie 會被瀏覽器丟掉,
  // 表面現象是「登入成功但馬上又被踢回登入頁」,而且 log 上完全正常 ——
  // 所以留一個明確的開關,不要逼人把 NODE_ENV 改成 staging 來繞。
  // 正式上線一定要 https + COOKIE_SECURE=true。
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v == null ? undefined : v === 'true')),

  // session cookie 的 SameSite 屬性。預設 lax,前後端同網域時不必動。
  //
  // 什麼時候要改成 none:**前端與後端在不同網域**(例如 PaaS 上一個服務一個網址,
  // 前端 app.example.com、後端 api.example.com)。那種情況下登入請求是跨站的,
  // lax 的 cookie 瀏覽器根本不會送出去,症狀是「登入回應 200、下一個請求就 401」,
  // 而且後端 log 完全正常 —— 從伺服器這一側看不出任何異常。
  //
  // none 一定要配 Secure(瀏覽器規定),所以設了 none 就要一併 COOKIE_SECURE=true
  // 並且真的走 https。兩者不一致時 useSecureCookies() 會自動補上 Secure,
  // 並在啟動 log 喊一聲(見 cookieSameSiteWarning)。
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // === Microsoft Entra ID(Office 365)單一登入 ===
  // 全部留空 = 功能關閉,登入頁不會出現「用 Microsoft 帳號登入」按鈕,
  // 現有的帳號密碼登入完全不受影響。IT 把四個值填好就會自動啟用。
  // 值從 Entra 系統管理中心 → 應用程式註冊 拿(見 docs/設定說明.md)
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  // 必須跟 Entra 應用程式註冊裡填的「重新導向 URI」一字不差
  // 例 https://apply.example.com/api/auth/entra/callback
  ENTRA_REDIRECT_URI: z.string().url().optional(),
  // 只允許這些網域的帳號登入(逗號分隔)。留空 = 不限制網域,但仍要求
  // 該 email 在 users 表存在。
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  ENTRA_ALLOWED_DOMAINS: z.string().default(''),
  // true = Entra 登入時若 users 表沒這個人,自動開一個 sales 帳號。
  // 預設 false —— 誰能進後台看客戶資料是人決定的,不是 AD 群組決定的。
  //
  // 注意:這裡刻意「不」用 z.coerce.boolean():
  //   z.coerce.boolean() 走的是 JS 的 Boolean(),而 Boolean('false') === true。
  //   也就是說照 docs/設定說明.md 把 ENTRA_AUTO_PROVISION 填成 false 的管理員,
  //   實際上會把自動建帳號「打開」—— 結果是組織目錄裡的任何人都能自己開一個
  //   看得到全部客戶資料的帳號,而且畫面上完全看不出來。
  //   改用明確的字串對照(見 envBoolean),只有 true/1/yes/on 才是 true。
  // 此設定現在可由後台「單一登入設定」覆寫(system_settings id=3),env 只當 bootstrap。
  ENTRA_AUTO_PROVISION: envBoolean(false),
  // 登入完成後導回前端的哪一頁(通常就是後台首頁)
  ENTRA_POST_LOGIN_URL: z.string().url().optional(),

  // === 地理編碼 ===
  // 打公用 Nominatim 端點時要附的聯絡信箱。對方的使用條款要求請求要帶得出
  // 「這是誰在打」,沒帶會被降速或直接擋掉。留空 = 用 placeholder(啟動時會 warn 一次)。
  //
  // 後台「地圖與地理編碼」那一頁的 nominatimEmail 優先;這個變數是它留空時的退路。
  // 這一格原本只寫在 README 與 docs 裡,schema 沒有,所以填錯字(NOMINATIM_MAIL)
  // 不會有任何錯誤,只會安靜地退回 placeholder。列進 schema 之後,
  // 值的格式也一起驗:填了不是 email 的東西會在開機時就講清楚。
  NOMINATIM_EMAIL: z.string().email('NOMINATIM_EMAIL 必須是一個 email 位址').optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  // 先把 .env 補進 process.env 再驗證。順序不能反 —— 這正是自架路線
  // 「DATABASE_URL: Required」的成因(見檔頭說明)。
  loadDotEnvFiles();

  // 先把空字串正規化成「沒設定」,再交給 zod。順序不能反 ——
  // 反過來的話 optional 欄位會先被空字串打死(見 normalizeEnvInput 的說明)。
  const { values, blankRequired } = normalizeEnvInput(process.env);

  const parsed = envSchema.safeParse(values);
  if (!parsed.success) {
    const blank = new Set(blankRequired);
    const issues = parsed.error.issues
      .map((i) => {
        const key = i.path.join('.');
        // 必填欄位被留空時,zod 只會說 `Required`,看不出「我明明有寫這一行」。
        // 換成講清楚是空值的訊息,IT 才知道要回去填而不是去查格式。
        const message = blank.has(key) ? BLANK_REQUIRED_MESSAGE : i.message;
        return `  - ${key}: ${message}`;
      })
      .join('\n');
    console.error(`[Mitch CRM] env validation failed:\n${issues}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export function getEnv(): Env {
  return cached ?? loadEnv();
}

/**
 * Entra ID 設定齊了沒。四個值缺一就當關閉 —— 半套設定比沒設定糟:
 * 按鈕出現在登入頁、按下去卻回 500,使用者只會覺得系統壞了。
 */
/**
 * session cookie 的 Secure 旗標:有設 COOKIE_SECURE 就聽它的,沒設就看 NODE_ENV。
 *
 * SameSite=None 是例外:瀏覽器規定 None 一定要配 Secure,不配的話 cookie 會被直接丟掉。
 * 那個失敗是靜默的(沒有錯誤、只是登不進去),所以這裡直接補上,不等人自己發現。
 */
export function useSecureCookies(): boolean {
  const e = getEnv();
  if (e.COOKIE_SAMESITE === 'none') return true;
  return e.COOKIE_SECURE ?? e.NODE_ENV === 'production';
}

/** session cookie 的 SameSite 屬性。express 的 cookie options 直接吃這個值 */
export function sessionCookieSameSite(): 'lax' | 'strict' | 'none' {
  return getEnv().COOKIE_SAMESITE;
}

/**
 * SameSite 設定與實際部署對不上時的啟動警告;沒問題就回 null。
 *
 * 兩種情況值得喊:
 *   1. SameSite=None 但對外網址是 http —— 瀏覽器會丟掉這個 cookie,永遠登不進去。
 *   2. SameSite=Lax(預設)但對外網址與這台後端不同網域 —— 這一項判斷不出來,
 *      所以只在 1 的情況警告,2 寫在 .env.example 的註解裡。
 */
export function cookieSameSiteWarning(
  env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGIN' | 'COOKIE_SAMESITE'>,
): string | null {
  if (env.NODE_ENV === 'test') return null;
  if (env.COOKIE_SAMESITE !== 'none') return null;
  const first = primaryOrigin(env.CORS_ORIGIN);
  if (first.toLowerCase().startsWith('https://')) return null;
  return (
    `COOKIE_SAMESITE=none 但對外網址 ${first || '(未設定)'} 不是 https。` +
    'SameSite=None 的 cookie 一定要帶 Secure,而 Secure cookie 在 http 上會被瀏覽器丟掉,' +
    '結果是登入回應正常、下一個請求就變成未登入。跨網域部署請把前後端都放到 https 之後再用 none。'
  );
}

/** origin 的 host 是不是指向本機 */
function isLocalOrigin(origin: string): boolean {
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    // 解析不出來就不猜,格式問題交給別的地方報
    return false;
  }
}

/** CORS_ORIGIN 的第一段,也就是拿去組對外連結的那一個 */
function primaryOrigin(corsOrigin: string): string {
  return corsOrigin.split(',')[0]?.trim() ?? '';
}

/**
 * 對外網址還停在本機位址時,回傳一段要寫進啟動 log 的警告;沒問題就回 null。
 * main.ts 在服務起來之後呼叫。
 *
 * 為什麼值得特別喊一聲:CORS_ORIGIN 不只是 CORS 設定,它同時是邀請連結與
 * 登入導回位址的網址前綴。留在預設值 http://localhost:3000 的話,系統會完全
 * 正常地起來,只有發出去的連結都指向發送者自己的電腦,而且後端不會有任何錯誤 log。
 * 這種故障沒有任何自然的偵測點,所以只能在啟動當下主動提醒。
 *
 * ── 為什麼觸發條件不看 NODE_ENV ────────────────────────────────
 * 這一則警告原本的條件是 `NODE_ENV === 'production'`,那是個會自我抵消的設計:
 * 會踩到這個坑的人,正是「沒設 NODE_ENV」的那個人。`docs/安裝與部署.md` 的自架路線
 * 是 `cp apps/backend/.env.example apps/backend/.env` 然後改幾項,
 * 而 `.env.example` 的 NODE_ENV 是 development(那份檔案的主要讀者是開發者),
 * 所以照著做、又忘了改 CORS_ORIGIN 的部署,一則警告都不會有 ——
 * 唯一能救他的那道提醒,被他忘記設的另一個變數關掉了。
 * 拿「使用者可能忘記設的東西」當「提醒他忘了設東西」的開關,等於沒有提醒。
 *
 * 所以現在的條件只看事實本身:**對外網址是不是本機位址**。
 * NODE_ENV 只影響「話怎麼講」,不影響「講不講」:
 *   - development:一句話帶過(本機開發本來就是 localhost,不需要長篇大論)
 *   - 其他:完整說明後果
 * `NODE_ENV=test` 直接回 null —— 測試與 CI 每跑一次就吼一次,只會逼人把它關掉。
 *
 * 代價講清楚:開發者每次啟動會多看到一行 warn。這是刻意付的成本 ——
 * 一行 log 對開發者是小事,對 IT 是「客戶點不開連結」與「完全查不出原因」的差別。
 * 沒有另外做一個關掉警告的開關,因為那個開關會被照著文件貼進正式環境,
 * 那就等於把原本的漏洞原封不動搬回來。
 *
 * 只警告不中止:內網試跑、或是在 production 模式下先用 localhost 驗一輪,
 * 都是合理做法。為了這個把服務擋在門外,只會逼人改用錯誤的 NODE_ENV 來繞過。
 */
export function publicUrlLocalhostWarning(
  env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGIN'>,
): string | null {
  if (env.NODE_ENV === 'test') return null;
  const first = primaryOrigin(env.CORS_ORIGIN);
  if (!isLocalOrigin(first)) return null;

  if (env.NODE_ENV === 'development') {
    return (
      `CORS_ORIGIN 目前是 ${first}(本機開發預設值)。` +
      '這個值同時是系統對外連結的網址來源(例如邀請連結),正式部署請改成對外網址並設 NODE_ENV=production。'
    );
  }

  return (
    `CORS_ORIGIN 目前是 ${first},是本機位址(NODE_ENV=${env.NODE_ENV})。` +
    '這個值同時是系統對外連結的網址來源(例如邀請連結 <CORS_ORIGIN>/invite/<token>),' +
    '維持本機位址的話,對方收到的每一封通知信裡的連結都會指向他自己的電腦而打不開,' +
    '而且後端不會有任何錯誤訊息。請改成使用者在瀏覽器實際打的對外網址。' +
    '(只在內網試跑的話可以忽略這則警告)'
  );
}

/**
 * 對外網址是 https、但 session cookie 不會帶 Secure 旗標時的啟動警告;沒問題就回 null。
 *
 * ── 這則警告擋哪一種錯誤 ────────────────────────────────────────
 * `useSecureCookies()` 是 `COOKIE_SECURE ?? NODE_ENV === 'production'`。
 * `.env.example` 的 `COOKIE_SECURE=` 是空的(空字串會被 normalizeEnvInput 當成沒設),
 * 而自架路線 照著 `.env.example` 走的話 NODE_ENV 也還是 development ——
 * 兩個都沒設的結果是「false」,也就是把服務放到 https 反向代理後面之後,
 * session cookie 照樣不帶 Secure 旗標。
 *
 * 這個失效是完全靜默的:登入正常、操作正常、log 乾淨,
 * 唯一的差別是 cookie 在使用者這一端少了一層保護(降級攻擊 / 混合內容時會被明文送出)。
 * 沒有任何畫面或錯誤訊息會透露這件事,所以只能在啟動當下講。
 *
 * ── 怎麼判斷「現在是 https」────────────────────────────────────
 * 後端自己是 http、TLS 由前面的反向代理終止,所以它看不到 TLS。
 * 但它看得到 CORS_ORIGIN —— 那是「使用者在瀏覽器實際打的網址」,
 * 而使用者的瀏覽器打的是不是 https,正是 Secure 旗標唯一在乎的事。
 * 所以判斷條件是:對外網址是 https,而 useSecureCookies() 會回 false。
 * 反過來(http + Secure cookie)不在這裡處理:那個組合的症狀是
 * 「登入成功卻立刻被踢回登入頁」,看得見、而且 .env.example 與部署文件都寫了。
 */
export function cookieSecureMismatchWarning(
  env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGIN' | 'COOKIE_SECURE'>,
): string | null {
  const secure = env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
  if (secure) return null;
  const first = primaryOrigin(env.CORS_ORIGIN);
  if (!first.toLowerCase().startsWith('https://')) return null;

  const why =
    env.COOKIE_SECURE === undefined
      ? `COOKIE_SECURE 沒有設,就會退回看 NODE_ENV,而目前是 ${env.NODE_ENV}`
      : 'COOKIE_SECURE 被明確設成 false';
  return (
    `對外網址 ${first} 是 https,但 session cookie 不會帶 Secure 旗標(${why})。` +
    '這代表 cookie 在降級成 http 的情況下會被明文送出,而且不會有任何錯誤訊息。' +
    '請設 COOKIE_SECURE=true(或把 NODE_ENV 設成 production)。' +
    '純 http 試跑時才需要 false —— 那種情況請把對外網址也改成 http。'
  );
}

export function isEntraConfigured(): boolean {
  const e = getEnv();
  return Boolean(
    e.ENTRA_TENANT_ID && e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET && e.ENTRA_REDIRECT_URI,
  );
}
