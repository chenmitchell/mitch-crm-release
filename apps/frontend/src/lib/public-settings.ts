import { getApiBase } from './env';

/**
 * 公開展示用設定(免登入)。
 *
 * 對應後端 GET /api/public/settings,白名單定義在後端 settings service,
 * 由後端的 controller 測試釘住。這裡的欄位要跟那邊一致。
 *
 * 完整的全站設定在 lib/app-settings.tsx;這一支只取「聯絡頁要顯示的三個值」,
 * 是因為那一頁是伺服器元件底下的小區塊,不需要整份設定的 context。
 */
export interface PublicSettings {
  /** 組織名稱 */
  companyName: string;
  /** 收件地址(後台可改) */
  mailingAddress: string;
  /** 對外聯絡電話 */
  phone: string;
}

/**
 * 讀公開設定。任何失敗都回 null,不 throw。
 *
 * 為什麼吞掉錯誤:呼叫端是「順便顯示地址與電話」的區塊,不是頁面的主要任務。
 * /contact 的主要任務是告訴人怎麼找管理者,不該因為這一支端點連不上而整頁壞掉。
 *
 * 但是**不能**在拿不到值的時候塞一組寫死的地址頂替:那會讓畫面上的地址與後台設定分家,
 * 人照畫面寄到已經搬走的地方。拿不到就明說拿不到 —— 一個可能是錯的地址,
 * 比「沒有地址」危險得多。
 */
export async function fetchPublicSettings(signal?: AbortSignal): Promise<PublicSettings | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/public/settings`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { settings?: Partial<PublicSettings> };
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    const s = data.settings;
    if (!s) return null;
    return {
      companyName: typeof s.companyName === 'string' ? s.companyName : '',
      mailingAddress: typeof s.mailingAddress === 'string' ? s.mailingAddress : '',
      phone: typeof s.phone === 'string' ? s.phone : '',
    };
  } catch (err) {
    // 原始訊息留給 console 除錯,畫面上不出現英文原生例外
    if ((err as Error)?.name !== 'AbortError') {
      console.error('[public-settings] 讀取公開設定失敗', err);
    }
    return null;
  }
}
