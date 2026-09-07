'use client';

/**
 * 後台外框:側欄、頁首、以及「這個角色看得到哪幾頁」的導覽過濾。
 *
 * ── 這裡的角色過濾不是權限 ──────────────────────────────────────
 * 側欄藏起來的項目,直接打網址一樣進得去;真正擋住的是後端(每一支 API 都自己
 * 檢查角色與可見範圍)。這裡做的是「不要讓人看到一堆點了會 403 的連結」。
 * 所以新增頁面時,**先在後端把授權做好**,側欄只是跟著補一筆。
 *
 * ── 兩件容易踩到的事 ────────────────────────────────────────────
 * 1. NAV_GROUPS 的 key 會寫進 localStorage(記住哪一群是展開的)。
 *    改掉 key 等於把所有人的展開狀態重設,不要為了改文案順手改 key。
 * 2. 這是 client component,而且是所有後台頁面的共同父層:
 *    在這裡多做一次 fetch,等於每一頁都多一次。要加資料來源前先想清楚。
 */

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { getApiBase } from '@/lib/env';
import { roleLabel, type UserRole } from '@/lib/roles';
import { useAppSettings, type AreaKey } from '@/lib/app-settings';
import { useMe } from '@/lib/me-context';
import { loginHref } from '@/lib/api-error';
/**
 * 側欄清單與頁面名稱是同一份資料,放在 components/a11y/route-titles.ts。
 * 那裡也是換頁時 `document.title` 與播報用的來源 ——
 * 分成兩份的話,改了選單文案標題不會跟著變,兩邊會慢慢對不上。
 */
import { ADMIN_NAV_GROUPS as NAV_GROUPS, pathOf } from '@/components/a11y/route-titles';
import { PAGE_CONTENT_ID } from '@/components/a11y/skip-link';

interface MeInfo {
  email: string;
  name?: string;
  department?: string | null;
  role: UserRole;
}

/** 側欄群組展開狀態的 localStorage 鍵 */
const NAV_OPEN_STORAGE_KEY = 'mitchcrm.admin.nav.openGroups';

/**
 * 依路徑前綴決定功能區。順序有意義:比較長的前綴要放前面。
 * 對不到的路徑(例如 /account/change-password)歸 system。
 *
 * 功能區本身是固定的四區,但每一區用哪一組識別色由後台設定決定
 * (見 lib/app-settings.tsx 的 areaColors;globals.css 依 data-zone 換 --area-accent)。
 */
function areaOf(pathname: string): AreaKey {
  const rules: Array<[string, AreaKey]> = [
    ['/admin/crm/map', 'field'],
    ['/admin/crm/field', 'field'],
    ['/admin/crm/daily-reports', 'field'],
    ['/admin/crm', 'crm'],
    ['/admin/team', 'team'],
    ['/admin/users', 'team'],
    ['/admin/settings', 'system'],
    ['/admin/errors', 'system'],
    ['/account', 'system'],
  ];
  for (const [prefix, area] of rules) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return area;
  }
  return 'crm';
}

