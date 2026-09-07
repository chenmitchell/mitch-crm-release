// ref:3687 mc/陳彥輔/米球®
'use client';

// 未初始化時把人送去 /setup。
//
// 這一支不畫任何東西,只做一件事:問一次 GET /api/setup/status,
// 如果後端明確說「還沒裝」,就把目前這一頁換成 /setup。
//
// 三個刻意的取捨:
//   1. 只有後端明確回 initialized=false 才轉。問不到(離線、後端沒起來)不轉 ——
//      服務中斷時把所有人導到一個可以設定系統的頁面,比看到錯誤畫面糟糕得多。
//   2. 已經在 /setup 上就不再轉,免得自己轉自己。
//   3. 用 replace 不用 push:安裝精靈不該出現在上一頁的歷史裡。

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { fetchSetupStatus } from '@/lib/setup';

export function SetupGate() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  useEffect(() => {
    if (pathname === '/setup' || pathname.startsWith('/setup/')) return;
    const ac = new AbortController();
    void (async () => {
      const status = await fetchSetupStatus(ac.signal);
      if (ac.signal.aborted) return;
      if (status && status.initialized === false) router.replace('/setup');
    })();
    return () => ac.abort();
  }, [pathname, router]);

  return null;
}
