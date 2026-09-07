'use client';

// 拜訪地圖本體(Leaflet + OpenStreetMap 圖磚)。
// 只負責畫圖:我的位置、客戶圓點(顏色=階段、數字=拜訪順序)、路線 polyline、flyTo。
// 一定要透過 next/dynamic({ ssr: false }) 載入,因為 leaflet 會直接碰 window。
// 無障礙:地圖是 role="region",完整資訊由頁面的「附近客戶」清單提供替代。
//
// 客戶點怎麼畫(兩種,理由是資料量):
//   管理員切到「全部開發中」時客戶點是兩千級距。每一個點都做成 DivIcon marker 的話,
//   一個點就是三個 DOM 節點加一個 click listener,兩千點就是六千個節點在圖層上,
//   而外勤是拿手機在跑的。所以:
//     沒有拜訪順序的點,用 L.circleMarker 畫在同一張 canvas 上(renderer 只有一個),
//       不產生任何 DOM 節點;click 只掛在 featureGroup 上一個(Leaflet 會把子圖層的
//       事件冒泡上來),不是每個點一個。
//     有拜訪順序的點,仍然是 DivIcon marker(要顯示站號數字),但那是規劃後的路線,
//       上限就是 map/page.tsx 的 ROUTE_MAX_STOPS,不會膨脹。
//   canvas renderer 的 tolerance 設成讓命中區補到 44px(見 HIT_TOLERANCE)。
//   圓點本身不是鍵盤焦點(canvas 沒有子節點可以聚焦),鍵盤與螢幕閱讀器走
//   「附近客戶」清單那條等價路徑,那份清單本來就是這張圖的文字替代;
//   兩千個 marker 全部可聚焦也等於兩千個 Tab 停留點,對鍵盤使用者不是好事。
// 點的增刪改用比對的(drawnRef),不是每次 clearLayers() 重畫:
//   換主題、拿到定位都會讓這個元件重跑,以前那樣寫等於整批兩千個點重建。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useAppSettings } from '@/lib/app-settings';

export interface MapPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** 圓點底色(階段色) */
  color: string;
  /** 拜訪順序(規劃路線後才有) */
  order: number | null;
}

export interface FocusTarget {
  lat: number;
  lng: number;
  /** 每次要 flyTo 就換一個新值,避免同一點連點兩次沒反應 */
  nonce: number;
}

interface VisitMapProps {
  me: { lat: number; lng: number } | null;
  points: MapPoint[];
  /** 依拜訪順序排列的路線座標(含起點「我的位置」),沒有規劃就給空陣列 */
  routeLatLngs: [number, number][];
  focus: FocusTarget | null;
  onSelect?: (id: string) => void;
}

// 還沒定位、也沒客戶座標時的預設視角,來自系統設定的
// 「拜訪地圖預設緯度 / 經度 / 縮放層級」(/admin/settings 的地圖分頁)。
// 這裡以前寫死台灣中心點 [23.7, 121.0],結果是那三格設定改了完全沒有作用,
// 而設在別的國家的組織每次打開地圖都要先自己拖到對的地方。
// 定位成功與點客戶都拉到 17,這個層級看得到路名與門牌,外勤才知道自己在哪條路
const STREET_ZOOM = 17;

// canvas 上圓點的半徑(CSS 像素)。直徑 26px。
const DOT_RADIUS = 13;
// canvas renderer 的命中容差:圓點直徑 26 + 兩側各 9 = 44,補到 2.5.5 AAA 的 44×44。
// 這一格是 Leaflet 的 L.Canvas 選項(見 leaflet 的 tolerance),不是我們自己算命中。
const HIT_TOLERANCE = 9;

