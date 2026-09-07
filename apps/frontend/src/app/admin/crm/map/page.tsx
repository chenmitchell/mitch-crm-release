'use client';

// 拜訪地圖頁(/admin/crm/map)。
// 手機優先:取得我的位置 → 附近客戶依距離排序 → 規劃今日路線 → Google 導航。
// 資料來源:GET /api/admin/crm-map/customers、POST /api/admin/crm-map/geocode、POST /api/admin/crm-map/route、
// GET /api/admin/crm-map/reverse(定位後反查路名)、POST /api/admin/crm-visit-plans(加入今日路線,由拜訪排程模組提供)。
// 角色:admin/sales/sales_manager 可用;業務只看自己的客戶(後端過濾)。
// 無障礙:地圖(role=region)不是唯一資訊來源,右側/下方清單列出全部資訊,是地圖的替代。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import type { FocusTarget, MapPoint } from '@/components/crm/visit-map';
import { canUseCrm, useCrmRole, useStageMeta } from '@/lib/crm-shared';
import { useAppSettings } from '@/lib/app-settings';
import { orgToday } from '@mitchcrm/shared';

// leaflet 直接碰 window,只能在瀏覽器載入
const VisitMap = dynamic(() => import('@/components/crm/visit-map'), {
  ssr: false,
  loading: () => (
    <div
      role="region"
      aria-label="拜訪地圖"
      className="flex min-h-[50vh] items-center justify-center rounded-lg border border-border bg-surface text-sm text-muted-foreground"
    >
      地圖載入中…
    </div>
  ),
});

// ---- 常數 ----
// 階段標籤與配色一律用 useStageMeta()(來源是後台設定),這裡不留第二份複本。

// Google 導航一次最多 9 個 waypoint(加終點 = 10 站)
const GOOGLE_MAX_WAYPOINTS = 9;
// 規劃路線一次最多帶的客戶數
const ROUTE_MAX_STOPS = 30;

type Scope = 'today' | 'all';

interface Owner {
  id: string;
  name: string;
}
interface MapCustomer {
  id: string;
  companyName: string | null;
  taxId: string | null;
  stage: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  nextFollowUpAt: string | null;
  /** 今天(組織時區)已排進拜訪計畫且還沒完成 */
  plannedToday?: boolean;
  contactPhone: string | null;
  contactName: string | null;
  owner: Owner | null;
}
interface ReverseResponse {
  road: string | null;
  district: string | null;
  city: string | null;
  display: string | null;
}
interface CustomersResponse {
  rows: MapCustomer[];
  pendingGeocode: number;
  /** 一次補座標最多處理幾筆(後端 GEOCODE_BATCH_MAX) */
  batchMax?: number;
  /** 每位使用者兩次補座標之間的最短間隔,毫秒(後端 GEOCODE_PER_USER_INTERVAL_MS) */
  geocodeIntervalMs?: number;
}
interface GeocodeResponse {
  processed: number;
  succeeded: number;
  /** 這一輪打外部服務失敗的筆數 */
  failed: number;
  /** 目前還沒有座標的總筆數(誠實值,不扣掉退避中的) */
  remaining: number;
  /** 其中因為先前失敗、正在 24 小時退避的筆數 */
  retryingLater: number;
  /** 這一輪出現過的失敗原因分類(network 連不到 / rejected 被拒 / notFound 查不到地址) */
  failureKinds?: ('network' | 'rejected' | 'notFound')[];
  batchMax?: number;
  geocodeIntervalMs?: number;
}

/**
 * 補座標的進度說明。
 *
 * 為什麼一定要有這一句:一次只處理 batchMax 筆(出廠 10),而且每人兩次之間要隔
 * intervalMs(出廠 30 秒)。兩千筆客戶因此是兩百次、跨一百分鐘,不是「按一下就好」。
 * 沒有這句話的使用者會按三次、看到數字從 2000 變成 1970,然後認定功能壞了。
 * 兩個上限都從後端回應帶下來,前端不寫死。
 */
function geocodeEta(remaining: number, batchMax: number, intervalMs: number): string {
  if (remaining <= 0) return '';
  const rounds = Math.ceil(remaining / Math.max(1, batchMax));
  if (rounds <= 1) return `還有 ${remaining} 筆沒有座標,再按一次就補得完。`;
  // 第一次可以立刻按,所以要等的是 rounds - 1 次間隔
  const minutes = Math.ceil(((rounds - 1) * intervalMs) / 60_000);
  return (
    `還有 ${remaining} 筆沒有座標。一次最多處理 ${batchMax} 筆、兩次之間要隔 ` +
    `${Math.round(intervalMs / 1000)} 秒,所以大約還要按 ${rounds} 次、` +
    `合計約 ${minutes} 分鐘才補得完(可以分幾天慢慢按,補到的座標會留著)。`
  );
}

/** 失敗原因對應的處理建議。講「該找誰處理」,不是丟一句「失敗」讓人乾瞪眼。 */
const FAILURE_HINT: Record<string, string> = {
  network: '伺服器連不到外部地圖服務,請維運人員確認對外連線是否被擋',
  rejected: '外部地圖服務拒絕了請求,通常是伺服器未設定聯絡信箱(NOMINATIM_EMAIL),請維運人員補上',
  notFound: '地圖服務查不到這個地址,請確認客戶的地址是否正確、完整',
};
interface RouteResponse {
  order: { id: string; distanceFromPrevM: number }[];
  totalM: number;
}

interface LatLng {
  lat: number;
  lng: number;
}

function hasCoord(c: MapCustomer): c is MapCustomer & { lat: number; lng: number } {
  return (
    typeof c.lat === 'number' &&
    typeof c.lng === 'number' &&
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lng)
  );
}

