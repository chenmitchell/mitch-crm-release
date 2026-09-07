/**
 * 格式與規範檢查(`pnpm lint`)— backend / packages 的 eslint flat config
 *
 * ── 為什麼有這個檔 ──────────────────────────────────────────────
 * apps/backend 與 packages/shared 的 package.json 都有
 *   "lint": "eslint \"src/**\/*.ts\""
 * 但兩個 workspace 都沒有裝 eslint、也沒有任何 eslint 設定檔,
 * 所以 `pnpm lint`(turbo run lint)在這兩個 workspace 一直是「指令存在、實際上沒跑」。
 * 這就是「檢查是裝飾品」的原型:規則寫了、腳本掛了、沒有任何一行 code 被檢查過。
 *
 * 這個檔把規則本體與 @typescript-eslint/parser 接起來讓它真的能跑。
 *
 * ── 規則本體為什麼寫在這裡 ──────────────────────────────────────
 * 這幾條規則原本住在 `packages/config/eslint/{base,node}.js`,是一個獨立的 workspace
 * 套件。但那個套件的四個 export 只有 `eslint/node` 被這個檔 import 過一次,
 * 兩份 tsconfig preset 沒有任何 tsconfig extends 它,`"main"` 還指到一個不存在的
 * `index.js`,整個套件也沒有任何 script。留著它等於多一層只有一個消費者的間接層,
 * 而那一層的名字(`@mitchcrm/config`)還會讓人以為前後端的 tsconfig 是從它來的。
 * 所以把真的被用到的那一份搬進來,套件整個刪掉。規則一條沒加也沒放寬。
 *
 * eslint 本體與 parser 都從 apps/frontend 那份借用(pnpm workspace 內唯一裝了 eslint 的地方),
 * 用 createRequire 從真實路徑解析,不靠相對路徑碰運氣。
 *
 * ref:3687 mc/陳彥輔/米球®
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '../..');
const anchor = fs.realpathSync(
  path.join(REPO, 'apps/frontend/node_modules/eslint-config-next/package.json'),
);
const req = createRequire(anchor);
const tsParser = req('@typescript-eslint/parser');
const tsPlugin = req('@typescript-eslint/eslint-plugin');

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    // 只註冊 plugin、不啟用它的任何規則。
    // 目的是讓既有原始碼裡的 `eslint-disable-next-line @typescript-eslint/no-var-requires`
    // 這類註解能解析得到規則名(否則 eslint v9 會報 "Definition for rule ... was not found" 的 error)。
    // 這裡不 spread recommended,因為那是「新增規則」,不屬於「讓既有檢查跑起來」這件事。
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // 通用規則(原 packages/config/eslint/base.js)
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  // Node / NestJS 專用:允許 process.exit(原 packages/config/eslint/node.js)
  {
    rules: {
      'no-process-exit': 'off',
    },
  },
  /**
   * scripts/**(八支探針 + 四支掃描器,約 200KB 的 .mjs)。
   *
   * 這一批以前不在任何 lint 或 type-check 的範圍內,只被 prettier 檢查格式 ——
   * 也就是說整個 repo 的守門員自己沒有任何靜態檢查。一個打錯的變數名
   * 在探針裡的後果不是「腳本壞掉」,而是「探針安靜地掃不到東西然後 exit 0」,
   * 而那正是這一整組腳本存在的理由要擋的事。
   *
   * no-undef 是這裡最值錢的一條:打錯的識別字會當場紅燈,不必等到 CI 上
   * 某條路徑剛好走到才炸。相對地 no-console 在這裡關掉 —— 這些是 CLI 工具,
   * 印東西給人看就是它們的工作。
   */
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        performance: 'readonly',
        crypto: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        // .cjs 用得到
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-console': 'off',
      // 探針會把 CSS 的 calc() 之類的算式丟給 Function 求值,那幾處都有
      // eslint-disable 註解說明理由;規則真的開起來,那些註解才有意義
      // (規則沒開時 eslint 會反過來說那些 disable 是孤兒)。
      'no-new-func': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
];
