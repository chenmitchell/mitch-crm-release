'use client';

// 站頭的顯示模式切換:只有一顆按鈕,在淺色、深色、跟隨系統之間循環。
//
// 為什麼只留一顆:
//   配色方案(藍綠／赤陶)與側欄深淺是整間公司統一的外觀,由系統管理員在「系統設定」
//   決定,所有人看到同一套;個別使用者要調的只有白天看還是晚上看。把七顆鈕擺在站頭
//   等於把管理者的設定攤給每個人(包含還沒登入的客戶)去按,那不是使用者要做的決定。
//
// 顯示模式存在瀏覽器本機,不進資料庫 —— 同一個人在辦公室用淺色、在車上用深色是合理的,
// 沒有必要同步到伺服器。
//
// 無障礙:按鈕上同時有文字與目前狀態,不靠顏色表達(1.4.1);aria-label 唸得出完整語意;
// 高度吃 .btn 的 44px。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect, useState } from 'react';
import { applyUserTheme, loadTheme, type ThemeMode } from '@/lib/theme';

/** 循環順序:跟隨系統 → 淺色 → 深色 → 跟隨系統 */
const CYCLE: ThemeMode[] = [null, 'light', 'dark'];

const LABEL: Record<string, { short: string; full: string }> = {
  null: { short: '跟隨系統', full: '目前顯示模式:跟隨系統設定,點擊切換為淺色' },
  light: { short: '淺色', full: '目前顯示模式:淺色,點擊切換為深色' },
  dark: { short: '深色', full: '目前顯示模式:深色,點擊切換為跟隨系統設定' },
};

function keyOf(mode: ThemeMode): string {
  return mode === null ? 'null' : mode;
}

export function ThemeSwitcher() {
  const [mode, setMode] = useState<ThemeMode>(null);
  // 伺服器端算不出使用者存了什麼,先不畫,掛載後再依實際值渲染,避免 hydration 不一致
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setMode(loadTheme().theme);
    setReady(true);
  }, []);

  if (!ready) return null;

  const label = LABEL[keyOf(mode)] ?? LABEL.null!;

  function next() {
    const i = CYCLE.findIndex((m) => m === mode);
    const picked = CYCLE[(i + 1) % CYCLE.length] ?? null;
    setMode(picked);
    applyUserTheme(picked);
  }

  return (
    <button type="button" className="btn text-sm" onClick={next} aria-label={label.full}>
      {label.short}
    </button>
  );
}