/** 這個路徑算不算落在這一項底下(/admin 只認自己,免得整個後台都點亮它) */
function matchesHref(pathname: string, href: string): boolean {
  const base = pathOf(href);
  if (base === '/admin') return pathname === '/admin';
  return pathname === base || pathname.startsWith(`${base}/`);
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/admin';
  // data-area / data-zone 只放在下面這一層外框上;globals.css 沒有任何 main[data-area] 規則,
  // 變數都是往子樹繼承,admin 內容全部在外框裡面,不必再同步到 <main>。
  const area = areaOf(pathname);
  const router = useRouter();
  // 「你是誰」共用 root layout 的 MeProvider(見 lib/me-context),這一層不自己打 API。
  // 收斂之前這裡、站頭、浮水印與底下每一頁各打一次,打開 /admin/crm/map 光是
  // /api/auth/me 就四次。
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  const { me: rawMe, status, loaded } = useMe();
  const me: MeInfo | null = rawMe
    ? {
        email: rawMe.email,
        name: rawMe.name,
        department: rawMe.department,
        role: rawMe.role as UserRole,
      }
    : null;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { areaColors } = useAppSettings();

  // 沒登入(或權杖過期)就導去登入頁,並把現在這一頁帶著回來。
  // 只認 401:連不上後端時是 'error',那時把人踢到登入頁只會讓他登入也失敗,
  // 更看不出真正的原因。
  useEffect(() => {
    if (status !== 'unauthorized') return;
    // 導頁與 next 參數的組法全站一份(見 lib/api-error 的 loginHref):
    // 這裡跟各頁 fetch 收到 401 時走的是同一條路,登入完回得到原來那一頁(含查詢字串)
    window.location.href = loginHref();
  }, [status, pathname]);

  /**
   * 還沒改掉臨時密碼的人一律先送去改密碼頁。
   *
   * ★ 這一段是使用體驗,不是安全機制。真正擋住的是後端那道全域守衛
   *   (apps/backend/src/auth/must-change-password.guard.ts):`mustChangePassword`
   *   為真時,除了白名單那幾支以外一律 403。以前唯一的把關點是登入頁那三行
   *   router.push,把網址列改成 /admin/crm 就過了,而每一支 API 都會正常回應。
   *   現在直接打網址進來的話,底下每一頁的 fetch 都會拿到 403;這個 effect 的作用
   *   只是讓使用者看到「請先改密碼」而不是滿頁錯誤。
   */
  const mustChangePassword = rawMe?.mustChangePassword === true;
  useEffect(() => {
    if (status !== 'ok' || !mustChangePassword) return;
    if (pathname.startsWith('/account/change-password')) return;
    const target = `${pathname}${window.location.search}`;
    window.location.href = `/account/change-password?next=${encodeURIComponent(target)}`;
  }, [status, mustChangePassword, pathname]);

  const logout = useCallback(async () => {
    try {
      await fetch(`${getApiBase()}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      /* ignore */
    }
    router.replace('/login');
    router.refresh();
  }, [router]);

  // 角色過濾後還有項目的群組才顯示
  const visibleGroups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((n) => {
          if (!n.roles) return true; // 未限制 = 所有登入者
          return me?.role != null && n.roles.includes(me.role);
        }),
      })).filter((g) => g.items.length > 0),
    [me?.role],
  );

  /** 目前路徑落在哪一個群組(找不到就 null) */
  const activeGroupKey = useMemo(() => {
    for (const g of NAV_GROUPS) {
      if (g.items.some((n) => matchesHref(pathname, n.href))) return g.key;
    }
    return null;
  }, [pathname]);

  // 展開狀態:預設只展開目前路徑所在的群組,其餘收合;使用者自己開合的結果記在 localStorage。
  // 首次 render(含伺服器端)一律用預設值算,等掛載後才套用 localStorage,避免 hydration 不一致。
  const defaultOpen = useCallback(
    (key: string) => (activeGroupKey === null ? key === 'crm' : key === activeGroupKey),
    [activeGroupKey],
  );
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(NAV_OPEN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const next: Record<string, boolean> = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'boolean') next[k] = v;
          }
          setOpenOverrides(next);
        }
      }
    } catch {
      /* 讀不到(無痕模式、被關掉)就用預設展開狀態,不影響功能 */
    }
  }, []);

  const isGroupOpen = useCallback(
    (key: string) => {
      // 使用者自己按過的以他的選擇為準 —— 包含把目前所在的群組收起來。
      // 之前這裡讓所在群組「永遠展開」,結果那顆標題按了完全沒反應:
      // 看起來可以按、aria-expanded 也在變,實際上狀態被蓋掉,是壞掉的操作回饋。
      const o = openOverrides[key];
      if (typeof o === 'boolean') return o;
      // 沒按過的話,所在群組預設展開,點進來才看得到自己在哪一項
      if (key === activeGroupKey) return true;
      return defaultOpen(key);
    },
    [activeGroupKey, openOverrides, defaultOpen],
  );

  const toggleGroup = useCallback(
    (key: string) => {
      setOpenOverrides((prev) => {
        const now =
          typeof prev[key] === 'boolean'
            ? (prev[key] as boolean)
            : key === activeGroupKey || defaultOpen(key);
        const next = { ...prev, [key]: !now };
        try {
          window.localStorage.setItem(NAV_OPEN_STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* 存不了就只在這次瀏覽有效 */
        }
        return next;
      });
    },
    [defaultOpen, activeGroupKey],
  );

  // 目前高亮的項目:符合當前路徑的「最長 href」,避免 /admin/crm/field/checkin 同時點亮上層項目
  const activeHref = useMemo(() => {
    const all = visibleGroups.flatMap((g) => g.items);
    return all
      .filter((n) => matchesHref(pathname, n.href))
      .reduce<string | null>((best, n) => {
        const base = pathOf(n.href);
        return best && best.length >= base.length ? best : base;
      }, null);
  }, [visibleGroups, pathname]);

  /** 一個群組的內容(桌機側欄與手機抽屜共用,idPrefix 避免兩邊 id 撞在一起) */
  const renderGroups = (idPrefix: string, onNavigate?: () => void) => (
    <ul className="space-y-1">
      {visibleGroups.map((g) => {
        const open = isGroupOpen(g.key);
        const listId = `${idPrefix}-group-${g.key}`;
        return (
          <li key={g.key}>
            <button
              type="button"
              // 群組標題本身是按鈕(展開/收合)。
              //
              // ★ 這裡刻意不照後台介面常見的「眉標」慣例做,不要改回去。
              //   那個慣例會把分組標題壓成 12px/600 的小字(只用來分區),前提是使用者
              //   天天用、已經熟悉介面。這套系統的使用者是外勤訪查人員,一天開幾次、
              //   多半在手機上單手操作,對他們來說第一層就該最明顯 ——
              //   父層比子層小違反直覺,點錯的代價是在客戶門口多花二十秒。
              //   這是本專案的決定,理由如上;要改請先在 issue 上討論。
              //   取值不自創:17px/700 就是字級階層裡「卡片標題」那一階,
              //   項目維持 15px/400(選中 700),兩者差兩階,層級一眼看得出來。
              //
              // 高度:規格寫 32px,但這是可點的切換鈕,命中區仍要 ≥44px(2.5.5 AAA)。
              // 收合狀態除了箭頭方向,aria-expanded 也讓螢幕閱讀器讀得到,不只靠圖形。
              className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-[1.0625rem] font-bold text-sidebar-foreground hover:bg-sidebar-hover"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => toggleGroup(g.key)}
            >
              <span>{g.label}</span>
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
            {/* 項目往內縮一階,視覺上明確從屬於上面的標題 */}
            <ul id={listId} hidden={!open} className="mt-0.5 space-y-0.5 pl-2">
              {g.items.map((n) => {
                const active = pathOf(n.href) === activeHref;
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href as Route}
                      onClick={onNavigate}
                      // 1.4.1 Use of Color:目前所在頁在視覺上是「反白底 + 粗體」,
                      // 顏色不是唯一線索(字重也變了),但螢幕閱讀器原本完全拿不到
                      // 「我在哪一頁」。aria-current 是這個資訊唯一的非視覺出口。
                      aria-current={active ? 'page' : undefined}
                      // 字級不在這裡寫:.admin-nav-link 已經照設計基準的
                      // 側欄項目規格設成 15px(定義在 globals.css)。
                      // 之前這裡掛了 text-sm(14px)把規格值蓋掉,標題與項目才會擠成同一階。
                      className="admin-nav-link"
                    >
                      {n.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      data-area={area}
      data-zone={areaColors[area]}
      className="-mx-4 -my-8 min-h-[calc(100svh-8rem)] bg-background"
    >
      <div className="mx-auto w-full max-w-7xl px-3 py-4">
        <div className="grid gap-4 lg:grid-cols-[13rem_1fr]">
          {/* Sidebar (desktop) */}
          <aside className="hidden lg:block">
            <div className="admin-sidebar sticky top-4">
              <div className="admin-sidebar-head">
                <p className="admin-sidebar-kicker">控制台</p>
                {me ? (
                  <div className="mt-1.5 text-sm font-medium leading-tight">
                    {me.name ?? me.email}
                    <div className="admin-sidebar-role font-normal">{roleLabel(me.role)}</div>
                  </div>
                ) : null}
              </div>
              <nav aria-label="後台選單" className="p-1.5">
                {renderGroups('sidebar')}
              </nav>
              <div className="p-1.5 pt-0">
                <button type="button" onClick={logout} className="admin-sidebar-logout">
                  登出
                </button>
              </div>
            </div>
          </aside>

          {/* Mobile sidebar toggle */}
          <div className="lg:hidden">
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-expanded={sidebarOpen}
              className="btn btn-sm gap-2"
            >
              <svg
                aria-hidden="true"
                focusable="false"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                className="fill-current"
              >
                <rect x="1" y="3" width="14" height="1.6" rx="0.8" />
                <rect x="1" y="7.2" width="14" height="1.6" rx="0.8" />
                <rect x="1" y="11.4" width="14" height="1.6" rx="0.8" />
              </svg>
              {sidebarOpen ? '收合選單' : '開啟選單'}
            </button>
            {sidebarOpen ? (
              <nav aria-label="後台選單" className="admin-sidebar mt-2 p-2">
                {/* 手機抽屜與桌面側欄共用同一份群組與 .admin-nav-link,
                    視覺上的 active(黃底深藍字 + 粗體)由 [aria-current='page'] 帶出來。 */}
                {renderGroups('drawer', () => setSidebarOpen(false))}
                <button type="button" onClick={logout} className="admin-sidebar-logout mt-2">
                  登出
                </button>
              </nav>
            ) : null}
          </div>

          {/* Main content
              id 是跳過導覽連結的落點(2.4.1 Bypass Blocks)。root layout 的
              <main> 把側欄也包在裡面,跳去 main 等於沒跳過任何東西,
              所以真正的內容容器要自己報到。tabIndex 讓它收得到焦點。 */}
          <div id={PAGE_CONTENT_ID} tabIndex={-1} className="min-w-0 outline-none">
            {loaded ? children : <p className="text-sm text-muted-foreground">載入中...</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
