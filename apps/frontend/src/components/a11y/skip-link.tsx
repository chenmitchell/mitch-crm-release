'use client';

/**
 * SkipLink — WCAG 2.4.1 Bypass Blocks
 *
 * 鍵盤第一個 Tab 焦點應該落在這個連結上。
 * 未聚焦時透過 CSS 藏在畫面上方(.skip-link 定義於 globals.css)。
 * 被聚焦後從上方滑入,按 Enter 把焦點移進「這一頁真正的內容」。
 *
 * ── 為什麼不是單純指向 <main> ───────────────────────────────────
 * root layout 的 <main id="main-content"> 是整站共用的外框,而後台的側欄
 * (admin/layout.tsx 的 <aside><nav>)就長在 main 裡面。實測跳過導覽之後,
 * 接下來六個 Tab 全部還在後台選單裡,客戶卡上要再按 15 次才碰得到第一個內容元素 ——
 * 跳過機制在,但它沒有跳過任何東西。
 *
 * 所以後台外框在它的內容容器上掛了 id="page-content"(見 PAGE_CONTENT_ID),
 * 這一支在點下去的當下決定落點:有 page-content 就跳那裡,沒有就退回 main。
 * 用執行期查詢而不是由各頁傳 prop,是因為 root layout 是 server component,
 * 它不知道現在這條路徑底下有沒有側欄。
 */

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/** 頁面主要內容容器的 id。後台外框掛在側欄後面的那一塊上 */
export const PAGE_CONTENT_ID = 'page-content';

interface SkipLinkProps {
  /** 沒有 page-content 時的落點,預設 main-content */
  targetId?: string;
  /** 顯示文字,預設「跳至主要內容」 */
  label?: string;
}

export function SkipLink({ targetId = 'main-content', label = '跳至主要內容' }: SkipLinkProps) {
  const pathname = usePathname();
  // 顯示用的 href。滑鼠中鍵、複製連結、以及不跑 JS 的情況都靠它,
  // 所以要跟 onClick 的落點一致,換頁後重算一次。
  const [href, setHref] = useState(`#${targetId}`);

  useEffect(() => {
    const hasPageContent = document.getElementById(PAGE_CONTENT_ID) !== null;
    setHref(`#${hasPageContent ? PAGE_CONTENT_ID : targetId}`);
  }, [pathname, targetId]);

  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    const el = document.getElementById(PAGE_CONTENT_ID) ?? document.getElementById(targetId);
    if (!el) return; // 兩個都沒有就讓瀏覽器照 href 自己處理
    e.preventDefault();
    // 容器本身不是可聚焦元素,補一個 tabindex="-1" 才收得到焦點
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus();
    el.scrollIntoView();
  }

  return (
    <a href={href} onClick={onClick} className="skip-link">
      {label}
    </a>
  );
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
