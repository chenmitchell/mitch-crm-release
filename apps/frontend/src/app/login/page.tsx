'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
// ?next= 一律先過 safeNextPath。原本這裡把網址上的字直接丟給 router.push,
// 而 Next 15 的 router 對外部 URL 會走整頁硬導航,等於一個通過驗證的開放重導。
import { safeNextPath } from '@/lib/next-path';

/**
 * Microsoft 登入失敗時的文案。key 是後端放在 ?error= 的列舉碼。
 *
 * 這一份必須涵蓋後端會送出的每一個碼。少一個的後果不是「顯示得比較醜」:
 * 原本這裡缺了 entra_failed,而後端那條路徑會把例外的原始 message 放進 ?reason=,
 * 底下的退路就把它直接畫在登入頁上給**未登入**的人看(資料庫連線錯誤的內部主機名
 * 與埠號就是這樣出去的)。後端已經改成只送列舉碼,這裡補齊對應的文案,
 * 並且拿掉「把網址上的字原樣顯示」那條退路。
 */
const ENTRA_ERROR_TEXT: Record<string, string> = {
  entra_disabled: 'Microsoft 登入尚未啟用,請改用帳號密碼',
  entra_denied: '你在 Microsoft 那一步取消了授權',
  entra_state: '登入流程驗證失敗,請重新按一次登入按鈕',
  entra_expired: '登入流程逾時,請重新登入',
  entra_bad_request: 'Microsoft 回傳的資料不完整,請重試',
  entra_failed: 'Microsoft 登入沒有完成,請再試一次或改用帳號密碼登入',
};

/** 對照表沒有的碼一律用這一句,不把網址上的內容顯示出來 */
const ENTRA_ERROR_FALLBACK = 'Microsoft 登入失敗,請改用密碼登入或聯絡系統管理員';

/**
 * 登入後的預設落點:業務進我的首頁,訪查主管進主管戰情,其餘角色照舊進 /admin。
 * 使用者原本要去的頁面(?next=)優先,這裡只決定「沒有指定要去哪裡」時去哪。
 */
