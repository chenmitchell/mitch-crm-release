// ref:3687 mc/陳彥輔/米球®
'use client';

// /admin 本身沒有內容,只是一個入口:進來就轉到每天真正在用的那一頁。
//
// 為什麼不是留一個「後台首頁」:這套系統的使用者是外勤訪查人員,
// 多一層要再點一下的中繼頁只是浪費他們的時間。主管的落點不同(先看戰情),
// 所以先看一次角色再決定往哪去。角色讀共用的登入者 context(見 lib/me-context),
// 不自己打 /api/auth/me —— 這一頁外面的 admin 外框、站頭與浮水印都已經在問同一件事。
//
// 讀不到角色(沒登入、API 連不上)一律送去 /admin/crm/home:
// 那一頁自己會處理未登入導向,錯不到哪裡去。

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useMe } from '@/lib/me-context';

/** 各角色的預設落點 */
function landingFor(role: string | null | undefined): Route {
  if (role === 'sales_manager') return '/admin/crm/stats' as Route;
  return '/admin/crm/home' as Route;
}

export default function AdminEntryPage() {
  const router = useRouter();
  const { me, status } = useMe();

  useEffect(() => {
    // 還在問就先不轉頁,免得每個人都先被送去一般業務的落點再跳一次
    if (status === 'loading') return;
    if (status === 'unauthorized') {
      window.location.href = '/login?next=/admin';
      return;
    }
    // 連不上時 status 是 'error',用預設落點,那一頁自己會再顯示錯誤
    router.replace(landingFor(me?.role ?? null));
  }, [router, me, status]);

  // 轉頁只有一瞬間,但螢幕閱讀器需要知道現在發生什麼事,不能是一片空白
  return (
    <p role="status" className="text-muted-foreground">
      正在前往首頁…
    </p>
  );
}
