#!/usr/bin/env node
/**
 * add-attribution-header.mjs
 *
 * 在 apps/<pkg>/src 與 packages/<pkg>/src 底下的 .ts / .tsx 原始碼檔,
 * 於固定行號插入一行低調的作者署名註解。
 *
 * 為什麼是這個形式:
 * - 作者要的是「不明顯」。檔首五行 JSDoc 橫幅太顯眼,而且是第一個被刪的東西。
 *   改成單行行末註解、每個檔都落在同一組行號,遠看就是一般的內部標記。
 * - 署名文字所有檔案完全一致(縮排會對齊插入點所在的區塊,讓它看起來像原本
 *   就寫在那裡的註解;文字本身逐字元相同)。
 *
 * 落點規則(行號以最終檔案的 1-based 行號計算):
 * - 內容行數 >= 87 :第 36 行與第 87 行各插一行
 * - 36 <= 行數 < 87:只插第 36 行
 * - 行數 < 36       :插在檔案最後一個非空行之前
 *   (36 / 87 來自 3687 這組數字;短檔規則為本腳本自訂的預設)
 *
 * 安全性:插入不得改變程式語意。
 * 用 TypeScript 編譯器 API 解析每個檔,標出「插進去會改變語意」的區間:
 * 字串常值、樣板字面值、正則字面值、多行註解區塊、JSX 內文與 JSX 標籤內部。
 * 目標行若落在這些區間裡,就往下找最近的安全行(找不到才往上找);
 * 這種檔案會列在報告的「落點偏移」清單裡。
 * 插入後會重新解析一次驗證:語法錯誤數不得增加,且署名行不得落進不安全區間,
 * 任一條不過就放棄該檔並列入報告。
 *
 * idempotent 的做法:
 * 每次都先把檔案還原成「沒有任何署名」的基準狀態(移除舊的檔首橫幅、移除既有的
 * 署名單行),再重新計算落點。同一個輸入永遠得到同一個輸出,所以重跑不會疊加,
 * 而且行數變動後落點會自動修正。
 *
 * 用法:
 *   node scripts/add-attribution-header.mjs --dry-run
 *   node scripts/add-attribution-header.mjs
 *   node scripts/add-attribution-header.mjs --verbose
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let ts;
try {
  ts = require('typescript');
} catch {
  console.error('找不到 typescript。請先在專案根目錄執行 pnpm install。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 署名文字(單一來源,要改文字只改這裡)
// ---------------------------------------------------------------------------

/**
 * 署名單行。刻意寫成內部參照標記的樣子:
 * ref:3687 是作者選定的代號,mc/陳彥輔/米球® 是作者的三種稱呼,
 * 後半句講清楚法律定位 — 署名對應的是姓名表示權,授權範圍見 LICENSE。
 */
const ATTRIBUTION_LINE = '// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE';

/** 舊版檔首橫幅的辨識字串(要被移除的那一種) */
const LEGACY_MARKER = 'aka 米球®';

/** 目標行號(1-based) */
const PRIMARY_LINE = 36;
const SECONDARY_LINE = 87;

/** 掃描根目錄 */
const SCAN_ROOTS = ['apps', 'packages'];

/** 處理的副檔名 */
const EXTENSIONS = ['.ts', '.tsx'];

/**
 * 排除規則。
 * 不排除任何業務程式碼,只排除測試檔:測試檔常有大段字串斷言與 inline fixture,
 * 插註解的風險高、可讀性損失也高,而且測試檔不是這套系統對外散布的產出。
 */
const EXCLUDED_SUFFIXES = ['.spec.ts', '.spec.tsx', '.e2e-spec.ts', '.e2e-spec.tsx'];

/** 一律不掃的目錄名稱 */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage']);

// ---------------------------------------------------------------------------
// 檔案收集
// ---------------------------------------------------------------------------

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
    }
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const rootDir = join(ROOT, scanRoot);
    let pkgs;
    try {
      pkgs = readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      if (!pkg.isDirectory() || IGNORED_DIRS.has(pkg.name)) continue;
      const srcDir = join(rootDir, pkg.name, 'src');
      try {
        if (!statSync(srcDir).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(srcDir, files);
    }
  }
  return files.map((f) => relative(ROOT, f).split(sep).join('/')).sort();
}

