'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { safeNextPath } from '@/lib/next-path';
// 密碼長度規則全系統一份(見 packages/shared/src/password.ts),
// 不要在這一頁自己寫一個數字:走散的時候不會有任何錯誤訊息。
import { PASSWORD_MAX, PASSWORD_MIN, passwordLengthError } from '@mitchcrm/shared/password';

export default function ChangePasswordPage() {
  const router = useRouter();
  const params = useSearchParams();
  // 跟登入頁同一條規則:?next= 只收站內絕對路徑
  const next = safeNextPath(params.get('next')) ?? '/admin';
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('新密碼與確認密碼不一致');
      return;
    }
    const lengthMsg = passwordLengthError(newPassword);
    if (lengthMsg) {
      setError(`新${lengthMsg}`);
      return;
    }
    startTransition(async () => {
      const res = await fetch(`${getApiBase()}/api/auth/change-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
        // 訊息規則走 lib/api-error,不在這裡自己解析 body。
        // 'credentials':這一頁的 401 是「目前密碼錯誤」。走預設的 redirect 會把人踢回
        // 登入頁,登入後因為 mustChangePassword 又被送回這一頁,永遠看不到原因。
        setError(await apiErrorMessage(res, '修改失敗', { onUnauthorized: 'credentials' }));
        return;
      }
      router.push(next as Parameters<typeof router.push>[0]);
    });
  }

  return (
    <article aria-labelledby="cp-title" className="mx-auto max-w-md space-y-6">
      <header className="space-y-2">
        <h1 id="cp-title">設定新密碼</h1>
        <p className="text-muted-foreground">首次登入請改用你自己的密碼</p>
      </header>

      {/*
        用 Microsoft 帳號登入的人沒有本機密碼:帳號是管理員在後台開的,
        臨時密碼從來沒交到他手上,「目前密碼」這一欄他填不出來。
        沒有這段說明的話,他只會對著表單試到放棄,而畫面不會說出原因。
        這裡刻意寫成靜態說明,不去多要一支「你有沒有本機密碼」的 API:
        判斷條件是伺服器那邊的事,而這一頁需要的只是讓人知道該找誰。
      */}
      <p className="text-sm text-muted-foreground">
        用公司 Microsoft 帳號登入的人不需要本機密碼,也不必改這一頁。
        如果你從來沒有收到過臨時密碼、「目前密碼」填不出來,請直接
        <Link href="/login" className="underline">
          回登入頁
        </Link>
        改用 Microsoft 登入;仍然進不去請聯絡系統管理員重設密碼。
      </p>

      {/* method="post":JS 還沒起來時表單會退化成原生送出,預設是 GET,
          密碼會被接到網址列並寫進瀏覽器歷史。 */}
      <form method="post" onSubmit={onSubmit} className="card space-y-4">
        <div className="space-y-1">
          <label htmlFor="current" className="field-label">
            目前密碼
          </label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new" className="field-label">
            新密碼(至少 {PASSWORD_MIN} 個字元)
          </label>
          <input
            id="new"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="confirm" className="field-label">
            再輸入一次新密碼
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input"
          />
        </div>

        {error ? (
          <p role="alert" aria-live="assertive" className="flash flash-error">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={isPending} className="btn btn-primary min-h-[44px] w-full">
          {isPending ? '更新中...' : '更新密碼'}
        </button>
      </form>
    </article>
  );
}
