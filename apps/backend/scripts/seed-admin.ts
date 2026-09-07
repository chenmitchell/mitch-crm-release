/**
 * 一次性建立初始 Admin(命令列版)。
 *
 * ── 這支跟首次啟動精靈的關係 ────────────────────────────────────
 * 一般安裝**不需要**跑這支。把系統架起來之後用瀏覽器打開 /setup,
 * 精靈會請你當場輸入管理員信箱與密碼,那條路徑比環境變數安全
 * (環境變數裡的密碼會留在部署平台的設定畫面、部署紀錄與 log 裡)。
 *
 * 這支留給自動化部署與救援用:CI 要跑起一套已經有帳號的環境、
 * 或是唯一的管理員帳號鎖死了要從機器上重建。
 *
 * ── 2026-09 行為變更(重要)──────────────────────────────────────
 * 以前這支在沒有設 SEED_ADMIN_PASSWORD 時會**自己產一組隨機密碼並直接建帳號**,
 * 印在 stdout 讓人去 log 裡抄。docker-compose 的 bootstrap 容器跑的就是這一支,
 * 結果是:照 README 用 Docker 裝好之後,資料庫裡已經有一個 admin,
 * `/api/setup/status` 回 initialized:true,首次啟動精靈**永遠不會出現** ——
 * 而 README 寫的是「系統會帶你走一次首次啟動精靈」。
 * 更糟的是 Zeabur 那條路線沒有 bootstrap 容器,行為跟 Docker 完全不同,
 * 兩條官方安裝路線裝出來的東西不一樣。
 *
 * 現在改成跟 src/setup/seed-admin.ts **同一套邏輯**(直接 import 那一支,不維護兩份):
 *   - 資料庫裡已經有任何使用者 → 什麼都不做
 *   - 沒有使用者,而且 SEED_ADMIN_EMAIL 與 SEED_ADMIN_PASSWORD 兩個都有值 → 建 admin
 *   - 沒有使用者,但沒設密碼 → **不建**,請人去走 /setup 精靈
 * 沒有隨機密碼模式了。「隨機產一組沒人要求的密碼」正是讓精靈消失的那一步。
 *
 * 用法:
 *   SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=... \
 *     pnpm --filter ./apps/backend run seed:admin
 *
 * 跑完建議把 SEED_ADMIN_PASSWORD 從部署平台的環境變數裡刪掉,
 * 帳號會被標記 mustChangePassword,第一次登入就要換掉。
 *
 * idempotent:重複執行不會覆蓋任何既有帳號。
 *
 * 同一階段還會寫入資料庫的署名紀錄(見 ../src/setup/seed-attribution.ts),
 * 那一步獨立於 admin 是否已存在,一樣是 idempotent。
 * 後端啟動時也會寫同一列,所以一般安裝不需要跑這支。
 *
 * ref:3687 mc/陳彥輔/米球®
 */
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/common/env';
import { ensureSeedAdmin } from '../src/setup/seed-admin';
import { seedAttribution, ATTRIBUTION_ROW_ID } from '../src/setup/seed-attribution';

/** ensureSeedAdmin 只用 Logger 的 log / warn 兩個方法,命令列這邊直接印就好 */
const consoleLogger = {
  log: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
} as unknown as Parameters<typeof ensureSeedAdmin>[2];

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = new PrismaClient();
  try {
    // 署名紀錄要在初始化就寫進去,而且不受 admin 是否已存在影響,所以擺在最前面。
    const attribution = await seedAttribution(prisma);
    console.log(
      attribution === 'created'
        ? `[seed-attribution] 已寫入署名紀錄 system_settings#${ATTRIBUTION_ROW_ID}`
        : `[seed-attribution] system_settings#${ATTRIBUTION_ROW_ID} 已存在,略過`,
    );

    const outcome = await ensureSeedAdmin(prisma, env, consoleLogger);
    switch (outcome) {
      case 'created':
        console.log('===================================================');
        console.log(` 系統管理員建立成功:${env.SEED_ADMIN_EMAIL}`);
        console.log(' 密碼 = 你設在 SEED_ADMIN_PASSWORD 環境變數裡的那一組(這裡不重印)。');
        console.log(' 第一次登入會強制改密碼;改完請把 SEED_ADMIN_PASSWORD 從環境變數刪掉。');
        console.log('===================================================');
        break;
      case 'skipped_existing_users':
        console.log('[seed-admin] 資料庫裡已經有使用者,不做任何事(不覆蓋既有帳號)。');
        break;
      case 'skipped_no_password':
        console.log(
          '[seed-admin] 沒有設 SEED_ADMIN_PASSWORD,所以不建立帳號。' +
            '請用瀏覽器打開前端的 /setup 走首次啟動精靈,在那裡當場設定管理員帳號密碼。',
        );
        break;
      case 'failed':
        console.error('[seed-admin] 建立初始管理員沒有成功,請改走 /setup 安裝精靈。');
        process.exitCode = 1;
        break;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-admin] failed:', err);
  process.exit(1);
});
