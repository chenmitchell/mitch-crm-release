// ref:3687 mc/陳彥輔/米球®

// 安裝精靈的前端合約。
//
// 後端兩支端點:
//   GET  /api/setup/status  免登入。回 { initialized: boolean, steps?: {...} }
//                           initialized=false 表示這套系統還沒裝過,任何路徑都要先去 /setup。
//   POST /api/setup         免登入,但只有 initialized=false 時才收(裝好之後一律 409)。
//                           body 是下面的 SetupPayload,每一段都可以省略(精靈每一步都能跳過),
//                           省略的部分後端用預設值。成功回 { ok: true }。
//
// 為什麼 status 要免登入:還沒建管理員帳號的時候沒有人能登入,
// 這支端點是唯一能判斷「要不要顯示安裝精靈」的依據。
// 它只回一個布林值與各步驟填了沒,不吐任何設定內容,所以免登入不會外洩東西。

import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { PASSWORD_MAX, PASSWORD_MIN } from '@mitchcrm/shared/password';

/** 安裝精靈「管理員帳號」那一步的欄位 */
export interface SetupAdminForm {
  email: string;
  password: string;
  password2: string;
}

/**
 * 管理員帳號這一步的錯誤訊息;沒有問題回 null。
 *
 * 這一步是精靈裡唯一不能跳過的:它沒有預設值,而後端判斷「系統裝好了沒」看的就是
 * users 表有沒有人。以前這裡是「完全沒填 = 等同跳過」,於是可以走完整個安裝、
 * 後端照樣回 201,但一個帳號都沒建 —— 完成畫面卻寫著「用剛才建立的管理員帳號登入」。
 *
 * 放在這一支(而不是頁面裡)是為了測得到:這條規則壞掉的代價是全新使用者
 * 第一分鐘就卡在登入頁,值得用測試釘住。
 */
export function setupAdminError(admin: SetupAdminForm): string | null {
  const email = admin.email.trim();
  if (email === '') return '請填管理員 Email,這一步不能跳過';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '管理員 Email 格式不正確';
  if (admin.password === '') return '請設定管理員密碼,這一步不能跳過';
  if (admin.password.length < PASSWORD_MIN) return `管理員密碼至少 ${PASSWORD_MIN} 個字元`;
  if (admin.password.length > PASSWORD_MAX) return `管理員密碼最多 ${PASSWORD_MAX} 個字元`;
  if (admin.password !== admin.password2) return '兩次輸入的密碼不一致';
  return null;
}

export interface SetupStatus {
  /** 已完成安裝。false = 要走安裝精靈 */
  initialized: boolean;
  /** 各步驟填過沒(精靈用來標示「已設定」,可有可無) */
  steps?: Record<string, boolean>;
}

/** 精靈每一步對應的 payload。整段省略 = 這一步跳過,後端用預設值 */
export interface SetupPayload {
  organization?: {
    name: string;
    displayName: string;
    productName: string;
    logoText: string;
  };
  admin?: {
    email: string;
    name: string;
    password: string;
  };
  locale?: {
    timezone: string;
    locale: string;
  };
  /** 部門與主管的初始結構。managerEmail 對不到人時後端只建部門、不指派主管 */
  departments?: Array<{
    name: string;
    managerName?: string;
    managerEmail?: string;
  }>;
  stages?: Array<{
    key: string;
    label: string;
    color: string;
    board: boolean;
    form: boolean;
  }>;
  photoChecklist?: Array<{
    key: string;
    label: string;
    required: boolean;
    placeTypes: string[];
  }>;
  map?: {
    defaultLat: number;
    defaultLng: number;
    defaultZoom: number;
    geocodeProvider: 'nominatim' | 'none';
    /** 逗號分隔的兩碼國碼,空字串 = 不限制國家 */
    geocodeCountryCodes: string;
  };
  appearance?: {
    themeScheme: 'A' | 'B';
    themeSidebar: 'dark' | 'light';
    themeDefaultMode: 'light' | 'dark' | 'system';
    areaColors: Record<string, string>;
  };
  /**
   * 外部查詢帶入。整段省略 = 不啟用,識別碼那一格就是純手動填。
   * urlTemplate 裡的 {q} 是識別碼會被代進去的位置;後端會擋掉非 https
   * 與指向內網的網址(見 apps/backend/src/lookup)。
   */
  lookup?: {
    enabled: boolean;
    label: string;
    urlTemplate: string;
    fieldMap: Record<string, string>;
    pattern: string;
  };
}

/**
 * 問後端裝好了沒。
 *
 * 連不上時回 null(不是 false):這兩件事必須分清楚。
 * 「後端說還沒裝」才該把人送去安裝精靈;「問不到後端」只是網路或服務暫時不通,
 * 這時候把所有人踢去安裝精靈,等於在服務中斷時對外顯示一個可以重設系統的頁面。
 */
export async function fetchSetupStatus(signal?: AbortSignal): Promise<SetupStatus | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/setup/status`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { initialized?: unknown; steps?: unknown };
    if (typeof body.initialized !== 'boolean') return null;
    const steps =
      typeof body.steps === 'object' && body.steps !== null
        ? (Object.fromEntries(
            Object.entries(body.steps as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'boolean',
            ),
          ) as Record<string, boolean>)
        : undefined;
    return steps ? { initialized: body.initialized, steps } : { initialized: body.initialized };
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      console.error('[setup] 讀取安裝狀態失敗', err);
    }
    return null;
  }
}

export interface SubmitSetupResult {
  ok: boolean;
  /** 失敗時給使用者看的中文訊息 */
  message?: string;
}

/** 送出安裝設定。失敗時把後端的中文訊息帶回來,不要自己編一句 */
export async function submitSetup(payload: SetupPayload): Promise<SubmitSetupResult> {
  try {
    const res = await fetch(`${getApiBase()}/api/setup`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    // 訊息規則走 lib/api-error:只有 4xx 且訊息含中文才原樣顯示,
    // 5xx 或框架的英文錯誤退回下面這句。規則寫在那一支的檔頭,不在這裡再寫一份。
    return { ok: false, message: await apiErrorMessage(res, `安裝失敗(${res.status})`) };
  } catch {
    return { ok: false, message: '連不上伺服器,請確認後端服務是否啟動' };
  }
}
