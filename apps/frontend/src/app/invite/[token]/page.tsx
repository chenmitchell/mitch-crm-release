'use client';

// 公開的邀請頁:新業務用主管給的連結自己建帳號(不需登入,不走 admin layout)。
// 流程:先 GET /api/invites/:token 檢查 → 有效就顯示邀請人與表單 → 送出成功顯示完成畫面。
// 後端確定說 valid:false 才顯示「連結已失效」,而且不分原因(過期、用過、不存在)講同一句,
//   後端也是一律回 valid:false(不回 404),避免被拿來探測。
// 「連不上後端」與「被限流」不是「連結壞了」,各自有自己的畫面與下一步 ——
//   把它們一起當成失效的話,新人在收訊差的地方打開連結會被告知連結壞了,
//   主管於是一直重發新的,兩邊都以為系統壞了。作法跟 lib/setup.ts 的
//   fetchSetupStatus 一致:問不到後端就是問不到,不要當成後端給了答案。
// 無障礙:每個欄位有 label、密碼規則寫在表單旁邊、錯誤 role="alert"、按鈕 ≥44px。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { useOrgTimeFormat } from '@/lib/app-settings';
// 密碼長度規則全系統一份(見 packages/shared/src/password.ts)。
// 以前這裡寫 8、安裝精靈寫 12、改密碼寫 8,同一套系統三種規則。
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_RULE_TEXT,
  passwordLengthError,
} from '@mitchcrm/shared/password';

const PASSWORD_RULE = PASSWORD_RULE_TEXT;
const INVALID_TEXT = '連結已失效,請向主管重新索取';
const GENERIC_ERROR = '無法完成註冊,請確認資料或向主管重新索取連結';

type Check =
  | { state: 'loading' }
  | { state: 'invalid' }
  /** 問不到後端(沒網路、後端重啟中、5xx):連結本身還沒被判定過 */
  | { state: 'unreachable' }
  /** 這支端點有每分鐘的次數上限,被擋下來時要講清楚是「太頻繁」不是「壞了」 */
  | { state: 'rateLimited' }
  | { state: 'valid'; inviterName: string; expiresAt: string | null };

