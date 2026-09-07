/* eslint-disable no-console --
 * 這是容器 entrypoint 直接用 node 執行的 CLI 腳本,不在 Nest 的 DI 容器裡,
 * 拿不到 Logger;它唯一的輸出管道就是 stdout,而那正是部署時看得到的地方。
 * 成功那一行用 console.log(失敗走 console.warn,本來就允許)。範圍只有這一個檔。 */
// ref:3687 mc/陳彥輔/米球®
/**
 * 在 `prisma db push` **之前**跑的那幾步結構調整(容器 entrypoint 呼叫)。
 *
 * ★ 對公開版本(0.1.0 起)的安裝來說,這支永遠是空轉:PRE_DB_PUSH_STEPS 的每一步
 * 都先問 information_schema「資料庫還是舊形狀嗎」,而全新建立的資料庫一開始就是
 * 新形狀,所以一步都不會實際動作。留著是為了讓作者自己那套 0.1.0 之前的內部舊部署
 * 升得上來 —— 公開版本沒有任何一個 tag 有過那些 enum 型別或舊欄位名。
 * 維護這個 repo 的人不需要為下面描述的升級情境做任何事。
 *
 * ── 為什麼需要這支 ────────────────────────────────────────────────
 * 容器的啟動順序是:
 *   deploy/backend-entrypoint.sh → prisma db push → node dist/main.js → runStartupMigrations()
 *
 * db push 跑在 Node 之前。對「還在用舊結構」的資料庫來說,db push 這一步要做的是
 * 「enum 欄位改成 varchar」與「丟掉一個有資料的欄位」,兩者 Postgres 都不會自己來:
 * enum → varchar 需要顯式的 `USING`,而 db push 在非互動模式不會加。
 * 結果是整包 push 失敗,entrypoint 只記一行警告就繼續。
 *
 * 那一輪的後果不只是「這兩個欄位沒轉」:**任何只寫在 schema.prisma、
 * 沒有另外寫進 startup-migrations 的結構變更,在那一輪全部不會生效**,
 * 要等 Node 這邊把欄位修好、下一次重啟 db push 才會成功。
 * 也就是說升級的第一輪行為是靠運氣的 —— 剛好那一版沒有別的 schema 變更才沒事。
 *
 * 這支把那幾步提到 db push 之前執行,讓 db push 第一次就成功。
 *
 * ── 邊界 ──────────────────────────────────────────────────────────
 * 1. 只跑 PRE_DB_PUSH_STEPS,不跑整組 startup migrations。其餘步驟依賴的資料表
 *    可能還沒被 db push 建出來,提前跑只會製造一堆看起來很嚇人的失敗訊息。
 * 2. 每一步都用 information_schema 判斷「還是舊形狀才做」,重跑是 no-op。
 * 3. 失敗不中斷啟動:結束碼永遠是 0。這一步失敗時,後面的 db push 與
 *    startup-migrations 仍然會各自嘗試一次,行為退回到修這件事之前的樣子,
 *    不會比原本更糟。把服務停在這裡才是更糟的選項。
 * 4. 不記錄 SQL 內文與資料庫回傳的細節,只記步驟名與錯誤型別。
 */
import { PrismaClient } from '@prisma/client';
import { loadDotEnvFiles } from '../common/env';
import { PRE_DB_PUSH_STEPS } from './startup-migrations';

async function main(): Promise<void> {
  // 容器裡 DATABASE_URL 是 compose 直接注進 process.env 的,所以少了這一行也看不出問題;
  // 但本機手動跑這支救援時,DATABASE_URL 通常只寫在 .env,PrismaClient 就會拿不到值。
  // 而這支的結束碼永遠是 0(第 3 點),於是它會安靜地什麼都沒做就成功結束 ——
  // 人以為結構已經調好了。這裡只讀 .env 併進 process.env,不做 schema 驗證:
  // 這支只需要 DATABASE_URL,不該因為別的變數沒填就拒跑。
  loadDotEnvFiles();
  const prisma = new PrismaClient();
  let applied = 0;
  const failed: string[] = [];
  try {
    for (const step of PRE_DB_PUSH_STEPS) {
      try {
        await prisma.$executeRawUnsafe(step.sql);
        applied += 1;
      } catch (err) {
        const kind = err instanceof Error ? err.name : 'UnknownError';
        failed.push(`${step.name}(${kind})`);
      }
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  if (failed.length === 0) {
    console.log(`[pre-push-migrations] ${applied} 個步驟就緒(舊結構才會實際動作)`);
  } else {
    console.warn(
      `[pre-push-migrations] 有 ${failed.length} 個步驟未完成:${failed.join('、')}。` +
        '接下來的 prisma db push 可能會失敗,啟動後的 startup-migrations 會再試一次。',
    );
  }
}

main()
  .catch((err) => {
    const kind = err instanceof Error ? err.name : 'UnknownError';
    console.warn(`[pre-push-migrations] 連不上資料庫或執行失敗(${kind}),略過這一步`);
  })
  // 這一步永遠不擋啟動
  .finally(() => process.exit(0));
