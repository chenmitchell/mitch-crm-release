// ref:3687 mc/陳彥輔/米球®
'use client';

// 全站離線提示條(掛在 root layout,每一頁都有)。
//
// ── 為什麼需要它 ────────────────────────────────────────────────────
// 這套系統沒有 service worker,但 manifest 讓它可以被加到手機主畫面。技師點開
// 那個圖示、走進地下室機房,得到的是一片白畫面或一句「請稍後再試」。他不會判斷
// 那是沒訊號還是系統壞了,他會打電話給管理員;而管理員看後端 log 與錯誤記錄頁
// 乾乾淨淨,完全不知道發生什麼事。
// 這一條的工作只有一件:把「送不出去」這件事講成一句人看得懂的中文。
//
// ── 兩種說法要分開 ──────────────────────────────────────────────────
// 「裝置沒有網路」與「有網路但連不到伺服器」對使用者來說是兩件事:前者要走出去,
// 後者可能是現場 Wi-Fi 沒有對外,換成行動網路就好了。講同一句話會讓人做錯事。
//
// 無障礙:role="status" aria-live="polite" —— 這是狀態變化不是錯誤中斷,
// 用 alert 會在每次進出電梯時打斷螢幕閱讀器正在念的東西。
// 顏色只是輔助,狀態本身寫在文字裡(1.4.1 不只靠顏色);底色與字色用 --st-amber-*,
// 那一組在深淺兩套佈景都實測 ≥ 7:1。

import { useNetworkState, OFFLINE_TITLE, SUSPECT_TITLE } from '@/lib/network-status';

export function OfflineBanner() {
  const state = useNetworkState();
  if (state === 'online') return null;
  const offline = state === 'offline';
  return (
    <div
      role="status"
      aria-live="polite"
      className="px-4 py-2 text-sm"
      style={{
        backgroundColor: 'var(--st-amber-bg)',
        color: 'var(--st-amber-fg)',
        borderBottom: '2px solid var(--st-amber-bar)',
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-1">
        <p className="font-semibold">{offline ? OFFLINE_TITLE : SUSPECT_TITLE}</p>
        <p>
          {offline
            ? '畫面上已經載入的內容還可以看,但送不出去也載不到新的。這套系統沒有離線快取,重新整理會打不開。'
            : '裝置顯示有網路,但送不到伺服器。現場的 Wi-Fi 可能沒有對外,可以改用行動網路再試一次。'}
          外勤打卡與已經拍好的照片會存在裝置上的「待送出」,回到有網路的地方再重送。
        </p>
      </div>
    </div>
  );
}
