// ref:3687 mc/陳彥輔/米球®
'use client';

// 目前登入者的單一供應點。
//
// ── 為什麼要有這一支 ────────────────────────────────────────────────
// GET/POST /api/auth/me 原本在前端有五個以上的呼叫點:lib/crm-shared 的 useCrmRole、
// admin/layout.tsx、site-header.tsx、Watermark.tsx,以及 CRM 各頁自己再抄一份
// (map / [id] / duplicates / daily-reports / week / home / users)。
// 後果可以數:打開 /admin/crm/map 一次,同一支端點會被打四次,四份回應各自存進
// 四個 useState,而它們可以不一致 —— 其中一份 401、其他成功時,畫面會同時
// 「顯示使用者名稱」與「說你沒有權限」。
//
// 這一支把那些收斂成一次請求,放在 root layout,底下所有頁面共用同一份結果。
//
// ── 為什麼放在 root layout 而不是 admin layout ──────────────────────
// 浮水印(components/Watermark.tsx)掛在 root layout,它要的姓名與職稱也在這一包。
// 放進 admin layout 的話浮水印拿不到,就得再打一次。
//
// ── 公開頁面不打 ────────────────────────────────────────────────────
// 首頁、登入、安裝精靈、無障礙、隱私、聯絡頁一律不打:那些頁面本來就給沒登入的人看,
// 每次載入都吐一個 401 只是把後端的 log 洗掉。這幾頁不顯示浮水印,
// 因為上面沒有任何客戶資料要防翻拍。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { getApiBase } from './env';

/** /api/auth/me 回的使用者。欄位對應後端 auth.service 的 getProfile() */
export interface MeUser {
  sub?: string;
  email: string;
  name?: string;
  /** 職稱(浮水印第三行用) */
  title?: string | null;
  department?: string | null;
  role: string;
  mustChangePassword?: boolean;
}

/**
 * 這一次查詢的結果。
 *   loading      還在問
 *   ok           問到了,me 有值
 *   unauthorized 後端回 401(沒登入或權杖過期)。admin 外框看到這個就導去登入頁
 *   error        連不上或回了看不懂的東西。不能當成「沒登入」而把人踢出去
 *   skipped      公開頁面,根本沒問
 */
export type MeStatus = 'loading' | 'ok' | 'unauthorized' | 'error' | 'skipped';

export interface MeContextValue {
  me: MeUser | null;
  status: MeStatus;
  /** 問完了沒(不論結果)。等同 status !== 'loading' */
  loaded: boolean;
  /** 重新問一次(改完自己的密碼、切換帳號之後用) */
  refresh: () => Promise<void>;
}

const MeContext = createContext<MeContextValue>({
  me: null,
  status: 'loading',
  loaded: false,
  refresh: async () => {},
});

/**
 * 不需要問「你是誰」的路徑。
 *
 * 判斷方式與收斂之前的 site-header.tsx 一致(那時它自己有一份 PUBLIC_PREFIXES),
 * 差別只在現在整站共用同一份判斷,不會出現「站頭覺得是公開頁、浮水印覺得不是」。
 */
const PUBLIC_PATHS = ['/', '/accessibility', '/privacy', '/contact'] as const;
const PUBLIC_PREFIXES = ['/login', '/setup'] as const;

export function isPublicPath(pathname: string): boolean {
  if ((PUBLIC_PATHS as readonly string[]).includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function MeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const publicPath = isPublicPath(pathname);
  const [me, setMe] = useState<MeUser | null>(null);
  const [status, setStatus] = useState<MeStatus>(publicPath ? 'skipped' : 'loading');

  /**
   * 問一次。回傳這一次的結果,呼叫端(refresh)不必再等 state 更新。
   * POST 而不是 GET:後端兩支都有,POST 那一支回 { user },
   * 收斂之前多數呼叫點用的就是它,維持原樣以免碰到任何一支端點的差異。
   */
  const pull = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const res = await fetch(`${getApiBase()}/api/auth/me`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal,
      });
      if (signal?.aborted) return;
      if (res.status === 401) {
        setMe(null);
        setStatus('unauthorized');
        return;
      }
      if (!res.ok) {
        setMe(null);
        setStatus('error');
        return;
      }
      const body = (await res.json()) as { user?: unknown } & Record<string, unknown>;
      // 後端可能直接回 user 物件,或 { user: ... } 包一層
      const u = (body.user ?? body) as MeUser;
      setMe(u && typeof u.role === 'string' ? u : null);
      setStatus(u && typeof u.role === 'string' ? 'ok' : 'error');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setMe(null);
      setStatus('error');
    }
  }, []);

  // pathname 變就重問:登入完導頁之後,浮水印與站頭要立刻認得人。
  useEffect(() => {
    if (publicPath) {
      setMe(null);
      setStatus('skipped');
      return undefined;
    }
    const ac = new AbortController();
    setStatus('loading');
    void pull(ac.signal);
    return () => ac.abort();
  }, [pathname, publicPath, pull]);

  const refresh = useCallback(async () => {
    await pull();
  }, [pull]);

  const value = useMemo<MeContextValue>(
    () => ({ me, status, loaded: status !== 'loading', refresh }),
    [me, status, refresh],
  );

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

/** 目前登入者。沒有 Provider(理論上不會發生)時回 loading,畫面自己顯示載入中 */
export function useMe(): MeContextValue {
  return useContext(MeContext);
}

/**
 * 目前登入者的角色,配合既有呼叫端的三態約定:
 *   null 還在載入、'' 讀不到(當作沒有權限)、其餘就是角色代碼。
 */
export function useMeRole(): string | null {
  const { me, status } = useMe();
  if (status === 'loading') return null;
  return me?.role ?? '';
}
