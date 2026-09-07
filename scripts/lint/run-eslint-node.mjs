// ref:3687 mc/陳彥輔/米球®
/**
 * 格式與規範檢查(`pnpm lint`)— backend / packages 的 eslint 執行器
 *
 * ── 為什麼不是直接寫 "lint": "eslint ..." ────────────────────────
 * apps/backend 與 packages/shared 兩個 workspace 都沒有把 eslint
 * 列進 devDependencies,所以 `pnpm run lint` 裡那個 `eslint` 只能靠 PATH 撿。
 * 撿到什麼完全看機器:
 *   - 某些機器上撿到的是全域安裝的那一份,版本剛好相容,綠燈
 *   - GitHub Actions 的 runner 沒有全域 eslint,`eslint: not found`,紅燈
 *   - 哪天全域換一版不相容的,一樣紅燈,而且看起來像是程式碼壞了
 * 「有時候紅有時候綠、而且原因不在 repo 裡」的關卡等於沒有關卡,
 * 所以這裡把 eslint 本體釘死成 workspace 內唯一那份(apps/frontend 的 devDependency),
 * 與 eslint.node.config.mjs 借 parser 的做法同一套邏輯,不靠 PATH。
 *
 * 用法:node ../../scripts/lint/run-eslint-node.mjs "src/**\/*.ts"
 * (兩個 workspace 都在第二層,相對路徑一致)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '../..');
const CONFIG = path.join(REPO, 'scripts/lint/eslint.node.config.mjs');

// 從 apps/frontend 的真實安裝路徑解析 eslint 本體,而不是相對路徑碰運氣:
// pnpm 會把套件放在 .pnpm 底下再打 symlink,寫死相對路徑遲早會斷。
const anchor = fs.realpathSync(path.join(REPO, 'apps/frontend/node_modules/eslint/package.json'));
const req = createRequire(anchor);
const pkg = req('eslint/package.json');
const bin = path.join(path.dirname(anchor), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.eslint);

if (!fs.existsSync(bin)) {
  console.error(`[lint] 找不到 eslint 執行檔:${bin}`);
  console.error('[lint] 請先在 repo 根目錄跑 pnpm install。');
  process.exit(1);
}

const patterns = process.argv.slice(2);
if (patterns.length === 0) {
  console.error('[lint] 沒有給要檢查的檔案樣式');
  process.exit(1);
}

const res = spawnSync(process.execPath, [bin, '--config', CONFIG, ...patterns], {
  stdio: 'inherit',
  cwd: process.cwd(),
});
process.exit(res.status ?? 1);
