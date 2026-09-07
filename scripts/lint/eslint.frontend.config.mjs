/**
 * 格式與規範檢查(`pnpm lint`)— frontend 的 eslint flat config
 *
 * ── 為什麼有這個檔 ──────────────────────────────────────────────
 * repo 的 eslint 是 v9,但設定檔是 apps/frontend/.eslintrc.json(舊 eslintrc 格式)。
 * eslint v9 起預設只讀 eslint.config.js,直接跑 `eslint src` 會是:
 *     ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
 * 也就是「設定檔在、規則寫得很認真、但 lint 根本沒跑過」。
 * (`next lint` 之所以還能動,是它內部自己開了 eslintrc 相容模式;
 *   但 next lint 在 Next.js 16 會被移除,而且它預設 warning 不影響 exit code。)
 *
 * 這個檔用 FlatCompat 把既有的 .eslintrc.json 原封不動接進 flat config,
 * 所以規則的單一事實來源仍然是 apps/frontend/.eslintrc.json —— 這裡不改任何一條規則,
 * 只負責「讓它真的跑起來」。加嚴的部分交給 CI 的 lint 步驟(--max-warnings=0)。
 *
 * 依賴解析:pnpm 的 node_modules 是隔離的,scripts/ci 這個位置看不到 eslint 的外掛,
 * 所以用 createRequire 從 eslint-config-next 的真實路徑往外解,不靠相對路徑碰運氣。
 *
 * ref:3687 mc/陳彥輔/米球®
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '../..');
const FRONTEND = path.join(REPO, 'apps/frontend');

const anchor = fs.realpathSync(path.join(FRONTEND, 'node_modules/eslint-config-next/package.json'));
const req = createRequire(anchor);
const { FlatCompat } = req('@eslint/eslintrc');

const compat = new FlatCompat({
  baseDirectory: FRONTEND,
  resolvePluginsRelativeTo: FRONTEND,
});

const eslintrc = JSON.parse(fs.readFileSync(path.join(FRONTEND, '.eslintrc.json'), 'utf8'));

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
    ],
  },
  ...compat.config(eslintrc),
];
