'use client';

// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * RouteAnnouncer — WCAG 2.4.2 Page Titled + 4.1.3 Status Messages
 *
 * ── 擋的是哪一種壞掉 ────────────────────────────────────────────
 * 這套系統只有四頁匯出 metadata,其餘全是 client component,`<title>` 一律吃
 * 根 layout 的預設值。實測結果是每一頁的標題都叫「Mitch CRM」,而 Next 自己的
 * `<next-route-announcer>` 內容永遠是空字串 —— 從看板按 Enter 進秒查客戶,
 * 螢幕閱讀器一個字都不會念,使用者不知道自己換頁了。
 *
 * 這一支做兩件事,而且只做這兩件:
 *   1. 換頁時把 `document.title` 改成這一頁真正的名字(名字來源見 route-titles.ts)
 *   2. 把頁名播進一個 polite 的 live region,讓換頁本身聽得到
 *
 * ── 為什麼不順手搬焦點 ──────────────────────────────────────────
 * 換頁時把焦點強制丟到 `<main>` 會打斷「用鍵盤在側欄上下移動、連按幾頁」的操作,
 * 每按一次就要重新 Tab 回側欄。live region 播報是 WAI 對 SPA 換頁的既定做法,
 * 播報不搶焦點。真正需要把焦點帶進內容的是跳過導覽連結,那一條在 skip-link.tsx。
 *
 * ── 為什麼要先清空再寫 ──────────────────────────────────────────
 * live region 只在「內容有變」時才會念。連續兩次換到同名的頁(例如兩張客戶卡)
 * 文字一樣,不清空就整個第二次不會播。
 */

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { documentTitleForPath, pageTitleForPath } from './route-titles';

/** 清空與重新寫入之間的間隔。太短的話 DOM 兩次變更會被合併成一次,等於沒清空 */
const REANNOUNCE_DELAY_MS = 60;

export function RouteAnnouncer() {
  const pathname = usePathname() ?? '/';
  const [message, setMessage] = useState('');
  // 第一次載入不播:那一次是整頁載入,螢幕閱讀器本來就會念標題,再播一次是重複的
  const mounted = useRef(false);

  useEffect(() => {
    // 對不到的路徑(多半是 404)不動標題,伺服器給的那一份比猜的準
    const title = documentTitleForPath(pathname);
    let stopWatching: (() => void) | undefined;
    if (title !== null) {
      document.title = title;
      /*
       * ★ 只寫一次不夠,別把這段當成多餘的防禦。
       *   實測:整頁載入 /admin/users,這個 effect 設完標題之後,標題又變回
       *   根 layout metadata 的「Mitch CRM」—— hydration 完成時 React 會把
       *   head 裡那個由 metadata render 出來的 <title> 節點重新對上去,
       *   時間點就在 effect 之後。少了下面這段,整頁載入的每一頁標題都還是舊的,
       *   只有 SPA 換頁那一次會對。
       *   盯 document.head 而不是 <title> 節點本身:React 有可能整個節點換掉。
       */
      const observer = new MutationObserver(() => {
        if (document.title !== title) document.title = title;
      });
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
      stopWatching = () => observer.disconnect();
    }

    if (!mounted.current) {
      mounted.current = true;
      return stopWatching;
    }
    const name = pageTitleForPath(pathname);
    if (name === null) return stopWatching;
    setMessage('');
    const t = window.setTimeout(() => setMessage(`已進入 ${name}`), REANNOUNCE_DELAY_MS);
    return () => {
      window.clearTimeout(t);
      stopWatching?.();
    };
  }, [pathname]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
