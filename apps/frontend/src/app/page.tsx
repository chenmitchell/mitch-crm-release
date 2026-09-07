// ref:3687 mc/陳彥輔/米球®
'use client';

// 首頁。這是一套內部使用的系統,首頁的工作只有兩件:
// 說清楚這是什麼、把人送去登入。不放行銷文案,也不放任何對外的申請入口。

import Link from 'next/link';
import { useAppSettings, useLogoText } from '@/lib/app-settings';

export default function HomePage() {
  const settings = useAppSettings();
  const logo = useLogoText();

  return (
    <article aria-labelledby="home-title" className="space-y-8">
      <header className="space-y-3">
        {settings.organizationDisplayName ? (
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {settings.organizationDisplayName}
          </p>
        ) : null}
        <h1 id="home-title">{logo}</h1>
        <p className="text-lg text-muted-foreground">
          實地訪查型的客戶關係管理系統。客戶看板、到訪打卡與照片存證、
          拜訪地圖與路線、日報與戰情圖表,都在同一個地方。
        </p>
      </header>

      <section
        aria-labelledby="feature-title"
        className="rounded-lg border border-border bg-surface p-6"
      >
        <h2 id="feature-title" className="mb-3">
          這套系統做什麼
        </h2>
        <ul className="ml-5 list-disc space-y-2 text-muted-foreground">
          <li>客戶看板:自訂階段,一眼看出每個客戶走到哪一步</li>
          <li>外勤打卡:到現場用 GPS 打卡,依檢查表拍照存證</li>
          <li>拜訪地圖:把今天要跑的客戶排成路線,直接接手機導航</li>
          <li>日報與戰情:每天寫一份、主管看趨勢,不用另外做報表</li>
          <li>查重合併:同一家公司被兩個人建檔時找得出來、併得回去</li>
        </ul>
      </section>

      <section aria-labelledby="cta-title" className="space-y-3">
        <h2 id="cta-title">開始使用</h2>
        <p className="text-muted-foreground">用公司配發的帳號登入,看得到什麼由角色決定。</p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/login" className="btn btn-primary min-h-[44px] px-5">
            登入
          </Link>
          <Link href="/contact" className="btn min-h-[44px] px-5">
            聯絡管理者
          </Link>
        </div>
      </section>
    </article>
  );
}
