'use client';

// 動作完成後的「回到起點」區塊(日報送出、打卡、新增客戶共用)。
// 只做兩件事:講一句「做完了」,給一個主按鈕回我的首頁,外加一個次要按鈕(看這一筆、繼續下一家等)。
// 無障礙:role="status" aria-live 讓螢幕閱讀器聽得到完成訊息、按鈕 ≥44px(.btn 已含)、
// 完成狀態用文字說明不只靠顏色。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import Link from 'next/link';
import type { Route } from 'next';

export interface DonePanelAction {
  label: string;
  href: string;
}

export interface DonePanelProps {
  /** 一句話講完成了什麼,例:「日報已送給主管」 */
  title: string;
  /** 補充說明(可省略) */
  description?: string;
  primary: DonePanelAction;
  secondary?: DonePanelAction;
}

export default function DonePanel({ title, description, primary, secondary }: DonePanelProps) {
  return (
    <section
      role="status"
      aria-live="polite"
      className="mt-4 rounded-lg border-2 border-border-strong bg-surface p-4"
    >
      <p className="text-base font-semibold text-foreground">完成:{title}</p>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <Link href={primary.href as Route} className="btn btn-primary">
          {primary.label}
        </Link>
        {secondary ? (
          <Link href={secondary.href as Route} className="btn">
            {secondary.label}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
