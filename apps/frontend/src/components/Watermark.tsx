'use client';

// 動態防截圖浮水印(登入後才顯示;公開頁面不顯示,那些頁面上沒有客戶資料)。
// 每個字塊三行:① 主機時間(每秒跳,含時區標示)② 組織名稱 ③ 姓名 · 職稱。
// 時間來源:useServerNow()(見 lib/app-settings)。基準是後端 /api/public/settings 回的
//   serverTime,再用 performance.now() 單調時鐘推進 —— 使用者改自己電腦時間也無法造假。
//   時區標示一定要印:跨時區時只寫「14:30」,截圖拿去當證據時對造可以主張那是別的時區的 14:30。
// 姓名職稱、組織名稱與時間全部從 context 拿,這一支自己不打任何 API:
//   收斂之前它自己打一次 /api/auth/me、再自己打一次 /api/public/settings 並每五分鐘再打一次,
//   而同一頁上已經有別人在打同樣這兩支。
// 每個字塊各自隨機角度、抖動散佈並持續位移(防偽特徵,故意保留);數量少、字小、顏色淡,不干擾閱讀;印出時加深。
// pointer-events:none 不擋操作;被 devtools 移除時由 MutationObserver 自動插回。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatOrgStamp } from '@mitchcrm/shared';
import { useAppSettings, useServerNow } from '@/lib/app-settings';
import { useMe } from '@/lib/me-context';

export default function Watermark() {
  // 組織名稱讀的是 organizationName,不是相容用的舊欄位名 companyName。
  // 舊欄位還在後端白名單裡是為了讀舊資料,哪天那一行被拿掉,讀舊欄位的地方
  // 會安靜地印出空字串 —— 而浮水印中央那一行正是要拿來當證據的。
  const { organizationName, timezone } = useAppSettings();
  const serverNow = useServerNow();
  const { me } = useMe();
  const [nowText, setNowText] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // useMemo:下面的防移除 useEffect 把 who 放在相依陣列裡,每次 render 都造一個新物件的話
  // MutationObserver 會被反覆拆掉重建
  const who = useMemo(
    () => (me?.name ? { name: me.name, title: me.title ?? null } : null),
    [me?.name, me?.title],
  );

  // 每秒推進顯示時間。基準與校時都在 AppSettingsProvider 裡,這裡只讀。
  useEffect(() => {
    const tick = () => setNowText(formatOrgStamp(new Date(serverNow().ms), timezone));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [timezone, serverNow]);

  // 手機(窄螢幕)用比較稀的網格:桌機 3x4=12 塊,手機 2x3=6 塊,字也縮小(見下方 CSS)。
  // 用 matchMedia 監聽,轉直橫向時重排。
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // 每個字塊固定的隨機位置與角度(只在網格密度改變時重算,避免每次 render 亂跳)
  const cells = useMemo(() => {
    const cols = narrow ? 2 : 3;
    const rows = narrow ? 3 : 4;
    const arr: Array<{ top: number; left: number; rot: number }> = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        arr.push({
          // 隨機位置與角度是防偽特徵(每次載入不同,截圖無法用固定遮罩去除),故意保留
          left: (c + 0.5) * (100 / cols) + (Math.random() - 0.5) * 12,
          top: (r + 0.5) * (100 / rows) + (Math.random() - 0.5) * 10,
          rot: Math.floor(Math.random() * 360),
        });
      }
    }
    return arr;
  }, [narrow]);

  // 防移除:被 devtools 從 DOM 拿掉或隱藏時自動還原
  useEffect(() => {
    if (!who) return undefined;
    const el = rootRef.current;
    if (!el) return undefined;
    const parent = el.parentNode ?? document.body;
    const obs = new MutationObserver(() => {
      if (!document.body.contains(el)) parent.appendChild(el);
      if (
        el.style.display === 'none' ||
        el.style.visibility === 'hidden' ||
        el.style.opacity === '0'
      ) {
        el.style.display = '';
        el.style.visibility = '';
        el.style.opacity = '';
      }
    });
    // body 只看直接子節點:浮水印實際掛在版面裡的某一層,不是 body 的直接子節點,
    // 所以還要盯自己那一層的 parent,不然從 parent 拿掉時 body 那一個 observer
    // 收不到通知。這裡刻意不開 subtree:整棵 body 的 childList 在列表頁每次
    // 重繪都會噴大量 record,而要防的只有「這個節點被拿掉」這一件事。
    obs.observe(document.body, { childList: true });
    if (parent !== document.body) obs.observe(parent, { childList: true });
    obs.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => obs.disconnect();
  }, [who]);

  if (!who) return null;

  const line3 = who.title ? `${who.name} · ${who.title}` : who.name;

  return (
    <div ref={rootRef} aria-hidden className="wm-root">
      <style>{`
        .wm-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden;}
        .wm-cell{position:absolute;transform:translate(-50%,-50%) rotate(var(--r));
          font-size:15px;line-height:1.35;font-weight:500;letter-spacing:.3px;text-align:center;
          color:#0a4d8c;opacity:.09;white-space:nowrap;user-select:none;
          animation:wmdrift 20s linear infinite;will-change:transform;}
        @keyframes wmdrift{
          from{transform:translate(-50%,-50%) rotate(var(--r)) translate3d(0,0,0);}
          to{transform:translate(-50%,-50%) rotate(var(--r)) translate3d(-40px,-30px,0);}
        }
        .wm-cell b{font-weight:700;}
        @media (max-width:767px){.wm-cell{font-size:12px;line-height:1.3;opacity:.08;}}
        @media (prefers-color-scheme:dark){.wm-cell{color:#a9c4e4;opacity:.12;}}
        @media (prefers-color-scheme:dark) and (max-width:767px){.wm-cell{opacity:.10;}}
        @media print{.wm-cell{opacity:.30 !important;}}
      `}</style>
      {cells.map((cell, i) => (
        <div
          key={i}
          className="wm-cell"
          style={
            {
              top: `${cell.top}%`,
              left: `${cell.left}%`,
              '--r': `${cell.rot}deg`,
            } as React.CSSProperties
          }
        >
          <div>{nowText}</div>
          <div>
            <b>{organizationName || '　'}</b>
          </div>
          <div>{line3}</div>
        </div>
      ))}
    </div>
  );
}