function isExcluded(relPath) {
  return EXCLUDED_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// 還原成「沒有署名」的基準狀態
// ---------------------------------------------------------------------------

/** 移除舊版檔首 JSDoc 橫幅(含其後的空白行) */
function stripLegacyBanner(lines) {
  const limit = Math.min(lines.length, 60);
  for (let i = 0; i < limit; i += 1) {
    if (!lines[i].trimStart().startsWith('/*')) continue;
    let j = i;
    while (j < lines.length && !lines[j].includes('*/')) j += 1;
    if (j >= lines.length) break;
    const block = lines.slice(i, j + 1).join('\n');
    if (block.includes(LEGACY_MARKER)) {
      let end = j + 1;
      while (end < lines.length && lines[end].trim() === '') end += 1;
      return [...lines.slice(0, i), ...lines.slice(end)];
    }
    i = j;
  }
  return lines;
}

/** 移除既有的署名單行 */
function stripAttributionLines(lines) {
  return lines.filter((line) => line.trim() !== ATTRIBUTION_LINE);
}

// ---------------------------------------------------------------------------
// 安全區間分析
// ---------------------------------------------------------------------------

const UNSAFE_KIND_LABEL = new Map();

function buildKindLabels() {
  const k = ts.SyntaxKind;
  const put = (kind, label) => {
    if (kind !== undefined) UNSAFE_KIND_LABEL.set(kind, label);
  };
  put(k.StringLiteral, '字串常值');
  put(k.NoSubstitutionTemplateLiteral, '樣板字面值');
  put(k.TemplateExpression, '樣板字面值');
  put(k.RegularExpressionLiteral, '正則字面值');
  put(k.JsxText, 'JSX 內文');
  put(k.JsxOpeningElement, 'JSX 標籤內部');
  put(k.JsxSelfClosingElement, 'JSX 標籤內部');
  put(k.JsxClosingElement, 'JSX 標籤內部');
}
buildKindLabels();

/**
 * 解析一份原始碼,回傳:
 *   - unsafe:[start, end, label] 區間陣列(半開區間,嚴格落在內部才算不安全)
 *   - parseErrors:語法錯誤數
 */
function analyze(text, relPath) {
  const isTsx = relPath.endsWith('.tsx');
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const unsafe = [];
  const seenTrivia = new Set();

  const visit = (node) => {
    const label = UNSAFE_KIND_LABEL.get(node.kind);
    if (label) {
      // JsxText 一定要用 node.pos。getStart() 會跳過前導空白,遇到「只有換行與縮排」
      // 的 JsxText(例如 `/>` 與 `</div>` 之間那段)會直接跳到節點結尾,
      // 整個區間縮成空的,結果就是把 JSX 內文誤判成安全,註解插進去會變成畫面上的文字。
      const start = node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(sf);
      unsafe.push([start, node.getEnd(), label]);
    }

    // 註解是 trivia,不是 node,要另外從每個 token 的 leading trivia 取
    const fullStart = node.getFullStart();
    if (!seenTrivia.has(fullStart)) {
      seenTrivia.add(fullStart);
      const ranges = ts.getLeadingCommentRanges(text, fullStart) ?? [];
      for (const r of ranges) unsafe.push([r.pos, r.end, '多行註解區塊']);
    }

    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);

  return { unsafe, parseErrors: (sf.parseDiagnostics ?? []).length };
}

/** 回傳 pos 落在哪個不安全區間的說明;安全則回傳 null */
function unsafeReason(unsafe, pos) {
  for (const [start, end, label] of unsafe) {
    if (pos > start && pos < end) return label;
  }
  return null;
}

/** 計算每一行在原文中的起始 offset */
function lineStartOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// 落點計算
// ---------------------------------------------------------------------------

/**
 * 從 from 開始往下找第一個可以安全插入的行索引;找不到就往上找。
 * 回傳 { index, shifted } — shifted 表示不是原本的目標行。
 */
function findSafeIndex(from, lower, upper, isSafe) {
  const start = Math.max(from, lower);
  for (let i = start; i <= upper; i += 1) {
    if (isSafe(i)) return { index: i, shifted: i !== from };
  }
  for (let i = Math.min(from, upper) - 1; i >= lower; i -= 1) {
    if (isSafe(i)) return { index: i, shifted: true };
  }
  return null;
}

/**
 * 決定署名行的縮排。目的是讓它看起來就是原本寫在那裡的註解。
 *
 * 預設對齊「插入點的下一行」。但下一行如果是收尾符號(} ) ] </ />),
 * 對齊它會讓註解掉到區塊外層,看起來很突兀,而且跟 prettier 的排版不一致
 * (prettier 會把區塊內最後一則註解排在陳述式的縮排,不是收尾括號的縮排),
 * 這種情況改成對齊上一個非空行。
 */
function indentAt(lines, index) {
  const pick = (i) => {
    const line = lines[i];
    if (line === undefined || line.trim() === '') return null;
    return /^[ \t]*/.exec(line)[0];
  };
  const prevIndent = () => {
    for (let i = index - 1; i >= 0; i -= 1) {
      const v = pick(i);
      if (v !== null) return v;
    }
    return null;
  };

  const here = pick(index);
  if (here !== null) {
    const trimmed = lines[index].trim();
    if (/^([}\])]|<\/|\/>)/.test(trimmed)) {
      const prev = prevIndent();
      if (prev !== null && prev.length > here.length) return prev;
    }
    return here;
  }
  for (let i = index + 1; i < lines.length; i += 1) {
    const v = pick(i);
    if (v !== null) return v;
  }
  return prevIndent() ?? '';
}