function fmtDistance(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} 公尺`;
  return `${(m / 1000).toFixed(1)} 公里`;
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function navUrl(c: MapCustomer): string {
  const dest = hasCoord(c)
    ? `${c.lat},${c.lng}`
    : encodeURIComponent(c.address ?? c.companyName ?? '');
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}

// 四步驟引導的文案(顯示順序固定)
const GUIDE_STEPS = [
  { title: '一、定位', hint: '按「取得我的位置」' },
  { title: '二、選今天要跑的客戶', hint: '勾清單的「加入今日路線」,或切到「全部開發中」' },
  { title: '三、規劃路線', hint: '按「規劃今日路線」' },
  { title: '四、逐家導航', hint: '用清單的「Google 導航」一家一家跑' },
] as const;

// 定位錯誤轉中文(不把瀏覽器原始訊息丟給使用者)
function geoErrorText(code: number): string {
  if (code === 1) return '無法取得位置:瀏覽器未授權定位。你仍可使用清單與導航按鈕。';
  if (code === 3) return '定位逾時,請到訊號較好的地方再試。你仍可使用清單與導航按鈕。';
  return '目前無法取得位置。你仍可使用清單與導航按鈕。';
}

// ---- 「附近客戶」清單的虛擬捲動 ----
//
// 為什麼要有這一段:管理員切到「全部開發中」,清單就是資料庫裡全部有座標的客戶。
// 五萬筆客戶的組織實測是兩千張卡一次全展開,每張卡二十幾個元素,再加上地圖那邊的
// marker,一頁兩三萬個節點,而使用者是拿手機在外面跑的。
// 這裡只把「看得到的那一段 + 前後各留幾張」放進 DOM,其餘用 ol 的上下 padding 佔位。
//
// 沒有引進任何套件:要的行為就是「量高度、算窗格、上下墊 padding」這幾十行,
// react-window 之類的東西會帶進自己的 DOM 結構(它要求固定高度或另外量),
// 而這份清單每張卡高度不一樣(聯絡人、負責業務是有才顯示)。
//
// 無障礙(這幾點是硬性的,不能為了效能拿掉):
//   - 捲動容器(包住 <ol> 的那個 div)是 role="group"、tabIndex=0,鍵盤 Tab 進得去、
//     方向鍵與 Page Up / Page Down 捲得動,全域的 :focus-visible 會給它焦點框。
//   - 每個 <li> 帶 aria-setsize(總筆數)與 aria-posinset(這是第幾筆),
//     螢幕閱讀器唸得出「第 137 筆,共 2000 筆」,不是只唸得出畫面上那十幾筆。
//   - 焦點在哪一張卡上,那一張就一定會被畫出來(pinned),不會因為捲動被卸載掉而讓焦點掉到 body。
//     做法是「窗格之外再多畫那一張」,不是把窗格撐開到涵蓋它 —— 撐開的話,焦點停在第 1 筆、
//     人捲到第 2000 筆,窗格就變成 0 到 2000,兩千張卡全部進 DOM,虛擬捲動整個被抵銷掉。
//     那一張跟窗格之間用一格空白(pinnedGap)補上中間沒畫的高度,捲軸長度不會跳。
//   - 釘的是**客戶 id**,不是索引。清單會因為重新載入、規劃路線、拿到定位而整份重排,
//     索引在重排後指到的是別人;每次算窗格前都從 sortedRows 反查一次目前的索引。

/** 少於這個筆數就整份畫出來,不必虛擬捲動(小清單全部可 Tab 比較好用) */
export const LIST_VIRTUAL_MIN = 40;
/** 還沒量到高度時,一張卡先當作幾 px(含卡片之間的間距) */
export const LIST_ITEM_ESTIMATE_PX = 210;
/** 窗格前後各多畫幾張,捲動時才不會先看到空白 */
export const LIST_OVERSCAN = 4;

export interface VirtualWindow {
  /** 要畫的第一筆索引(含) */
  start: number;
  /** 要畫的最後一筆索引的下一個(不含) */
  end: number;
  /** ol 上方要墊多高 */
  padTop: number;
  /** ol 下方要墊多高 */
  padBottom: number;
  /** 整份清單的高度 */
  total: number;
  /**
   * 焦點所在那一筆落在 [start, end) 之外時,它的索引;在窗格裡或根本沒有就是 null。
   * 呼叫端要把這一筆**額外**畫出來(在窗格前面或後面,照索引順序),
   * 不是把窗格擴大到涵蓋它。
   */
  pinned: number | null;
  /** 那一張與窗格之間空掉的高度(中間沒畫出來的那些卡) */
  pinnedGap: number;
}

/**
 * 算出目前該畫哪一段。heights[i] 是量到的高度,沒量到(還沒畫過)就用 estimate。
 * pinned 是「焦點所在的那一筆」,它一定畫得出來,但**不會**把窗格撐開:
 * 落在窗格外時由 VirtualWindow.pinned 單獨回報,呼叫端多畫那一張就好。
 */
export function computeVirtualWindow(opts: {
  count: number;
  heights: number[];
  estimate: number;
  scrollTop: number;
  viewport: number;
  overscan: number;
  pinned?: number | null;
}): VirtualWindow {
  const { count, heights, estimate, overscan } = opts;
  const heightAt = (i: number) => {
    const h = heights[i];
    return typeof h === 'number' && h > 0 ? h : estimate;
  };
  const offsets: number[] = new Array(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i += 1) offsets[i + 1] = (offsets[i] ?? 0) + heightAt(i);
  const total = offsets[count] ?? 0;
  if (count === 0)
    return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0, pinned: null, pinnedGap: 0 };

  const viewport = Math.max(1, opts.viewport);
  const top = Math.max(0, Math.min(opts.scrollTop, Math.max(0, total - viewport)));
  let start = 0;
  while (start < count - 1 && (offsets[start + 1] ?? 0) <= top) start += 1;
  let end = start;
  while (end < count && (offsets[end] ?? 0) < top + viewport) end += 1;
  start = Math.max(0, start - overscan);
  end = Math.min(count, Math.max(end + overscan, start + 1));
  let padTop = offsets[start] ?? 0;
  let padBottom = Math.max(0, total - (offsets[end] ?? total));
  // 焦點那一筆若已經在窗格裡就什麼都不必做;落在窗格外才單獨多畫一張,
  // 上下的墊高改成算到「那一張」為止,中間差掉的高度由 pinnedGap 補回來,
  // 所以 padTop + 那一張 + pinnedGap + 窗格 + padBottom 仍然等於 total。
  const pinned = opts.pinned;
  let pinnedOut: number | null = null;
  let pinnedGap = 0;
  if (
    typeof pinned === 'number' &&
    Number.isInteger(pinned) &&
    pinned >= 0 &&
    pinned < count &&
    (pinned < start || pinned >= end)
  ) {
    pinnedOut = pinned;
    if (pinned < start) {
      padTop = offsets[pinned] ?? 0;
      pinnedGap = Math.max(0, (offsets[start] ?? 0) - (offsets[pinned + 1] ?? 0));
    } else {
      pinnedGap = Math.max(0, (offsets[pinned] ?? 0) - (offsets[end] ?? 0));
      padBottom = Math.max(0, total - (offsets[pinned + 1] ?? total));
    }
  }
  return { start, end, padTop, padBottom, total, pinned: pinnedOut, pinnedGap };
}

export default function CrmMapPage() {
  const stageMeta = useStageMeta();
  // 「今天」照組織設定的時區算,不是裝置的本地時區。
  // 用裝置時區的話,人在別的時區出差(或手機時區設錯)按下「加入今日路線」,
  // 排程會落在跟後端不同的一天,而畫面上看不出來
  const { timezone } = useAppSettings();
  // 角色走共用 hook(見 lib/crm-shared 的 useCrmRole),整站對 /api/auth/me 只有一個呼叫點
  const role = useCrmRole();

  const [me, setMe] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  // 我的位置反查到的路名,查不到就維持 null(不顯示、不報錯)
  const [meAddress, setMeAddress] = useState<string | null>(null);

  // 加入今日路線:處理中的客戶 id 與狀態訊息
  const [planningId, setPlanningId] = useState<string | null>(null);
  const [planMsg, setPlanMsg] = useState<string | null>(null);

  const [scope, setScope] = useState<Scope>('today');
  const [rows, setRows] = useState<MapCustomer[]>([]);
  const [pendingGeocode, setPendingGeocode] = useState(0);
  /** 補座標的兩個上限,由後端回應帶下來(出廠 10 筆 / 30 秒),前端不寫死 */
  const [geocodeBatchMax, setGeocodeBatchMax] = useState(10);
  const [geocodeIntervalMs, setGeocodeIntervalMs] = useState(30_000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [geocoding, setGeocoding] = useState(false);
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null);

  const [routing, setRouting] = useState(false);
  const [routeMsg, setRouteMsg] = useState<string | null>(null);
  // id → 拜訪順序(從 1 開始)
  const [routeOrder, setRouteOrder] = useState<Map<string, number> | null>(null);
  const [routeTotalM, setRouteTotalM] = useState<number | null>(null);

  // 進頁面時自動補一次座標,只做一次
  const autoGeocodedRef = useRef(false);

  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ---- 清單虛擬捲動的狀態(說明見檔案上方 computeVirtualWindow 那一段)----
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportPx, setViewportPx] = useState(0);
  // 焦點所在那一筆的**客戶 id**:捲動時那一張一定畫得出來,否則焦點會跟著節點一起消失。
  // 記 id 不記索引:sortedRows 會因為重新載入(loadCustomers 相依裡有 me,自動補完座標也會重載)、
  // 規劃或清除路線而整份重排,存下來的索引在重排後指到的是別人,焦點所在那一張反而被卸載。
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // 量到的卡片高度,用客戶 id 當 key:重新排序、切範圍都不必重量
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  const itemElsRef = useRef<Map<string, HTMLLIElement>>(new Map());
  const scrollRafRef = useRef<number | null>(null);

  const apiBase = `${getApiBase()}/api/admin/crm-map`;

  const canUse = canUseCrm(role);

  // 載入客戶(帶我的位置就會回距離並依距離排序)。
  // 每次呼叫先中止上一次還沒回來的請求(切範圍、定位、補座標可能連續觸發),舊回應不會蓋掉新的。
  const loadAcRef = useRef<AbortController | null>(null);
  const loadCustomers = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    loadAcRef.current?.abort();
    const ac = new AbortController();
    loadAcRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ scope });
      if (me) {
        qs.set('lat', String(me.lat));
        qs.set('lng', String(me.lng));
      }
      const res = await fetch(`${apiBase}/customers?${qs.toString()}`, {
        credentials: 'include',
        signal: ac.signal,
      });
      if (!res.ok) {
        // 載入客戶清單不會被限流;4xx 的中文訊息才顯示,其餘用自己的文案
        const text = await apiErrorMessage(res, '無法載入客戶資料,請稍後再試。');
        if (!ac.signal.aborted) setError(text);
        return;
      }
      const data = (await res.json()) as CustomersResponse;
      if (ac.signal.aborted) return;
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setPendingGeocode(typeof data.pendingGeocode === 'number' ? data.pendingGeocode : 0);
      if (typeof data.batchMax === 'number' && data.batchMax > 0) setGeocodeBatchMax(data.batchMax);
      if (typeof data.geocodeIntervalMs === 'number' && data.geocodeIntervalMs >= 0)
        setGeocodeIntervalMs(data.geocodeIntervalMs);
    } catch {
      if (ac.signal.aborted) return;
      setError('無法載入客戶資料,請稍後再試。');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [role, canUse, scope, me, apiBase]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  // 離開頁面時中止還在飛的請求
  useEffect(() => () => loadAcRef.current?.abort(), []);

  // 進頁面看到有客戶沒座標,自動補一次(每次進頁面只做一次),補完重載清單。
  // 「補齊地址座標」按鈕保留當備援:自動這次失敗、或還有剩,都可以自己再按。
  useEffect(() => {
    if (autoGeocodedRef.current) return;
    if (!canUse || loading || pendingGeocode === 0) return;
    autoGeocodedRef.current = true;
    void geocode();
    // geocode 是每次 render 新建的函式,故意不放進 deps:這裡只在第一次符合條件時跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUse, loading, pendingGeocode]);

  // 換範圍就清掉舊路線
  useEffect(() => {
    setRouteOrder(null);
    setRouteTotalM(null);
    setRouteMsg(null);
  }, [scope]);

  // ---- 取得我的位置 ----
  function locate() {
    if (locating) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoMsg('此裝置或瀏覽器不支援定位。你仍可使用清單與導航按鈕。');
      return;
    }
    setLocating(true);
    setGeoMsg('定位中…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMe(at);
        setGeoMsg('已取得我的位置,清單已依距離重新排序。');
        setLocating(false);
        void lookupRoad(at);
      },
      (err) => {
        setGeoMsg(geoErrorText(err.code));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  // ---- 反查我在哪條路(失敗就不顯示,不報錯)----
  async function lookupRoad(at: LatLng) {
    setMeAddress(null);
    try {
      const qs = new URLSearchParams({ lat: String(at.lat), lng: String(at.lng) });
      const res = await fetch(`${apiBase}/reverse?${qs.toString()}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as ReverseResponse;
      const text = typeof data.road === 'string' && data.road.trim() ? data.road.trim() : null;
      if (text) setMeAddress(`你在${text}附近`);
      else if (typeof data.display === 'string' && data.display.trim())
        setMeAddress(`你在${data.display.trim()}附近`);
    } catch {
      // 反查只是輔助資訊,失敗就不顯示
    }
  }

  // ---- 補齊地址座標(每次最多 10 筆,remaining > 0 可再按)----
  // retry=true:使用者按「重試」,後端會清掉失敗退避再跑一次
  async function geocode(retry = false) {
    if (geocoding) return;
    if (pendingGeocode === 0 && !retry) {
      setGeocodeMsg('目前沒有待補齊座標的客戶。');
      return;
    }
    setGeocoding(true);
    setGeocodeMsg(`座標補齊處理中,每次最多處理 ${geocodeBatchMax} 筆…`);
    try {
      const res = await fetch(`${apiBase}/geocode${retry ? '?retry=1' : ''}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        // 429 是後端限流,message 是中文「地理編碼請稍候 N 秒後再試」,照原樣顯示;其他狀態用自己的文案
        setGeocodeMsg(
          await apiErrorMessage(
            res,
            res.status === 429 ? '補齊座標太頻繁,請稍候再試。' : '補齊座標失敗,請稍後再試。',
          ),
        );
        return;
      }
      const data = (await res.json()) as GeocodeResponse;
      setPendingGeocode(data.remaining);
      if (typeof data.batchMax === 'number' && data.batchMax > 0) setGeocodeBatchMax(data.batchMax);
      if (typeof data.geocodeIntervalMs === 'number' && data.geocodeIntervalMs >= 0)
        setGeocodeIntervalMs(data.geocodeIntervalMs);
      // 訊息要把三件事講清楚:這輪做了什麼、還剩幾筆、有沒有卡在失敗退避。
      // 之前失敗是靜默的(退避直接把數字扣成 0),使用者只會覺得「地址一直沒有座標」。
      const parts = [`本次處理 ${data.processed} 筆,成功 ${data.succeeded} 筆`];
      if (data.failed > 0) parts.push(`失敗 ${data.failed} 筆(地址查不到,或外部地圖服務暫時不通)`);
      if (data.remaining <= 0) parts.push('全部補齊');
      if (data.retryingLater > 0) {
        parts.push(
          `其中 ${data.retryingLater} 筆先前失敗過,預設 24 小時後才自動再試,可按「重試失敗的」立即重跑`,
        );
      }
      const hints = (data.failureKinds ?? []).map((k) => FAILURE_HINT[k]).filter(Boolean);
      // 剩幾筆不只說數字,連「還要按幾次、大概多久」一起說(見 geocodeEta 的註解)
      const eta = geocodeEta(
        data.remaining,
        typeof data.batchMax === 'number' && data.batchMax > 0 ? data.batchMax : geocodeBatchMax,
        typeof data.geocodeIntervalMs === 'number' ? data.geocodeIntervalMs : geocodeIntervalMs,
      );
      setGeocodeMsg(
        `${parts.join(',')}。${eta ? eta + ' ' : ''}${hints.length ? hints.join(';') + '。' : ''}`,
      );
      await loadCustomers();
    } catch {
      setGeocodeMsg('補齊座標失敗,請稍後再試。');
    } finally {
      setGeocoding(false);
    }
  }

  // ---- 加入今日路線(寫進拜訪計畫;endpoint 由拜訪排程模組提供)----
  async function addToToday(c: MapCustomer) {
    if (planningId) return;
    setPlanningId(c.id);
    setPlanMsg(`正在把「${c.companyName ?? '此客戶'}」加入今日路線…`);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/crm-visit-plans`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: c.id, plannedDate: orgToday(new Date(), timezone) }),
      });
      if (res.status === 404) {
        setPlanMsg('排程功能尚未啟用,請改在客戶卡設下次拜訪日。');
        return;
      }
      if (!res.ok) {
        setPlanMsg(await apiErrorMessage(res, '加入今日路線失敗,請稍後再試。'));
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === c.id ? { ...r, plannedToday: true } : r)));
      setPlanMsg(`已把「${c.companyName ?? '此客戶'}」加入今日路線。`);
      if (scope === 'today') await loadCustomers();
    } catch {
      setPlanMsg('加入今日路線失敗,請稍後再試。');
    } finally {
      setPlanningId(null);
    }
  }

  // ---- 規劃今日路線 ----
  const routableRows = useMemo(() => rows.filter(hasCoord).slice(0, ROUTE_MAX_STOPS), [rows]);

  async function planRoute() {
    if (routing || loading) return;
    if (!me) {
      setRouteMsg('請先按「取得我的位置」,才能從你所在的位置開始規劃。');
      return;
    }
    if (routableRows.length === 0) {
      setRouteMsg('清單中沒有已有座標的客戶,請先補齊地址座標。');
      return;
    }
    setRouting(true);
    setRouteMsg('路線規劃中…');
    try {
      const res = await fetch(`${apiBase}/route`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: me.lat, lng: me.lng, ids: routableRows.map((r) => r.id) }),
      });
      if (!res.ok) {
        setRouteMsg(await apiErrorMessage(res, '路線規劃失敗,請稍後再試。'));
        return;
      }
      const data = (await res.json()) as RouteResponse;
      const order = new Map<string, number>();
      data.order.forEach((o, i) => order.set(o.id, i + 1));
      setRouteOrder(order);
      setRouteTotalM(data.totalM);
      const skipped = rows.filter(hasCoord).length - routableRows.length;
      setRouteMsg(
        `路線規劃完成,共 ${order.size} 站,總距離 ${fmtDistance(data.totalM)}。` +
          (skipped > 0 ? `一次最多 ${ROUTE_MAX_STOPS} 站,有 ${skipped} 筆未納入。` : ''),
      );
    } catch {
      setRouteMsg('路線規劃失敗,請稍後再試。');
    } finally {
      setRouting(false);
    }
  }

  function clearRoute() {
    setRouteOrder(null);
    setRouteTotalM(null);
    setRouteMsg('已清除路線。');
  }

  // ---- 清單排序:有路線照順序;否則依距離(沒座標的最後)----
  const sortedRows = useMemo(() => {
    const list = [...rows];
    list.sort((a, b) => {
      if (routeOrder) {
        const oa = routeOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
        const ob = routeOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
        if (oa !== ob) return oa - ob;
      }
      const da = a.distanceM ?? Number.POSITIVE_INFINITY;
      const db = b.distanceM ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return (a.companyName ?? '').localeCompare(b.companyName ?? '', 'zh-Hant');
    });
    return list;
  }, [rows, routeOrder]);

  // 依拜訪順序排的有座標客戶(給 polyline 與 Google 整條路線)
  const orderedStops = useMemo(() => {
    if (!routeOrder) return [] as (MapCustomer & { lat: number; lng: number })[];
    return sortedRows.filter(hasCoord).filter((r) => routeOrder.has(r.id));
  }, [sortedRows, routeOrder]);

  const mapPoints = useMemo<MapPoint[]>(
    () =>
      rows.filter(hasCoord).map((r) => ({
        id: r.id,
        name: r.companyName ?? r.taxId ?? '未命名客戶',
        lat: r.lat,
        lng: r.lng,
        color: stageMeta.colors(r.stage).fg,
        order: routeOrder?.get(r.id) ?? null,
      })),
    [rows, routeOrder, stageMeta],
  );

  const routeLatLngs = useMemo<[number, number][]>(() => {
    if (!me || orderedStops.length === 0) return [];
    return [[me.lat, me.lng], ...orderedStops.map((s) => [s.lat, s.lng] as [number, number])];
  }, [me, orderedStops]);

  // Google 整條路線連結(最多 9 個 waypoint + 終點 = 10 站)
  const googleRoute = useMemo(() => {
    if (!me || orderedStops.length === 0) return null;
    const stops = orderedStops.slice(0, GOOGLE_MAX_WAYPOINTS + 1);
    const dest = stops[stops.length - 1];
    if (!dest) return null;
    const waypoints = stops.slice(0, -1).map((s) => `${s.lat},${s.lng}`);
    let url =
      `https://www.google.com/maps/dir/?api=1&origin=${me.lat},${me.lng}` +
      `&destination=${dest.lat},${dest.lng}`;
    if (waypoints.length > 0) url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
    const truncated = orderedStops.length - stops.length;
    return { url, truncated, count: stops.length };
  }, [me, orderedStops]);

  function focusCustomer(c: MapCustomer) {
    setSelectedId(c.id);
    if (hasCoord(c)) setFocus({ lat: c.lat, lng: c.lng, nonce: Date.now() });
  }

  const noCoordCount = rows.length - rows.filter(hasCoord).length;

  // ---- 清單窗格 ----
  /** 卡片之間的間距(ol 的 gap-2 = 8px),量高度時要一起算進去 */
  const LIST_GAP_PX = 8;
  const virtualOn = sortedRows.length > LIST_VIRTUAL_MIN;
  // 每次算窗格前重新反查一次索引:清單重排之後,同一位客戶的位置會變
  const pinnedIndex = useMemo(() => {
    if (pinnedId === null) return null;
    const i = sortedRows.findIndex((r) => r.id === pinnedId);
    return i >= 0 ? i : null;
  }, [pinnedId, sortedRows]);
  const listWindow = useMemo<VirtualWindow>(() => {
    if (!virtualOn) {
      return {
        start: 0,
        end: sortedRows.length,
        padTop: 0,
        padBottom: 0,
        total: 0,
        pinned: null,
        pinnedGap: 0,
      };
    }
    return computeVirtualWindow({
      count: sortedRows.length,
      heights: sortedRows.map((r) => heights.get(r.id) ?? 0),
      estimate: LIST_ITEM_ESTIMATE_PX,
      scrollTop,
      // 還沒量到容器高度前先給一個保守值,寧可多畫幾張也不要畫不滿一頁
      viewport: viewportPx > 0 ? viewportPx : 640,
      overscan: LIST_OVERSCAN,
      pinned: pinnedIndex,
    });
  }, [virtualOn, sortedRows, heights, scrollTop, viewportPx, pinnedIndex]);

  const visibleRows = useMemo(
    () => sortedRows.slice(listWindow.start, listWindow.end),
    [sortedRows, listWindow.start, listWindow.end],
  );

  /**
   * 真正要畫的那幾張,依索引順序:窗格那一段,再加上落在窗格外的焦點那一張。
   * gapTop 是這一張之前要空掉的高度(中間沒畫出來的那些卡),用 margin 給,
   * 不用 padding —— margin 不算進 offsetHeight,量高度那一段才不會把空白算成卡片高。
   */
  const listSlots = useMemo(() => {
    const win = visibleRows.map((row, i) => ({
      row,
      index: listWindow.start + i,
      gapTop: 0,
    }));
    const p = listWindow.pinned;
    const pinnedRow = p === null ? undefined : sortedRows[p];
    if (p === null || !pinnedRow) return win;
    if (p < listWindow.start) {
      const first = win[0];
      if (first) first.gapTop = listWindow.pinnedGap;
      return [{ row: pinnedRow, index: p, gapTop: 0 }, ...win];
    }
    return [...win, { row: pinnedRow, index: p, gapTop: listWindow.pinnedGap }];
  }, [visibleRows, sortedRows, listWindow.start, listWindow.pinned, listWindow.pinnedGap]);

  // 量剛畫出來的卡片有多高:窗格換了、或量到新值就再比對一次,
  // 有變才寫回去(差 1px 以內當作沒變),所以會收斂,不會來回觸發。
  useEffect(() => {
    const changed: [string, number][] = [];
    for (const [id, el] of itemElsRef.current) {
      const h = el.offsetHeight + LIST_GAP_PX;
      const prev = heights.get(id);
      if (h > 0 && (prev === undefined || Math.abs(prev - h) > 1)) changed.push([id, h]);
    }
    if (changed.length === 0) return;
    setHeights((prev) => {
      const next = new Map(prev);
      for (const [id, h] of changed) next.set(id, h);
      return next;
    });
  }, [listSlots, heights]);

  const attachItem = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) itemElsRef.current.set(id, el);
    else itemElsRef.current.delete(id);
  }, []);

  // 焦點進到某一張卡:把那一筆釘在窗格裡,捲動時不會被卸載掉(焦點掉到 body 等於鍵盤使用者跟丟)。
  // 用原生的 focusin / focusout 而不是 React 的 onFocus / onBlur:掛在容器上的
  // onFocus 會被 jsx-a11y 當成「給非互動元素掛鍵盤事件」擋下來,而這裡要的只是
  // 「知道焦點跑到哪一張卡」,不是把 div 變成一個控制項。
  const onFocusIn = useCallback((e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    const li = target?.closest('li[data-customer-id]');
    setPinnedId(li?.getAttribute('data-customer-id') ?? null);
  }, []);
  const onFocusOut = useCallback((e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && listRef.current?.contains(next)) return;
    setPinnedId(null);
  }, []);

  const attachList = useCallback(
    (el: HTMLDivElement | null) => {
      const prev = listRef.current;
      if (prev) {
        prev.removeEventListener('focusin', onFocusIn);
        prev.removeEventListener('focusout', onFocusOut);
      }
      listRef.current = el;
      if (el) {
        el.addEventListener('focusin', onFocusIn);
        el.addEventListener('focusout', onFocusOut);
        setViewportPx(el.clientHeight);
        setScrollTop(el.scrollTop);
      }
    },
    [onFocusIn, onFocusOut],
  );

  const onListScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = listRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      setViewportPx(el.clientHeight);
    });
  }, []);

  useEffect(() => {
    const onResize = () => {
      const el = listRef.current;
      if (el) setViewportPx(el.clientHeight);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // 目前走到第幾步:沒定位就是第一步;定位了但清單沒人就是第二步;有人還沒規劃是第三步;規劃完是第四步
  const currentStep = !me ? 1 : rows.length === 0 ? 2 : !routeOrder ? 3 : 4;

  // ---- render ----
  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">拜訪地圖</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用外勤拜訪。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold">拜訪地圖</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          取得你的位置後,附近的開發中客戶會依距離排序,可規劃今日路線並用 Google 地圖導航。
        </p>
      </div>

      {/* 四步驟引導:目前這步用文字與 aria-current 標示,不只靠顏色 */}
      {/* ol 本身就是 role=list,不再寫 role(jsx-a11y/no-redundant-roles) */}
      <ol
        aria-label="拜訪四步驟"
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
      >
        {GUIDE_STEPS.map((st, i) => {
          const n = i + 1;
          const isCurrent = n === currentStep;
          const isDone = n < currentStep;
          return (
            <li
              key={st.title}
              aria-current={isCurrent ? 'step' : undefined}
              className="rounded-md border bg-surface p-2 text-sm"
              style={{
                borderColor: isCurrent ? 'var(--primary)' : undefined,
                borderWidth: isCurrent ? 2 : 1,
              }}
            >
              <p className="font-semibold text-foreground">
                {st.title}
                {isCurrent && (
                  <span className="ml-1 font-normal text-foreground">(目前在第 {n} 步)</span>
                )}
                {isDone && <span className="ml-1 font-normal text-muted-foreground">(已完成)</span>}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{st.hint}</p>
            </li>
          );
        })}
      </ol>

      {/* 工具列 */}
      <section
        className="mt-4 rounded-lg border border-border bg-surface p-3"
        aria-label="地圖工具列"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={locate} aria-busy={locating}>
            {locating ? '定位中…' : '取得我的位置'}
          </button>

          <fieldset className="flex items-center gap-1 rounded-md border border-border p-1">
            <legend className="sr-only">顯示範圍</legend>
            <button
              type="button"
              className={`btn ${scope === 'today' ? 'btn-primary' : ''}`}
              aria-pressed={scope === 'today'}
              onClick={() => setScope('today')}
            >
              今日要拜訪
            </button>
            <button
              type="button"
              className={`btn ${scope === 'all' ? 'btn-primary' : ''}`}
              aria-pressed={scope === 'all'}
              onClick={() => setScope('all')}
            >
              全部開發中
            </button>
          </fieldset>

          <button
            type="button"
            className="btn"
            onClick={() => void geocode()}
            aria-busy={geocoding}
          >
            {geocoding ? '處理中…' : `補齊地址座標(還有 ${pendingGeocode} 筆)`}
          </button>

          {/* 重試出口:先前失敗的客戶預設要等 24 小時才會再試,外部地圖服務暫時不通時
              整批都會卡在退避,沒有這顆就只能乾等,而且畫面會看起來像功能壞了。
              只在真的還有客戶沒有座標時才出現,平常不佔位。 */}
          {pendingGeocode > 0 ? (
            <button
              type="button"
              className="btn"
              onClick={() => void geocode(true)}
              aria-busy={geocoding}
            >
              {geocoding ? '處理中…' : '重試失敗的'}
            </button>
          ) : null}

          <button
            type="button"
            className="btn"
            onClick={() => void planRoute()}
            aria-busy={routing}
          >
            {routing ? '規劃中…' : '規劃今日路線'}
          </button>
          {routeOrder && (
            <button type="button" className="btn" onClick={clearRoute}>
              清除路線
            </button>
          )}
        </div>

        {/* 狀態訊息:一律 role=status,螢幕閱讀器會念出 */}
        <div className="mt-2 flex flex-col gap-1 text-sm">
          <p role="status" aria-live="polite" className="min-h-[1.25rem] text-muted-foreground">
            {geoMsg ??
              (me
                ? `我的位置:${me.lat.toFixed(5)}, ${me.lng.toFixed(5)}`
                : '尚未定位,清單以後端順序顯示。')}
            {me && meAddress && <span className="ml-2 text-foreground">{meAddress}</span>}
          </p>
          <p role="status" aria-live="polite" className="min-h-[1.25rem] text-muted-foreground">
            {planMsg ?? ''}
          </p>
          <p role="status" aria-live="polite" className="min-h-[1.25rem] text-muted-foreground">
            {geocodeMsg ??
              (pendingGeocode > 0
                ? `可按「補齊地址座標」。${geocodeEta(pendingGeocode, geocodeBatchMax, geocodeIntervalMs)}`
                : '')}
          </p>
          <p role="status" aria-live="polite" className="min-h-[1.25rem] text-muted-foreground">
            {routeMsg ?? ''}
          </p>
          {routeOrder && routeTotalM !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">
                今日路線 {orderedStops.length} 站,總距離 {fmtDistance(routeTotalM)}
              </span>
              {googleRoute && (
                <a
                  className="btn"
                  href={googleRoute.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`用 Google 地圖開整條路線(共 ${googleRoute.count} 站,另開新視窗)`}
                >
                  用 Google 地圖開整條路線
                </a>
              )}
              {googleRoute && googleRoute.truncated > 0 && (
                <span role="status" className="text-muted-foreground">
                  Google 地圖一次最多 {GOOGLE_MAX_WAYPOINTS} 個中途點,連結只含前 {googleRoute.count}{' '}
                  站,其餘 {googleRoute.truncated} 站請用清單逐站導航。
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-foreground"
        >
          {error}
        </div>
      )}

      {/* 地圖 + 清單:手機上下、桌機左右 */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-h-[50vh] lg:min-h-[70vh]">
          <VisitMap
            me={me}
            points={mapPoints}
            routeLatLngs={routeLatLngs}
            focus={focus}
            onSelect={(id) => {
              const c = rows.find((r) => r.id === id);
              if (c) focusCustomer(c);
            }}
          />
        </div>

        <section
          aria-labelledby="nearby-heading"
          className="rounded-lg border border-border bg-surface p-3"
        >
          <h2 id="nearby-heading" className="text-base font-semibold">
            附近客戶
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              共 {rows.length} 筆{noCoordCount > 0 ? `,${noCoordCount} 筆尚無座標` : ''}
            </span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            此清單包含地圖上的全部資訊。點客戶名稱可把地圖移到該點;
            {routeOrder ? '目前依拜訪順序排列。' : '目前依距離由近到遠排列,沒有座標的排在最後。'}
          </p>
          {virtualOn && sortedRows.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              清單共 {sortedRows.length} 筆,畫面上一次只放第 {listWindow.start + 1} 到{' '}
              {listWindow.end} 筆
              {listWindow.pinned !== null
                ? `,另外保留焦點所在的第 ${listWindow.pinned + 1} 筆`
                : ''}
              ,捲動就會接上其餘的。用 Tab 進到清單後,方向鍵、Page Up / Page Down 都可以捲動。
            </p>
          ) : null}

          {/* 重新載入時清單留在畫面上,不換成「載入中…」。
              整份換掉的話,焦點所在的那一張卡跟著卸載,焦點掉回 body ——
              進頁面自動補完座標會重載一次,鍵盤使用者當場跟丟。
              第一次載入(還沒有任何一筆)才顯示載入中,那時沒有東西可以留。 */}
          {loading && sortedRows.length === 0 ? (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              載入中…
            </p>
          ) : sortedRows.length === 0 ? (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              {scope === 'today'
                ? '還沒有客戶排到今天,勾選下面清單的「加入今日路線」,或到客戶卡設下次拜訪日。'
                : '目前沒有進行中的客戶。'}
            </p>
          ) : (
            /* 捲動容器是外面這個 div(tabIndex=0,鍵盤進得來、方向鍵捲得動),
               <ol> 維持乾淨的清單語意,只用上下 padding 佔掉沒畫出來的那些卡的位置 */
            <div
              ref={attachList}
              onScroll={virtualOn ? onListScroll : undefined}
              tabIndex={virtualOn ? 0 : undefined}
              role="group"
              // 重新載入時清單還在,但內容可能正在換,要讓輔助科技知道
              aria-busy={loading}
              aria-label={`附近客戶清單,共 ${sortedRows.length} 筆,可捲動`}
              className="mt-3 max-h-[70vh] overflow-y-auto pr-1"
            >
              <ol
                className="flex flex-col gap-2"
                style={
                  virtualOn
                    ? { paddingTop: listWindow.padTop, paddingBottom: listWindow.padBottom }
                    : undefined
                }
              >
                {listSlots.map(({ row: c, index, gapTop }) => {
                  const color = stageMeta.colors(c.stage);
                  const order = routeOrder?.get(c.id) ?? null;
                  const coord = hasCoord(c);
                  const overdue = isOverdue(c.nextFollowUpAt);
                  const selected = selectedId === c.id;
                  return (
                    <li
                      key={c.id}
                      ref={(el) => attachItem(c.id, el)}
                      data-index={index}
                      data-customer-id={c.id}
                      // 畫面上只有一部分的卡片,所以「這是第幾筆、總共幾筆」要自己講,
                      // 不能讓螢幕閱讀器從 DOM 裡數(它只數得到窗格裡的那十幾張)
                      aria-setsize={virtualOn ? sortedRows.length : undefined}
                      aria-posinset={virtualOn ? index + 1 : undefined}
                      className="rounded-md border bg-background p-2"
                      style={{
                        borderColor: selected ? 'var(--primary)' : color.fg,
                        borderWidth: selected ? 2 : 1,
                        // 焦點那一張跟窗格之間差掉的高度。margin 不進 offsetHeight,
                        // 所以量卡片高度那一段不會被這格空白汙染
                        marginTop: gapTop > 0 ? gapTop : undefined,
                      }}
                      aria-current={selected ? 'true' : undefined}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {order !== null && (
                          <span
                            className="inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-sm font-bold"
                            style={{ backgroundColor: color.fg, color: 'var(--bg-card)' }}
                            aria-label={`第 ${order} 站`}
                          >
                            {order}
                          </span>
                        )}
                        <button
                          type="button"
                          className="min-h-[44px] flex-1 text-left text-sm font-semibold text-foreground underline-offset-2 hover:underline"
                          onClick={() => focusCustomer(c)}
                          aria-label={`${c.companyName ?? c.taxId ?? '未命名客戶'}${coord ? ',在地圖上顯示' : ',尚無座標'}`}
                        >
                          {c.companyName ?? c.taxId ?? '未命名客戶'}
                        </button>
                        <span
                          className="badge border"
                          style={{
                            backgroundColor: color.bg,
                            borderColor: color.fg,
                            color: color.fg,
                          }}
                        >
                          {stageMeta.label(c.stage)}
                        </span>
                      </div>

                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <dt>距離</dt>
                        <dd className="text-foreground">
                          {coord
                            ? me
                              ? fmtDistance(c.distanceM) || '未知'
                              : '請先取得我的位置'
                            : '尚無座標,請補齊'}
                        </dd>
                        <dt>地址</dt>
                        <dd className="text-foreground">{c.address || '—'}</dd>
                        <dt>下次跟進</dt>
                        <dd className="text-foreground">
                          {fmtDate(c.nextFollowUpAt)}
                          {overdue && <span className="badge badge-danger ml-1">逾期</span>}
                        </dd>
                        {(c.contactName || c.contactPhone) && (
                          <>
                            <dt>聯絡人</dt>
                            <dd className="text-foreground">
                              {c.contactName || '—'}
                              {c.contactPhone && (
                                <>
                                  {' '}
                                  <a className="underline" href={`tel:${c.contactPhone}`}>
                                    {c.contactPhone}
                                  </a>
                                </>
                              )}
                            </dd>
                          </>
                        )}
                        {c.owner && (
                          <>
                            <dt>承辦人員</dt>
                            <dd className="text-foreground">{c.owner.name}</dd>
                          </>
                        )}
                      </dl>

                      <div className="mt-2 flex flex-wrap gap-2">
                        <a
                          className="btn"
                          href={navUrl(c)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Google 導航到 ${c.companyName ?? '此客戶'}(另開新視窗)`}
                        >
                          Google 導航
                        </a>
                        <Link className="btn" href={`/admin/crm/${c.id}`}>
                          客戶卡
                        </Link>
                        <label
                          htmlFor={`plan-${c.id}`}
                          className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-foreground"
                        >
                          <input
                            id={`plan-${c.id}`}
                            type="checkbox"
                            className="h-[18px] w-[18px] shrink-0"
                            checked={c.plannedToday === true}
                            disabled={c.plannedToday === true || planningId !== null}
                            onChange={(e) => {
                              if (e.target.checked) void addToToday(c);
                            }}
                          />
                          <span className="sr-only">
                            把{c.companyName ?? c.taxId ?? '未命名客戶'}加入今日路線
                            {c.plannedToday === true ? ',已在今日路線' : ''}
                          </span>
                          <span aria-hidden="true">
                            {c.plannedToday === true ? '已在今日路線' : '加入今日路線'}
                          </span>
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