// Leaflet 的 DivIcon / Polyline 走 innerHTML 與 JS 選項,不是 CSS,所以 var(--x) 不見得吃得到,
// 這裡統一從 <html> 的 computed style 取出 token 實際值。取不到(SSR、測試環境)就回傳空字串,
// 由呼叫端給保底色。主題切換時要重新取值並重畫,見下方的 useThemeToken。
function cssToken(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 把 var(--x) 或 var(--x, fallback) 形式的值換成實際色碼;已經是色碼就原樣回傳。 */
function resolveColor(value: string, fallback: string): string {
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(value.trim());
  if (!m) return value;
  const name = m[1] ?? '';
  return cssToken(name) || (m[2]?.trim() ?? '') || fallback;
}

/** 主題色:--primary(我的位置與路線)、--bg-card(圓點的框與數字,深色模式會跟著變深) */
interface MapTheme {
  primary: string;
  onColor: string;
}

function readTheme(): MapTheme {
  return {
    primary: cssToken('--primary') || '#084349',
    onColor: cssToken('--bg-card') || '#FFFFFF',
  };
}

/**
 * 追蹤主題:<html> 的 data-theme / data-scheme 換了、或系統 prefers-color-scheme 換了,
 * 就重讀一次 token,讓 marker 與路線重畫。
 */
function useMapTheme(): MapTheme {
  const [theme, setTheme] = useState<MapTheme>(() => readTheme());
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-scheme', 'class', 'style'],
    });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      mq.removeEventListener('change', sync);
    };
  }, []);
  return theme;
}

// 客戶圓點:外框 44×44 是命中區(2.5.5 AAA),中間 30px 實心圓 + --bg-card 色的框與數字。
// color 由 map/page.tsx 傳入 STAGE_COLORS 的 fg(--st-*-fg),淺色模式是深字色、深色模式是亮字色,
// 兩邊對 --bg-card 都 >= 7:1,所以數字用 --bg-card 而不是寫死白色。
function customerIcon(color: string, onColor: string, order: number | null): L.DivIcon {
  const label = order === null ? '' : String(order);
  const fill = resolveColor(color, onColor === '#FFFFFF' ? '#333333' : '#CCCCCC');
  return L.divIcon({
    className: 'visit-map-marker',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html:
      `<span style="display:flex;width:44px;height:44px;align-items:center;justify-content:center;">` +
      `<span style="display:flex;width:30px;height:30px;border-radius:9999px;background:${fill};` +
      `border:2px solid ${onColor};box-shadow:0 0 0 1px ${fill};color:${onColor};font-size:13px;font-weight:700;` +
      `line-height:1;align-items:center;justify-content:center;">${label}</span></span>`,
  });
}

// 我的位置:--primary 實心圓 + --bg-card 色外框
function meIcon(theme: MapTheme): L.DivIcon {
  return L.divIcon({
    className: 'visit-map-marker',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html:
      `<span style="display:flex;width:44px;height:44px;align-items:center;justify-content:center;">` +
      `<span style="display:block;width:20px;height:20px;border-radius:9999px;background:${theme.primary};` +
      `border:3px solid ${theme.onColor};box-shadow:0 0 0 2px ${theme.primary};"></span></span>`,
  });
}

/** 一個客戶點目前畫成什麼樣子。sig 一樣就不用動它。 */
interface DrawnPoint {
  layer: L.CircleMarker | L.Marker;
  /** 位置、顏色、站號、主題色的指紋 */
  sig: string;
  /** true = 有站號的 DivIcon marker;false = canvas 圓點 */
  numbered: boolean;
}

/** 這個點目前該長什麼樣的指紋。變了才需要動 Leaflet。 */
function pointSig(p: MapPoint, onColor: string): string {
  return `${p.lat}|${p.lng}|${p.color}|${p.order ?? ''}|${onColor}`;
}

