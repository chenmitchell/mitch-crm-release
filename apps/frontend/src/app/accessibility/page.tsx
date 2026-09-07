import Link from 'next/link';

export const metadata = {
  title: '無障礙聲明',
  description: '本系統的無障礙聲明:以 WCAG 2.1 AAA 為目標持續改善,讓所有使用者都能順利完成工作',
};

/**
 * 無障礙聲明
 *
 * 正式聲明,語氣簡潔專業。只陳述承諾與符合性目標,
 * 以及使用者遇到障礙時的聯絡方式,不描述系統內部的實作或檢測細節。
 */
export default function AccessibilityPage() {
  return (
    <article aria-labelledby="a11y-title" className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-3">
        <p className="text-sm font-semibold text-muted-foreground">WCAG 2.1 Level AAA 設計目標</p>
        <h1 id="a11y-title" className="page-h1">
          無障礙聲明
        </h1>
        <p className="text-muted-foreground">
          每一位使用者,包括身心障礙者與使用輔助科技的使用者,都應該能順利使用這套系統完成自己的工作
        </p>
      </header>

      <section aria-labelledby="a11y-commit" className="space-y-3">
        <h2 id="a11y-commit" className="page-h2">
          {/* ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE */}
          一、我們的承諾
        </h2>
        <p>本系統以網頁內容可及性指引 WCAG 2.1 的最高等級 AAA 作為設計目標,持續檢視與改善</p>
        <p>
          目前尚未達到 AAA 的完整符合性。已知未達成與尚未驗證的條款,在專案的無障礙文件中逐條列出,
          不以「已符合 AAA」對外表述
        </p>
      </section>

      <section aria-labelledby="a11y-conformance" className="space-y-3">
        <h2 id="a11y-conformance" className="page-h2">
          {/* ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE */}
          二、符合性
        </h2>
        <p>
          本網站在設計與開發時,注重文字與背景之間清楚的對比、完整的鍵盤操作、
          明顯可辨的焦點樣式,以及足夠大的點選範圍,並會尊重您在裝置上設定的減少動態效果偏好
        </p>
        {/*
          原本這裡還寫了「填寫到一半的內容會自動保留」。全前端沒有任何草稿保存,
          那是一句不實的無障礙聲明,已經刪掉。要寫回去請先真的做出草稿保存。
        */}
        <p>表單的每個欄位都有清楚的標籤與說明,錯誤訊息以淺白的文字說明如何修正</p>
      </section>

      <section aria-labelledby="a11y-contact" className="space-y-3">
        <h2 id="a11y-contact" className="page-h2">
          三、聯絡我們
        </h2>
        <p>
          如果您在使用本服務時遇到任何無障礙方面的困難,歡迎透過業務聯絡頁與我們聯繫,
          我們會盡快協助您完成手上的工作
        </p>
        {/*
          這一行以版本為準,不是隨手寫的月份:寫成「某年某月」的話,改了頁面沒改日期
          就是一句不實的聲明,而且沒有任何檢查會發現。改版時跟著 CHANGELOG 的版本走。
        */}
        <p className="page-subtle">最後更新:0.1.0(2026 年 9 月)</p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/contact" className="btn btn-primary min-h-[44px] px-5">
            業務聯絡方式
          </Link>
          <Link href="/privacy" className="btn min-h-[44px] px-5">
            隱私權政策
          </Link>
        </div>
      </section>
    </article>
  );
}
