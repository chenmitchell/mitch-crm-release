'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBase } from '@/lib/env';
import { roleLabel, type UserRole } from '@/lib/roles';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
import { useLogoText } from '@/lib/app-settings';
import { useMe } from '@/lib/me-context';
import { listPending, ownerKeyOf, removeOwnerPending } from '@/lib/offline-queue';

interface MeInfo {
  email: string;
  name?: string;
  role: UserRole;
  mustChangePassword?: boolean;
}

export function SiteHeader() {
  // 商標文字讀後台設定(產品名或另外指定的字),不寫死任何公司名
  const logoText = useLogoText();
  // 「你是誰」不自己打 /api/auth/me:整站共用 root layout 的 MeProvider(見 lib/me-context)。
  // 哪些路徑算公開頁面(不必問)也搬進那一支,不再由這裡自己維護一份前綴清單 ——
  // 兩份清單走散時的症狀是站頭覺得這頁不用問、浮水印覺得要問,同一頁上多打一次。
  const { me: rawMe, loaded, refresh } = useMe();
  const me: MeInfo | null = useMemo(
    () =>
      rawMe
        ? {
            email: rawMe.email,
            name: rawMe.name,
            role: rawMe.role as UserRole,
            mustChangePassword: rawMe.mustChangePassword,
          }
        : null,
    [rawMe],
  );
  const [loggingOut, setLoggingOut] = useState(false);
  /**
   * 登出前的待清點:這台裝置上還有幾筆這個人的待送出。
   *
   * 為什麼要在登出這一刻問:待送出裡有存證照片的 base64、GPS 座標、客戶名稱與備註,
   * 而且照設計會在 IndexedDB 裡活最多 7 天(活不下來就重送不掉)。共用平板上
   * 換人登入之後,前一個人的東西還在那台裝置上,開開發者工具就看得到。
   * 但也不能自動清掉:那些照片是他站在現場拍的,補不回來,要不要丟由他決定。
   */
  const [pendingAsk, setPendingAsk] = useState<{ count: number; ownerKey: string } | null>(null);
  const router = useRouter();

  // 有登入者被載入 = 新的 session 狀態,登出鈕必須回到「登出」預設。
  // 修「登出→不重新整理→再登入」時登出鈕卡在「登出中...」的 bug:
  // SiteHeader 掛在 root layout 永不 unmount,loggingOut 過去沒有任何一處歸零。
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  useEffect(() => {
    if (me) {
      setLoggingOut(false);
      setPendingAsk(null);
    }
  }, [me]);

  /** 真的登出。clearQueue 為真時先把這台裝置上這個人的待送出清掉 */
  async function doLogout(ownerKey: string, clearQueue: boolean) {
    setPendingAsk(null);
    setLoggingOut(true);
    if (clearQueue && ownerKey) {
      // 清不掉(瀏覽器停用 IndexedDB)也照樣往下登出:卡在這裡等於登不出去
      await removeOwnerPending(ownerKey);
    }
    try {
      await fetch(`${getApiBase()}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // 連不上也視同登出
    }
    // 登出後把共用的登入者狀態重讀一次,浮水印與站頭同時收手
    await refresh();
    router.replace('/login');
    router.refresh();
  }

  /**
   * 按下登出。先看這台裝置上還有沒有這個人的待送出:
   * 有就先問,沒有(或問不出來)就直接登出,不要為了一個提示把登出卡住。
   */
  async function logout() {
    const ownerKey = ownerKeyOf(rawMe);
    if (ownerKey) {
      try {
        const { items } = await listPending(ownerKey, Date.now());
        if (items.length > 0) {
          setPendingAsk({ count: items.length, ownerKey });
          return;
        }
      } catch {
        // 讀不出佇列就當成沒有待送出,照常登出
      }
    }
    await doLogout(ownerKey, false);
  }

  return (
    // 深藍底(同 admin 側欄 --color-sidebar),白字 14.63:1;與灰底頁面、白底卡片形成三層。
    // .site-header 是 globals.css 黃色 focus ring 的掛點(只有深藍底才需要黃框,不能用裸 header 選擇器)。
    <header className="site-header border-b border-sidebar-deep bg-sidebar text-sidebar-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
        <Link
          href={me ? '/admin' : '/'}
          className="inline-flex items-center gap-2 text-lg font-bold text-sidebar-foreground no-underline"
          aria-label={`${logoText}首頁`}
        >
          {/* 品牌菱形。畫成 SVG 而不是文字字元 ◆ 是刻意的:它用的是側欄強調色
              (--sidebar-sel-bar,亮橘 #E2661A),那個顏色對深側欄底只有 3.98:1。
              當文字用會直接違反 1.4.6 AAA 的 7:1;當純裝飾圖形用,門檻是 1.4.11 的 3:1,
              3.98:1 過關。
              顏色直接寫在 fill 屬性上、不透過 text-* utility,是因為 text-* 會產生一條
              `color:` 宣告,而 P13 有一條規則專門擋「強調色出現在任何 color: 裡」。 */}
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 12 12"
            className="h-3 w-3 shrink-0"
          >
            <path d="M6 0 12 6 6 12 0 6Z" fill="var(--sidebar-sel-bar)" />
          </svg>
          <span>{logoText}</span>
        </Link>
        <nav aria-label="主選單">
          <ul className="flex flex-wrap items-center gap-1 sm:gap-2">
            {me ? (
              <>
                {/* 顯示模式只給登入後的操作者;配色方案統一由系統管理員在系統設定決定 */}
                <li className="inline-flex items-center">
                  <ThemeSwitcher />
                </li>
                <li className="hidden md:inline-flex items-center pr-2 text-sm text-sidebar-foreground">
                  {me.name ?? me.email}
                  <span className="ml-2 inline-flex rounded-full bg-white/15 px-2 py-0.5 text-xs text-sidebar-foreground">
                    {roleLabel(me.role)}
                  </span>
                </li>
                <li>
                  <Link
                    href="/admin"
                    className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground no-underline hover:bg-sidebar-hover"
                  >
                    後台
                  </Link>
                </li>
                {me.role === 'admin' ? (
                  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
                  <li>
                    <Link
                      href="/admin/users"
                      className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground no-underline hover:bg-sidebar-hover"
                    >
                      使用者管理
                    </Link>
                  </li>
                ) : null}
                <li>
                  <Link
                    href="/account/change-password"
                    className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground no-underline hover:bg-sidebar-hover"
                  >
                    改密碼
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => void logout()}
                    disabled={loggingOut}
                    className="inline-flex items-center rounded-md border border-sidebar-foreground/40 px-3 py-2 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-hover disabled:opacity-50"
                  >
                    {loggingOut ? '登出中...' : '登出'}
                  </button>
                </li>
              </>
            ) : loaded ? (
              <li>
                <Link href="/login" className="btn btn-sm">
                  登入
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
      </div>
      {/*
        登出前的待送出提示。放在站頭底下的整條橫幅而不是 window.confirm:
        confirm 沒辦法排版、螢幕閱讀器體驗差,而且這裡要講的是三句話。
        role="alertdialog" 讓輔助技術知道這是一個要人做決定的東西。
      */}
      {pendingAsk ? (
        <div
          role="alertdialog"
          aria-labelledby="logout-queue-title"
          aria-describedby="logout-queue-desc"
          className="border-t border-sidebar-deep bg-surface px-4 py-3 text-foreground"
        >
          <div className="mx-auto w-full max-w-6xl">
            <p id="logout-queue-title" className="font-medium">
              這台裝置上還有 {pendingAsk.count} 筆你的待送出,要現在清掉嗎?
            </p>
            <p id="logout-queue-desc" className="mt-1 text-sm text-muted-foreground">
              待送出裡有存證照片、座標與客戶資料,存在這台裝置上最多七天,登出之後仍然留著
              (留著才重送得掉)。這台是共用裝置的話,建議現在清掉。清掉之後那些照片就沒有了,
              而且補不回來。想留著下次登入再送,就選「保留」。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-danger"
                disabled={loggingOut}
                onClick={() => void doLogout(pendingAsk.ownerKey, true)}
              >
                清掉並登出
              </button>
              <button
                type="button"
                className="btn"
                disabled={loggingOut}
                onClick={() => void doLogout(pendingAsk.ownerKey, false)}
              >
                保留,直接登出
              </button>
              <button
                type="button"
                className="btn"
                disabled={loggingOut}
                onClick={() => setPendingAsk(null)}
              >
                取消,先回去送出
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
