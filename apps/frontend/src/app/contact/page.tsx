// ref:3687 mc/陳彥輔/米球®
import Link from 'next/link';
import { CompanyInfo } from './company-info';

export const metadata = {
  title: '聯絡管道',
  description: '登入問題、帳號申請與系統聯絡資料',
};

/**
 * 聯絡頁
 *
 * ── 為什麼這一頁不寫死組織名、地址與電話 ────────────────────────
 * 這三個值在後台是可設定的,而且系統其他地方也讀同一份設定。
 * 頁面寫死一份的話,管理員換辦公室改了設定,別的地方是新地址、這裡是舊地址,
 * 而沒有人會發現。所以一律由 <CompanyInfo /> 打 GET /api/public/settings 即時取得,
 * 讀不到就明說讀不到,不塞替代值 —— 一個可能是錯的地址比沒有地址危險。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
export default function ContactPage() {
  return (
    <article aria-labelledby="contact-title" className="space-y-8">
      <header className="space-y-3">
        <h1 id="contact-title" className="page-h1">
          聯絡管道
        </h1>
        <p className="text-muted-foreground">
          帳號、權限與資料相關的問題,找貴單位的系統管理員最快。
        </p>
      </header>

      <section aria-labelledby="contact-where" className="card space-y-3">
        <h2 id="contact-where" className="page-h2">
          常見情況怎麼處理
        </h2>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="font-semibold">登入不了</span>
            :密碼連續錯誤會暫時鎖住,等一段時間再試;帳號被停用要請管理者重新啟用
          </li>
          <li>
            <span className="font-semibold">沒有帳號</span>
            :請主管或管理者在使用者管理建立,或用邀請連結加入
          </li>
          <li>
            <span className="font-semibold">看不到某些頁面</span>
            :選單是依角色顯示的,需要的權限請跟管理者說明用途
          </li>
          <li>
            <span className="font-semibold">資料看起來不對</span>
            :先確認自己看的是不是別人負責的客戶。客戶資料的異動會寫在該筆客戶的時間軸上,
            打開客戶卡就看得到誰在什麼時候改了什麼;時間軸上找不到答案時再請管理者協助
          </li>
        </ul>
      </section>

      <CompanyInfo />

      <section aria-labelledby="contact-more" className="space-y-3">
        <h2 id="contact-more" className="page-h2">
          其他
        </h2>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/" className="btn btn-primary min-h-[44px] px-5">
            回首頁
          </Link>
          <Link href="/privacy" className="btn min-h-[44px] px-5">
            隱私權政策
          </Link>
          <Link href="/accessibility" className="btn min-h-[44px] px-5">
            無障礙聲明
          </Link>
        </div>
        <p className="pt-2 text-xs text-muted-foreground">
          已經有帳號?{' '}
          <Link href="/login" className="underline">
            前往登入
          </Link>
        </p>
      </section>
    </article>
  );
}
