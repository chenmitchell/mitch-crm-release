// ref:3687 mc/陳彥輔/米球®
'use client';

// 網路狀態的單一來源(外勤打卡、拍照存證、拜訪日報共用)。
//
// ── 為什麼不只看 navigator.onLine ──────────────────────────────────
// navigator.onLine 只回答「這台裝置有沒有連上某個網路介面」。技師站在地下室機房、
// 鐵皮廠房裡,手機常常是「連著基地台但完全送不出封包」,或連著現場的 Wi-Fi
// 但那個 Wi-Fi 沒有對外。這種情況 navigator.onLine 是 true,而每一支 API 都會逾時。
// 只信它的話,畫面會顯示「請稍後再試」,而再試永遠不會成功。
//
// 所以這裡有兩個來源:
//   1. navigator.onLine 與 online / offline 事件 —— 明確斷線時最快、最準
//   2. 實際請求失敗(呼叫端在 fetch 的 catch 裡呼叫 reportNetworkFailure())
//      —— 上面那種「連著但送不出去」只有這一個來源看得到
// 任何一支請求成功就呼叫 reportNetworkSuccess() 把疑似狀態清掉。
//
// ── 快照必須是純狀態,不能跟時間有關 ────────────────────────────────
// useSyncExternalStore 會在同一次 render 裡呼叫 getSnapshot 多次,快照只要每次
// 算出來不一樣就會無限重繪。所以「疑似離線」不做時間衰減,只由成功的請求或
// online 事件清除。
//
// ── 這裡不做什麼 ────────────────────────────────────────────────────
// 這一支不碰快取也不註冊 service worker。整個系統沒有 service worker,
// 也就是說「完全沒開過的頁面」在離線時打不開,這一支救不了那一種情況,
// 它救的是「頁面已經開著、人走進沒訊號的地方」這一種 —— 那才是外勤的常態。

import { useSyncExternalStore } from 'react';

/**
 * online   看起來正常
 * offline  裝置明確回報沒有網路(navigator.onLine === false)
 * suspect  裝置說有網路,但實際請求送不出去(連著沒有對外的 Wi-Fi、基地台收訊極差)
 */
export type NetworkState = 'online' | 'offline' | 'suspect';

/** 全站統一的離線抬頭。各頁不要自己另外編一句 */
export const OFFLINE_TITLE = '目前沒有網路連線';
/** 裝置說有網路但送不出去時的抬頭。跟「完全沒訊號」講法要不一樣,不然使用者會以為系統壞了 */
export const SUSPECT_TITLE = '網路目前連不上伺服器';

type Listener = () => void;

const listeners = new Set<Listener>();
/** 有沒有請求真的失敗過(且之後沒有成功過) */
let suspect = false;
let bound = false;

function emit(): void {
  for (const l of [...listeners]) l();
}

/** 呼叫端在 fetch 的 catch 裡呼叫。「裝置說有網路但送不出去」只有這一個來源看得到 */
export function reportNetworkFailure(): void {
  if (suspect) return;
  suspect = true;
  emit();
}

/** 任何一支請求成功就呼叫,把疑似離線清掉 */
export function reportNetworkSuccess(): void {
  if (!suspect) return;
  suspect = false;
  emit();
}

/** 目前狀態。伺服器端算不出來,一律回 online(畫面上就是不顯示離線提示) */
export function networkState(): NetworkState {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return suspect ? 'suspect' : 'online';
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!bound && typeof window !== 'undefined') {
    bound = true;
    window.addEventListener('online', () => {
      // 重新連上網路時把疑似狀態一起清掉:這時候該讓使用者重試,而不是繼續看到紅字
      suspect = false;
      emit();
    });
    window.addEventListener('offline', emit);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** 伺服器端與 hydration 第一拍的快照。固定 online,避免 SSR 與 client 不一致 */
function serverSnapshot(): NetworkState {
  return 'online';
}

/** 目前的網路狀態(會隨 online / offline 事件與請求成敗更新) */
export function useNetworkState(): NetworkState {
  return useSyncExternalStore(subscribe, networkState, serverSnapshot);
}

/**
 * 這個例外是不是「送不出去」而不是「伺服器回了錯」。
 *
 * fetch 在連線失敗時 reject 的是 TypeError(規格如此,各家瀏覽器的 message 不一樣,
 * 所以不能比對字串)。伺服器有回應(4xx / 5xx)時 fetch 是 resolve 的,不會走到這裡。
 * 只在 fetch 的 catch 區塊裡呼叫這一支,別拿它判斷別的例外。
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return err instanceof TypeError;
}
