'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * AbbrKeyboardFocus — WCAG 3.1.3 AAA(專有名詞的白話解釋)鍵盤可及性補強
 *
 * ── 為什麼需要它 ────────────────────────────────────────────────
 * `<abbr title>` 預設**不可聚焦**,所以純鍵盤使用者永遠 Tab 不到它;
 * 而且瀏覽器原生的 title tooltip 只吃滑鼠 hover,就算加了 tabindex 也不會
 * 因為鍵盤焦點而出現。兩件事要一起處理才算真的做到:
 *   1. 可聚焦 —— 這支元件在每次路由變更後補上 `tabindex="0"`
 *   2. 聚焦時看得到 —— globals.css 的 `abbr[title]:focus-visible::after`
 *      用 `content: attr(title)` 自己畫一個 tooltip
 *
 * ── 為什麼是 runtime 而不是每個 call site 自己寫 ────────────────
 * 寫在 JSX 裡當然更好(不吃 JS),而且新的頁面應該直接寫 `tabIndex={0}`。
 * 但這裡另外掛一層 runtime 補強,是因為「有人新增了一個 abbr 卻忘了加 tabIndex」
 * 這件事沒有任何關卡擋得住,而漏掉的後果是靜默的:畫面完全正常,
 * 只有拔掉滑鼠的人才會發現拿不到解釋。
 * 已經在 JSX 明寫 tabIndex 的元素不會被動到(選擇器帶 `:not([tabindex])`)。
 *
 * ── 副作用:Tab 順序 ────────────────────────────────────────────
 * 每一個 abbr 會變成一個 tab 停留點,位置就在它所在的那段文字裡(DOM 順序),
 * 不會插隊到別的地方,也不影響既有連結與按鈕的相對順序。
 *
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
export function AbbrKeyboardFocus() {
  const pathname = usePathname();

  useEffect(() => {
    const list = document.querySelectorAll<HTMLElement>('abbr[title]:not([tabindex])');
    for (const el of Array.from(list)) {
      el.setAttribute('tabindex', '0');
    }
  }, [pathname]);

  return null;
}