export default function InviteAcceptPage() {
  // 時間一律照組織設定的時區顯示,不吃看的人的裝置時區與語系
  const fmtTime = useOrgTimeFormat();
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';
  const [check, setCheck] = useState<Check>({ state: 'loading' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const runCheck = useCallback(async () => {
    if (!token) {
      setCheck({ state: 'invalid' });
      return;
    }
    setCheck({ state: 'loading' });
    try {
      const res = await fetch(`${getApiBase()}/api/invites/${encodeURIComponent(token)}`);
      if (res.status === 429) {
        setCheck({ state: 'rateLimited' });
        return;
      }
      // 5xx 是伺服器自己有狀況,連結沒有被檢查過,不能說它失效
      if (res.status >= 500) {
        setCheck({ state: 'unreachable' });
        return;
      }
      if (!res.ok) {
        setCheck({ state: 'invalid' });
        return;
      }
      const data = (await res.json()) as {
        valid?: boolean;
        inviterName?: string;
        expiresAt?: string;
      };
      // 只有後端明確說 valid:false 才是失效;欄位不是布林值代表回的東西不對,
      // 那也不算「後端給了答案」
      if (typeof data.valid !== 'boolean') {
        setCheck({ state: 'unreachable' });
        return;
      }
      if (!data.valid) {
        setCheck({ state: 'invalid' });
        return;
      }
      setCheck({
        state: 'valid',
        inviterName: data.inviterName ?? '你的主管',
        expiresAt: data.expiresAt ?? null,
      });
    } catch {
      setCheck({ state: 'unreachable' });
    }
  }, [token]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError('兩次輸入的密碼不一樣,請重新確認');
      return;
    }
    if (passwordLengthError(password) !== null) {
      setError(PASSWORD_RULE);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${getApiBase()}/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          mobile: mobile.trim() || undefined,
          password,
        }),
      });
      if (!res.ok) {
        setError(await apiErrorMessage(res, GENERIC_ERROR));
        return;
      }
      setDone(true);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  if (check.state === 'loading') {
    return (
      <article className="mx-auto max-w-md space-y-4">
        <p role="status" aria-live="polite" className="text-muted-foreground">
          連結檢查中...
        </p>
      </article>
    );
  }

  if (check.state === 'unreachable') {
    return (
      <article className="mx-auto max-w-md space-y-4">
        <h1>還沒辦法確認這條連結</h1>
        <p role="alert" className="flash flash-error">
          現在連不上伺服器,還沒辦法確認這條連結。請確認網路後按下面的重試
        </p>
        <p className="text-sm text-muted-foreground">
          連結本身可能還是好的,不用急著跟主管要新的一條。
        </p>
        <button
          type="button"
          onClick={() => void runCheck()}
          className="btn btn-primary min-h-[44px]"
        >
          重試
        </button>
      </article>
    );
  }

  if (check.state === 'rateLimited') {
    return (
      <article className="mx-auto max-w-md space-y-4">
        <h1>請稍等一下再試</h1>
        <p role="alert" className="flash flash-error">
          這條連結在短時間內被開太多次,伺服器暫時擋下來了。等一分鐘再按下面的重試
        </p>
        <p className="text-sm text-muted-foreground">這不代表連結失效,也不用跟主管要新的一條。</p>
        <button
          type="button"
          onClick={() => void runCheck()}
          className="btn btn-primary min-h-[44px]"
        >
          重試
        </button>
      </article>
    );
  }

  if (check.state === 'invalid') {
    return (
      <article className="mx-auto max-w-md space-y-4">
        <h1>邀請連結無法使用</h1>
        <p role="alert" className="flash flash-error">
          {INVALID_TEXT}
        </p>
        <p className="text-sm text-muted-foreground">
          邀請連結有效 30 分鐘,而且只能使用一次。如果已經建立過帳號,請直接登入。
        </p>
        <Link href="/login" className="btn btn-primary min-h-[44px]">
          前往登入
        </Link>
      </article>
    );
  }

  if (done) {
    return (
      <article className="mx-auto max-w-md space-y-4">
        <h1>帳號建立完成</h1>
        <p role="status" aria-live="polite" className="flash flash-success">
          帳號已經建立好了,請用你剛設定的 Email 與密碼登入。
        </p>
        <Link href="/login" className="btn btn-primary min-h-[44px]">
          前往登入
        </Link>
      </article>
    );
  }

  return (
    <article aria-labelledby="invite-title" className="mx-auto max-w-md space-y-6">
      <header className="space-y-2">
        <h1 id="invite-title">{check.inviterName} 邀請你加入</h1>
        <p className="text-muted-foreground">
          填好下面的資料就可以建立訪查人員帳號,建立後請用這組 Email 與密碼登入。
          {check.expiresAt ? ` 這個連結在 ${fmtTime(check.expiresAt)} 前有效。` : ''}
        </p>
      </header>

      {/* method="post":JS 還沒起來時表單會退化成原生送出,預設是 GET,
          密碼會被接到網址列並寫進瀏覽器歷史。 */}
      <form method="post" onSubmit={onSubmit} className="card space-y-4">
        <div className="space-y-1">
          <label htmlFor="invite-name" className="field-label">
            姓名
          </label>
          <input
            id="invite-name"
            type="text"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            className="input"
            autoComplete="name"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="invite-email" className="field-label">
            Email(之後用這個登入)
          </label>
          <input
            id="invite-email"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            className="input"
            autoComplete="username"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="invite-mobile" className="field-label">
            手機(選填)
          </label>
          <input
            id="invite-mobile"
            type="tel"
            maxLength={40}
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            disabled={submitting}
            className="input"
            autoComplete="tel"
            placeholder="0928-000-000"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="invite-password" className="field-label">
            設定密碼
          </label>
          <input
            id="invite-password"
            type="password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            className="input"
            autoComplete="new-password"
            aria-describedby="invite-password-rule"
          />
          <p id="invite-password-rule" className="text-sm text-muted-foreground">
            {PASSWORD_RULE}
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="invite-password2" className="field-label">
            再輸入一次密碼
          </label>
          <input
            id="invite-password2"
            type="password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            disabled={submitting}
            className="input"
            autoComplete="new-password"
          />
        </div>

        {error ? (
          <p role="alert" aria-live="assertive" className="flash flash-error">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting || undefined}
          className="btn btn-primary min-h-[44px] w-full"
        >
          {submitting ? '建立中...' : '建立我的帳號'}
        </button>
      </form>

      <p className="text-center text-sm">
        <Link href="/login" className="text-muted-foreground hover:underline">
          已經有帳號,直接登入
        </Link>
      </p>
    </article>
  );
}