export default function VisitMap({ me, points, routeLatLngs, focus, onSelect }: VisitMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // 沒有站號的客戶點:全部畫在同一張 canvas 上,click 只掛一個在群組上
  const dotLayerRef = useRef<L.FeatureGroup | null>(null);
  // 有站號的客戶點:DivIcon marker(數量上限是路線站數)
  const numberedLayerRef = useRef<L.LayerGroup | null>(null);
  const rendererRef = useRef<L.Canvas | null>(null);
  // 滑鼠移過 canvas 圓點時借用的同一個 tooltip,不是每個點各配一個
  const tooltipRef = useRef<L.Tooltip | null>(null);
  const drawnRef = useRef<Map<string, DrawnPoint>>(new Map());
  const layerIdRef = useRef<WeakMap<L.Layer, string>>(new WeakMap());
  const meMarkerRef = useRef<L.Marker | null>(null);
  const routeRef = useRef<L.Polyline | null>(null);
  const theme = useMapTheme();
  const settings = useAppSettings();
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // id → 顯示名稱,給共用 tooltip 用(canvas 圓點沒有 DOM,掛不了 title)
  const namesRef = useRef<Map<string, string>>(new Map());
  // 建圖只做一次,所以初始視角用 ref 記下第一次拿到的設定值:
  // 相依陣列放 settings 的話,設定重新整理會把使用者拖到的位置彈回預設中心
  const initialViewRef = useRef<{ center: [number, number]; zoom: number }>({
    center: [settings.mapDefaultLat, settings.mapDefaultLng],
    zoom: settings.mapDefaultZoom,
  });
  // 圖磚網址也只在建圖時取一次:設定重新整理不該把圖層抽換掉
  const tileUrlRef = useRef(settings.mapTileUrl);

  // 建立地圖(只做一次)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // cleanup 時要清的是這一份,先抓成區域變數(ref.current 在那時候可能已經換掉了)
    const drawn = drawnRef.current;
    const map = L.map(containerRef.current, {
      center: initialViewRef.current.center,
      zoom: initialViewRef.current.zoom,
      // 減少動態效果:尊重 prefers-reduced-motion(2.3.3 AAA)
      zoomAnimation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    // 圖磚網址來自系統設定(/admin/settings 的地圖分頁),預設是公共 OSM 圖磚。
    // 圖磚由瀏覽器直接向該網址請求,會把 IP 與檢視座標範圍送給對方,所以做成可設定,
    // 自架或改用相容服務時不必改 code。取初始值用 ref,理由同上方的視角。
    L.tileLayer(tileUrlRef.current, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    // 圓點全部畫在這一張 canvas 上;padding 讓視野外一點的點也先畫好,拖動時不會空一塊
    const renderer = L.canvas({ padding: 0.3, tolerance: HIT_TOLERANCE });
    rendererRef.current = renderer;
    const dots = L.featureGroup().addTo(map);
    // 事件掛在群組上一個就好:Leaflet 會把子圖層的事件冒泡上來(propagatedFrom 就是被點的那一層)。
    // 兩千個點各掛一個 handler 的話,光是註冊就要跑兩千次。
    dots.on('click', (e: L.LeafletEvent) => {
      const id = layerIdRef.current.get(e.propagatedFrom as L.Layer);
      if (id) onSelectRef.current?.(id);
    });
    const tooltip = L.tooltip({ direction: 'top', offset: [0, -DOT_RADIUS] });
    tooltipRef.current = tooltip;
    dots.on('mouseover', (e: L.LeafletEvent) => {
      const layer = e.propagatedFrom as L.CircleMarker | undefined;
      const name = layer ? namesRef.current.get(layerIdRef.current.get(layer) ?? '') : undefined;
      if (!layer || !name) return;
      tooltip.setContent(name).setLatLng(layer.getLatLng()).openOn(map);
    });
    dots.on('mouseout', () => map.closeTooltip(tooltip));
    dotLayerRef.current = dots;
    numberedLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      dotLayerRef.current = null;
      numberedLayerRef.current = null;
      rendererRef.current = null;
      tooltipRef.current = null;
      drawn.clear();
      meMarkerRef.current = null;
      routeRef.current = null;
    };
  }, []);

  // 我的位置
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (meMarkerRef.current) {
      meMarkerRef.current.remove();
      meMarkerRef.current = null;
    }
    if (!me) return;
    meMarkerRef.current = L.marker([me.lat, me.lng], {
      icon: meIcon(theme),
      title: '我的位置',
      zIndexOffset: 1000,
    }).addTo(map);
    map.setView([me.lat, me.lng], STREET_ZOOM);
  }, [me, theme]);

  // 客戶點:只動有變的那幾個(新增、刪除、顏色或站號變了),其餘原封不動。
  // me 不在相依裡:拿到定位不會改變任何一個點,以前放進去等於定位一次全部重建。
  useEffect(() => {
    const dots = dotLayerRef.current;
    const numbered = numberedLayerRef.current;
    const renderer = rendererRef.current;
    if (!dots || !numbered || !renderer) return;
    const drawn = drawnRef.current;
    const names = namesRef.current;
    const seen = new Set<string>();

    for (const p of points) {
      seen.add(p.id);
      const title = p.order === null ? p.name : `第 ${p.order} 站:${p.name}`;
      names.set(p.id, title);
      const sig = pointSig(p, theme.onColor);
      const want = p.order !== null;
      const old = drawn.get(p.id);
      // 有站號的 marker 是 DivIcon,title 就是它的無障礙名稱(Leaflet marker 預設
      // keyboard:true,它是 Tab 停留點)。名稱不進 sig(位置、顏色、站號都沒變的話
      // 沒必要重建整個 marker),所以改了公司名之後在這裡就地補寫,
      // 不然那顆 marker 會一直唸著舊名稱,而旁邊清單唸的是新的。
      // 沒有站號的 canvas 圓點沒有 DOM 節點,名稱走上面的 names(每一輪都重寫),不必處理。
      if (old?.numbered) {
        const marker = old.layer as L.Marker;
        if (marker.options.title !== title) {
          marker.options.title = title;
          marker.getElement()?.setAttribute('title', title);
        }
      }
      if (old && old.sig === sig) continue;
      if (old && old.numbered === want && !want) {
        // 還是 canvas 圓點,只是顏色或位置變了:改樣式就好,不要重建
        const dot = old.layer as L.CircleMarker;
        dot.setLatLng([p.lat, p.lng]);
        dot.setStyle({
          color: theme.onColor,
          fillColor: resolveColor(p.color, theme.onColor === '#FFFFFF' ? '#333333' : '#CCCCCC'),
        });
        drawn.set(p.id, { layer: dot, sig, numbered: false });
        continue;
      }
      if (old) {
        (old.numbered ? numbered : dots).removeLayer(old.layer);
      }
      if (want) {
        const m = L.marker([p.lat, p.lng], {
          icon: customerIcon(p.color, theme.onColor, p.order),
          title,
        });
        // Leaflet 的 marker 預設 keyboard:true(tabindex=0,Enter 會觸發 click),鍵盤可操作
        m.on('click', () => onSelectRef.current?.(p.id));
        numbered.addLayer(m);
        layerIdRef.current.set(m, p.id);
        drawn.set(p.id, { layer: m, sig, numbered: true });
      } else {
        const dot = L.circleMarker([p.lat, p.lng], {
          renderer,
          radius: DOT_RADIUS,
          weight: 2,
          color: theme.onColor,
          fillColor: resolveColor(p.color, theme.onColor === '#FFFFFF' ? '#333333' : '#CCCCCC'),
          fillOpacity: 1,
          // 圓點不進無障礙樹(canvas 畫的東西本來就沒有節點),替代路徑是「附近客戶」清單
          interactive: true,
        });
        dots.addLayer(dot);
        layerIdRef.current.set(dot, p.id);
        drawn.set(p.id, { layer: dot, sig, numbered: false });
      }
    }

    for (const [id, entry] of drawn) {
      if (seen.has(id)) continue;
      (entry.numbered ? numbered : dots).removeLayer(entry.layer);
      drawn.delete(id);
      names.delete(id);
    }
  }, [points, theme]);

  // 還沒定位時,把視角拉到所有客戶點(換主題不該重算視角,所以跟上面分開)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (me || points.length === 0) return;
    map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), {
      padding: [32, 32],
      maxZoom: 15,
    });
  }, [points, me]);

  // 路線
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (routeRef.current) {
      routeRef.current.remove();
      routeRef.current = null;
    }
    if (routeLatLngs.length < 2) return;
    routeRef.current = L.polyline(routeLatLngs, {
      color: theme.primary,
      weight: 4,
      opacity: 0.85,
    }).addTo(map);
    map.fitBounds(routeRef.current.getBounds(), { padding: [32, 32] });
  }, [routeLatLngs, theme]);

  // flyTo
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const zoom = STREET_ZOOM;
    if (reduce) map.setView([focus.lat, focus.lng], zoom);
    else map.flyTo([focus.lat, focus.lng], zoom);
  }, [focus]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="拜訪地圖"
      className="h-full min-h-[50vh] w-full rounded-lg border border-border"
    />
  );
}