/**
 * 計算基準檔要插入的位置。
 * 回傳 [{ baseIndex, target }],target 為 36 / 87 / 'tail'。
 */
function planInsertions(lines, contentLineCount, isSafe) {
  const upper = Math.max(lines.length - 1, 0);
  const plans = [];

  if (contentLineCount < PRIMARY_LINE) {
    // 短檔:插在最後一個非空行之前
    let last = lines.length - 1;
    while (last > 0 && lines[last].trim() === '') last -= 1;
    // 短檔優先往上退(往下就變成插在檔尾之後了)
    let found = null;
    for (let i = last; i >= 0; i -= 1) {
      if (isSafe(i)) {
        found = i;
        break;
      }
    }
    if (found === null) {
      for (let i = last + 1; i <= upper; i += 1) {
        if (isSafe(i)) {
          found = i;
          break;
        }
      }
    }
    if (found === null) return null;
    plans.push({ baseIndex: found, target: 'tail' });
    return plans;
  }

  const first = findSafeIndex(PRIMARY_LINE - 1, 0, upper, isSafe);
  if (first === null) return null;
  plans.push({ baseIndex: first.index, target: PRIMARY_LINE });

  if (contentLineCount >= SECONDARY_LINE) {
    // 第一行署名插入後整體會下移一行,所以基準檔的目標索引是 87 - 1 - 1
    const wanted = Math.max(SECONDARY_LINE - 2, first.index + 1);
    const second = findSafeIndex(wanted, first.index + 1, upper, isSafe);
    if (second !== null) plans.push({ baseIndex: second.index, target: SECONDARY_LINE });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// 單檔處理
// ---------------------------------------------------------------------------

/**
 * 回傳 { next, placements, notes }。
 * next 與原檔相同代表不需異動。placements 為最終 1-based 行號。
 */
function processFile(relPath, source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const notes = [];

  // 1. 還原成基準狀態
  let lines = source.split(/\r?\n/);
  const hadLegacy = lines.length !== (lines = stripLegacyBanner(lines)).length;
  const beforeStrip = lines.length;
  lines = stripAttributionLines(lines);
  const hadMarkers = lines.length !== beforeStrip;
  const base = lines.join(eol);

  // 2. 分析基準檔
  const { unsafe, parseErrors } = analyze(base, relPath);
  const offsets = lineStartOffsets(base);
  const isSafe = (index) => {
    const pos = offsets[index];
    if (pos === undefined) return false;
    return unsafeReason(unsafe, pos) === null;
  };

  const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === '';
  const contentLineCount = endsWithNewline ? lines.length - 1 : lines.length;

  const plans = planInsertions(lines, contentLineCount, isSafe);
  if (plans === null) {
    return {
      next: source,
      placements: [],
      notes: ['整份檔案找不到安全的插入點,已跳過'],
      hadLegacy,
      hadMarkers,
      failed: true,
    };
  }

  // 3. 插入(由後往前,避免索引位移)
  const out = lines.slice();
  const sorted = [...plans].sort((a, b) => b.baseIndex - a.baseIndex);
  for (const plan of sorted) {
    out.splice(plan.baseIndex, 0, indentAt(lines, plan.baseIndex) + ATTRIBUTION_LINE);
  }

  // 4. 計算最終行號 + 記錄偏移原因
  const placements = [];
  const ascending = [...plans].sort((a, b) => a.baseIndex - b.baseIndex);
  ascending.forEach((plan, i) => {
    const finalLine = plan.baseIndex + i + 1; // 1-based
    const entry = { line: finalLine, target: plan.target };
    if (plan.target === 'tail') {
      entry.reason = `檔案僅 ${contentLineCount} 行,套用短檔規則`;
    } else if (finalLine !== plan.target) {
      const wantedIndex = plan.target - 1 - i;
      const reason = unsafeReason(unsafe, offsets[wantedIndex] ?? -1);
      entry.reason = reason
        ? `第 ${plan.target} 行落在${reason}內`
        : `第 ${plan.target} 行不可插入`;
    }
    placements.push(entry);
  });

  const next = out.join(eol);

  // 5. 插入後驗證:語法錯誤不得增加,署名行不得落進不安全區間
  const after = analyze(next, relPath);
  if (after.parseErrors > parseErrors) {
    return {
      next: source,
      placements: [],
      notes: ['插入後語法錯誤數增加,已放棄'],
      hadLegacy,
      hadMarkers,
      failed: true,
    };
  }
  const afterOffsets = lineStartOffsets(next);
  for (const p of placements) {
    const lineText = out[p.line - 1] ?? '';
    if (lineText.trim() !== ATTRIBUTION_LINE) {
      return {
        next: source,
        placements: [],
        notes: ['驗證失敗:署名行不在預期行號'],
        hadLegacy,
        hadMarkers,
        failed: true,
      };
    }
    // 指到署名行 `//` 的起點:落在任何不安全區間內部就代表插壞了
    const pos = afterOffsets[p.line - 1] + lineText.indexOf('//');
    const reason = unsafeReason(after.unsafe, pos);
    if (reason) {
      return {
        next: source,
        placements: [],
        notes: [`驗證失敗:署名行落在${reason}`],
        hadLegacy,
        hadMarkers,
        failed: true,
      };
    }
  }

  return { next, placements, notes, hadLegacy, hadMarkers, failed: false };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法:node scripts/add-attribution-header.mjs [--dry-run] [--verbose]');
    return;
  }

  const all = collectFiles();
  const excluded = [];
  const unchanged = [];
  const changed = [];
  const shifted = [];
  const failures = [];

  for (const relPath of all) {
    if (isExcluded(relPath)) {
      excluded.push(relPath);
      continue;
    }
    const abs = join(ROOT, relPath);
    const source = readFileSync(abs, 'utf8');
    const result = processFile(relPath, source);

    if (result.failed) {
      failures.push({ relPath, notes: result.notes });
      continue;
    }

    const deviated = result.placements.filter((p) => p.reason);
    if (deviated.length > 0) shifted.push({ relPath, placements: result.placements });

    if (result.next === source) {
      unchanged.push(relPath);
      continue;
    }
    changed.push({ relPath, placements: result.placements, hadLegacy: result.hadLegacy });
    if (!dryRun) writeFileSync(abs, result.next, 'utf8');
  }

  console.log(dryRun ? '[dry-run] 不會寫入任何檔案' : '[apply] 已寫入檔案');
  console.log(`掃描到原始碼檔          : ${all.length}`);
  console.log(`排除的測試檔            : ${excluded.length}`);
  console.log(`已是最終狀態(跳過)    : ${unchanged.length}`);
  console.log(`${dryRun ? '將會異動' : '實際異動'}                : ${changed.length}`);
  console.log(`落點不是 ${PRIMARY_LINE}/${SECONDARY_LINE} 的檔案 : ${shifted.length}`);
  console.log(`跳過(找不到安全落點)  : ${failures.length}`);

  if (shifted.length > 0) {
    console.log('\n落點偏移清單:');
    for (const item of shifted) {
      const desc = item.placements
        .map((p) =>
          p.reason ? `第 ${p.line} 行(原訂 ${p.target}:${p.reason})` : `第 ${p.line} 行`,
        )
        .join('、');
      console.log(`  ${item.relPath} — ${desc}`);
    }
  }

  if (failures.length > 0) {
    console.log('\n跳過的檔案:');
    for (const f of failures) console.log(`  ${f.relPath} — ${f.notes.join('; ')}`);
  }

  if (verbose && changed.length > 0) {
    console.log('\n異動檔案:');
    for (const c of changed) {
      const at = c.placements.map((p) => p.line).join(', ');
      console.log(`  ${c.relPath} — 署名於第 ${at} 行${c.hadLegacy ? '(已移除舊橫幅)' : ''}`);
    }
  }
  if (verbose && excluded.length > 0) {
    console.log('\n排除的測試檔:');
    for (const f of excluded) console.log(`  ${f}`);
  }
}

main();