function defaultLanding(role: string | null | undefined): string {
  if (role === 'sales') return '/admin/crm/home';
  if (role === 'sales_manager') return '/admin/crm/stats';
  return '/admin';
}

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  // 只收站內絕對路徑,擋掉 //evil.example 與 https://evil.example
  const nextParam = safeNextPath(params.get('next'));
  const next = nextParam ?? '/admin';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 「請先變更密碼」這一種 403 要多給一個入口:錯誤訊息本身叫人去改密碼,
  // 而這一頁原本沒有任何通往改密碼頁的連結,使用者只能對著同一句話重打帳密。
  const [showChangePasswordLink, setShowChangePasswordLink] = useState(false);
  const [isPending, startTransition] = useTransition();
  // 後端說這台開了哪些登入方式。IT 還沒填 Entra env var 之前,按鈕不會出現
  const [microsoftEnabled, setMicrosoftEnabled] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`${getApiBase()}/api/auth/providers`, { credentials: 'include' });
        if (!r.ok) return;
        const d = (await r.json()) as { microsoft?: boolean };
        setMicrosoftEnabled(Boolean(d.microsoft));
      } catch {
        // 拿不到就當沒開,使用者還是可以用密碼登入
        // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      }
    })();
  }, []);

  // Microsoft 導回來時如果失敗,錯誤碼在 query string 上
  useEffect(() => {
    const code = params.get('error');
    if (!code) return;
    // 只認列舉碼。網址上的任何自由文字都不顯示 —— 那是別人可以自己填的東西,
    // 顯示它等於讓任何人做出一個「看起來是我們系統在說話」的登入頁。
    setError(ENTRA_ERROR_TEXT[code] ?? ENTRA_ERROR_FALLBACK);
  }, [params]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setShowChangePasswordLink(false);
    startTransition(async () => {
      const res = await fetch(`${getApiBase()}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // 後端的 MustChangePasswordGuard 對「臨時密碼還沒換」的人回 403。
        // 登入本身已經在守衛的公開白名單裡,所以正常情況不會走到這裡;
        // 留著是因為部署中的舊版後端仍然會這樣回,而那時候使用者最需要的
        // 就是一個進得去改密碼頁的連結。
        if (res.status === 403) setShowChangePasswordLink(true);
        // 訊息規則走 lib/api-error(只有 4xx 且含中文才原樣顯示),不要在這裡自己解析 body:
        // 自己解析會把 5xx 的框架英文錯誤原樣貼到登入頁上。
        // onUnauthorized: 'credentials':登入頁的 401 是「帳號或密碼錯誤」或
        // 「帳號已暫時鎖定」,不是工作階段過期。走預設的 redirect 會把這兩句話換成
        // 「登入已過期」再整頁重載,使用者只看到畫面閃一下、什麼都沒發生。
        setError(
          await apiErrorMessage(res, '登入失敗,請稍後再試', { onUnauthorized: 'credentials' }),
        );
        return;
      }
      const data = (await res.json()) as { user: { mustChangePassword: boolean; role?: string } };
      const target = nextParam ?? defaultLanding(data.user.role);
      if (data.user.mustChangePassword) {
        router.push(`/account/change-password?next=${encodeURIComponent(target)}`);
        return;
      }
      router.push(target as Parameters<typeof router.push>[0]);
    });
  }

  return (
    <article aria-labelledby="login-title" className="mx-auto max-w-md space-y-6">
      <header className="space-y-2">
        <h1 id="login-title">內部登入</h1>
        <p className="text-muted-foreground">請用公司配發的帳號登入</p>
      </header>

      {/*
        method="post" 不是裝飾。JavaScript 還沒起來(或起不來)的那一段時間,
        瀏覽器對 <form> 的預設行為是 **GET**,而 GET 會把每一個欄位接到網址後面:

          http://localhost:3100/login?email=someone%40example.com&password=...

        密碼因此進了網址列、瀏覽器歷史、以及任何一層看得到 URL 的日誌。
        實測會走到這一步的情境不只是「使用者關掉 JS」:dev server 的 CSP 擋掉
        HMR 的 eval 時,React 一次都沒有 hydrate,onSubmit 根本沒有掛上去
        (那條 CSP 已經修掉,見 next.config.mjs,但退化本身必須自己擋住)。
        改成 POST 之後,同一種退化最多是一次沒有結果的請求,不會外洩任何東西。
      */}
      <form method="post" onSubmit={onSubmit} className="card space-y-4">
        <div className="space-y-1">
          <label htmlFor="email" className="field-label">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="field-label">
            密碼
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </div>

        {error ? (
          // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
          <div role="alert" aria-live="assertive" className="flash flash-error space-y-2">
            <p>{error}</p>
            {showChangePasswordLink ? (
              <p>
                <Link
                  href={`/account/change-password?next=${encodeURIComponent(next)}`}
                  className="underline"
                >
                  前往變更密碼
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}

        <button type="submit" disabled={isPending} className="btn btn-primary min-h-[44px] w-full">
          {isPending ? '登入中...' : '登入'}
        </button>
      </form>

      {microsoftEnabled ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">或</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <a
            href={`${getApiBase()}/api/auth/entra/start?next=${encodeURIComponent(next)}`}
            className="btn min-h-[44px] w-full gap-2 font-semibold"
          >
            <MicrosoftMark />
            用公司 Microsoft 帳號登入
          </a>
          <p className="text-center text-xs text-muted-foreground">
            使用 Office 365 公司帳號。第一次登入前需要由管理員先建立你的帳號
          </p>
        </div>
      ) : null}

      <p className="text-center text-sm">
        <Link href="/" className="text-muted-foreground hover:underline">
          返回首頁
        </Link>
      </p>
    </article>
  );
}

/** Microsoft 四色方格。用 svg 而不是圖檔,免得多一個 public 資產要維護 */
function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="8" height="8" fill="#f25022" />
      <rect x="10" y="0" width="8" height="8" fill="#7fba00" />
      <rect x="0" y="10" width="8" height="8" fill="#00a4ef" />
      <rect x="10" y="10" width="8" height="8" fill="#ffb900" />
    </svg>
  );
}
