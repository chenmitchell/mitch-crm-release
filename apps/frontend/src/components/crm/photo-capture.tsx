'use client';

// 外勤拜訪「拍照存證」元件(外勤打卡頁與客戶卡共用)。
// 功能:
//   1. GET /api/admin/crm-checkin/:customerId/photos 畫「存證清單」:依客戶場所類型列出必拍的類型,
//      每種一格(已拍顯示縮圖、時間、拍攝者,可重拍、刪除;未拍顯示「尚未拍攝」與拍照按鈕),另有「其他照片」可多張。
//   2. 拍照入口:手機用 <input type="file" accept="image/*" capture="environment">(Android / iOS 直接開相機);
//      電腦(有 getUserMedia 且 pointer: fine)提供「開啟鏡頭」即時預覽 + 「拍下」;兩者都留「選擇檔案」備援。
//   3. 影像走 @/lib/photo-watermark(EXIF 轉正、長邊 ≤1280、浮水印、JPEG 0.72,超過約 410KB 降級),處理完先預覽,
//      業務按「確認使用」才算數。
//   4. mode="checkin":確認後放進待上傳清單,透過 onChange 交給外層隨打卡一起送(POST /api/admin/crm-checkin/:customerId 的 photos 欄位)。
//      mode="standalone":確認後立刻 POST /api/admin/crm-checkin/:customerId/photos,成功後重新載入清單。
//   5. 刪除走 DELETE /api/admin/crm-checkin/photo/:photoId,元件內二次確認;403 = 不是拍攝者本人也不是主管,
//      400 = 後端擋下(例如客戶已結案),直接顯示後端的中文說明;404 = 找不到客戶或沒有權限。
//   6. checkin 模式會累計待上傳照片的總 bytes,超過 3MB 就不讓「確認使用」再加,顯示「已選 N 張,共 X MB」。
// 離線:上傳失敗時預覽原本只留在 React state 裡,關掉分頁或系統回收記憶體那張存證照片就沒了。
//   現在 standalone 模式送不出去會把照片寫進 IndexedDB 的「待送出」(見 lib/offline-queue),
//   保留原始拍攝時間,回到有網路的地方在「GPS 到訪打卡」頁按「全部重送」。
//   checkin 模式的照片由外層打卡頁一起存進同一個佇列。
// 時間:優先 GET /api/public/settings 的 serverTime + performance.now() 單調推進,抓不到才用裝置時間並在浮水印標「(裝置時間)」。
// 座標:外層可用 position 傳入;沒傳就在拍照時自己定位一次(失敗寫「未定位」,不擋拍照)。
// 無障礙:每格是 <li>、縮圖有 alt、所有按鈕 .btn(≥44px)、狀態 role="status" aria-live、video 有 aria-label、鍵盤可操作。
// 焦點:開鏡頭後焦點到「拍下」、預覽時到「確認使用」、流程結束回該格的入口按鈕;刪除確認列出現時到「確定刪除」、取消回「刪除」。
//   送出中的按鈕不用 disabled(會把焦點丟到 body),改 aria-busy + handler 早退。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import {
  fmtBytes,
  fmtOrgTime,
  photoDataUrl,
  watermarkPhoto,
  type WatermarkResult,
} from '@/lib/photo-watermark';
import {
  STAGE_KEY_PATTERN,
  labelOf,
  useAppSettings,
  useCrmVocab,
  usePhotoKindLabel,
  useServerNow,
} from '@/lib/app-settings';
import { useMe } from '@/lib/me-context';
import {
  isNetworkError,
  reportNetworkFailure,
  reportNetworkSuccess,
  useNetworkState,
} from '@/lib/network-status';
import { enqueue, ownerKeyOf } from '@/lib/offline-queue';

/**
 * 照片類型的 key(對應後端 visit_photo_kinds 主檔的代碼)。
 * 有哪些種類、顯示什麼中文都不寫在這裡 —— 檢查表由後台設定維護,見 lib/app-settings.tsx。
 */
export type PhotoKind = string;

/** 打卡 / 補拍時送給後端的照片格式 */
export interface PendingPhoto {
  kind: PhotoKind;
  mime: 'image/jpeg';
  base64: string;
  takenAt: string;
}

export interface PhotoPosition {
  lat: number;
  lng: number;
  accuracy?: number | null;
}

export interface PhotoCaptureProps {
  customerId: string;
  /** 客戶公司名(浮水印第一行、縮圖 alt) */
  customerName: string;
  /** 業務姓名、職稱(浮水印第二行) */
  salesName: string;
  salesTitle: string;
  /** 乙方公司名(浮水印中央淡蓋) */
  companyName: string;
  /** checkin:照片先留在元件內,經 onChange 交給外層隨打卡送出;standalone:每張確認後立刻上傳 */
  mode: 'checkin' | 'standalone';
  /** 待上傳清單有變動時呼叫(checkin 模式);請用 useCallback 包住 */
  onChange?: (pending: PendingPhoto[]) => void;
  /** 外層已取得的座標;undefined = 元件自己定位,null = 明確沒有座標 */
  position?: PhotoPosition | null;
  /** 外層改這個值就清空待上傳清單並重新載入存證清單(例如打卡成功後) */
  reloadKey?: number;
  /** 外層送出中時設 true,元件會停用所有按鈕 */
  disabled?: boolean;
}

interface ServerPhoto {
  id: string;
  kind: PhotoKind;
  takenAt: string;
  interactionId: string;
  byName: string;
  sizeBytes: number;
}

interface PhotoList {
  /** 場所類型代碼。合法值由後台的場所類型主檔決定,不是寫死的兩個 */
  premisesType: string | null;
  premisesTypeMissing: boolean;
  required: PhotoKind[];
  photos: ServerPhoto[];
  missing: PhotoKind[];
}

/** 元件內待上傳的一張(含預覽;dataUrl 建立時算一次,不在每次 render 重拼) */
interface LocalPhoto {
  localId: string;
  kind: PhotoKind;
  result: WatermarkResult;
  dataUrl: string;
}

/** 進行中的拍照流程(一次只允許一格);preview 的 dataUrl 同樣只算一次 */
type Capture =
  | { kind: PhotoKind; stage: 'camera'; replaceId: string | null }
  | { kind: PhotoKind; stage: 'processing'; replaceId: string | null; cameraOpen: boolean }
  | {
      kind: PhotoKind;
      stage: 'preview';
      replaceId: string | null;
      cameraOpen: boolean;
      result: WatermarkResult;
      dataUrl: string;
    }
  | { kind: PhotoKind; stage: 'uploading'; replaceId: string | null };

/** 每格入口按鈕的 ref 鍵:kind + 要取代的照片 id(沒有就空字串) */
function slotKey(kind: PhotoKind, replaceId: string | null): string {
  return `${kind}:${replaceId ?? ''}`;
}

/**
 * 照片種類是後台可以增減的資料(visit_photo_kinds 主檔),不是寫死的清單。
 *
 * 這裡曾經有一份寫死的六種代碼,註解還說是「後端 enum 的值」——
 * 那個 enum 早就改成資料表了。後果是管理員新增一個「電表」之後,
 * 存證清單列得出這一項、拍照元件卻找不到那一格,缺件就永遠擋著結案。
 * 現在種類一律由 useAppSettings() 的 photoChecklist 推導。
 */
const OTHER_PHOTO_KIND = 'other';

/**
 * 伺服器回來的種類代碼只驗格式,不比對清單。
 *
 * 拿清單當白名單的話,後台停用過的種類(歷史照片還掛在上面)會被整批濾掉,
 * 畫面上那些照片直接消失,而且沒有任何訊息。格式與後台的代碼規則同一條。
 */
function isKind(v: unknown): v is PhotoKind {
  return typeof v === 'string' && STAGE_KEY_PATTERN.test(v);
}
/** 沒有 position prop 時自己定位的快取時間(毫秒) */
const OWN_FIX_MAX_AGE_MS = 60 * 1000;
/** 元件內最多留幾張待上傳(後端一次收 ≤8 張) */
const MAX_PENDING = 8;
/** 待上傳照片總量上限(bytes):超過就擋「確認使用」,避免一次打卡的 request body 過大 */
const MAX_PENDING_BYTES = 3 * 1024 * 1024;

/** ISO → 組織時區的時間字串(帶時區標示);壞掉的字串原樣顯示 */
function fmtIso(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? fmtOrgTime(ms, timeZone) : iso;
}

let localSeq = 0;
function nextLocalId(): string {
  localSeq += 1;
  return `local-${localSeq}-${Date.now()}`;
}

/** 瀏覽器定位包成 Promise(元件自己定位時用,8 秒逾時) */
function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 0,
    });
  });
}

export default function PhotoCapture({
  customerId,
  customerName,
  salesName,
  salesTitle,
  companyName,
  mode,
  onChange,
  position,
  reloadKey,
  disabled = false,
}: PhotoCaptureProps) {
  const uid = useId();
  const base = `${getApiBase()}/api/admin/crm-checkin`;
  // 離線時這張要掛在誰名下:共用裝置上換帳號登入之後,前一個人的待送出不會被送出去
  const { me } = useMe();
  const ownerKey = ownerKeyOf(me);
  const offline = useNetworkState() !== 'online';
  // 每一項照片顯示什麼中文,由後台的照片存證檢查表決定
  const kindLabel = usePhotoKindLabel();
  const { photoChecklist, timezone } = useAppSettings();
  // 場所類型的顯示名稱同樣來自後台設定
  const { premisesTypes } = useCrmVocab();
  /**
   * 場所類型還沒選時要先列哪幾格:後台標了「必拍」的那些種類。
   * 沒標必拍的(例如「其他」)不佔一格,它們走下面的「其他照片」區。
   */
  const requiredCapableKinds = useMemo<PhotoKind[]>(
    () => photoChecklist.filter((i) => i.required).map((i) => i.key),
    [photoChecklist],
  );

  const [list, setList] = useState<PhotoList | null>(null);
  const [listMsg, setListMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<LocalPhoto[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [desktopCamera, setDesktopCamera] = useState(false);
  // 伺服器照片縮圖(photoId → blob URL)
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef<Record<string, string>>({});

  // 自己定位的快取
  const ownFix = useRef<{ lat: number; lng: number; accuracy: number | null; at: number } | null>(
    null,
  );

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 焦點管理用的 ref:每格入口按鈕(slotKey)、拍照面板第一個按鈕(拍下 / 確認使用)、
  // 每張伺服器照片的「刪除」與確認列的「確定刪除」(photoId)、標題列的「重新整理」(刪除成功後的退路)
  const entryBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const panelFirstBtnRef = useRef<HTMLButtonElement | null>(null);
  const deleteBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const confirmDeleteBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const refreshBtnRef = useRef<HTMLButtonElement | null>(null);
  const mapRef =
    (map: Map<string, HTMLButtonElement>, key: string) => (el: HTMLButtonElement | null) => {
      if (el) map.set(key, el);
      else map.delete(key);
    };

  const busy =
    disabled ||
    capture?.stage === 'processing' ||
    capture?.stage === 'uploading' ||
    deletingId != null;

  // 拍照流程焦點:進 camera → 「拍下」;進 preview → 「確認使用」;流程結束(null)→ 回該格入口按鈕
  // (取代中的照片已不在時退到同類型的主入口)。processing / uploading 沒有可聚焦的按鈕,維持原位。
  const prevCaptureRef = useRef<Capture | null>(null);
  useEffect(() => {
    const prev = prevCaptureRef.current;
    prevCaptureRef.current = capture;
    if (capture?.stage === 'camera' || capture?.stage === 'preview') {
      panelFirstBtnRef.current?.focus();
      return;
    }
    if (capture === null && prev) {
      const exact = entryBtnRefs.current.get(slotKey(prev.kind, prev.replaceId));
      (exact ?? entryBtnRefs.current.get(slotKey(prev.kind, null)))?.focus();
    }
  }, [capture]);

  // 刪除確認列焦點:出現時到「確定刪除」;收起(取消或刪完)回該張的「刪除」,照片已不在就退到「重新整理」
  const prevConfirmRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConfirmRef.current;
    prevConfirmRef.current = confirmDeleteId;
    if (confirmDeleteId) {
      confirmDeleteBtnRefs.current.get(confirmDeleteId)?.focus();
      return;
    }
    if (prev) (deleteBtnRefs.current.get(prev) ?? refreshBtnRef.current)?.focus();
  }, [confirmDeleteId]);

  // 偵測電腦鏡頭:有 getUserMedia 且是精準指標(滑鼠),手機就走 capture input
  useEffect(() => {
    try {
      const ok =
        typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof window !== 'undefined' &&
        window.matchMedia('(pointer: fine)').matches;
      setDesktopCamera(ok);
    } catch {
      setDesktopCamera(false);
    }
  }, []);

  // 主機時間:基準與每五分鐘的校時都在 AppSettingsProvider(見 lib/app-settings 的 useServerNow),
  // 這一支不自己打 /api/public/settings。原本它自己打一次再每五分鐘打一次,
  // 而同一頁上的浮水印元件也在做同一件事 —— 同一個時間基準有兩份,請求也是兩倍。
  // 拿不到主機時間時 deviceTime 是 true,浮水印會標「(裝置時間)」,這一點沒有變。
  const nowMs = useServerNow();

  /** 停止鏡頭所有 track */
  const stopCamera = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // 元件卸載或頁面離開時關鏡頭、釋放縮圖
  useEffect(() => {
    const onHide = () => stopCamera();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      stopCamera();
      Object.values(thumbsRef.current).forEach((u) => URL.revokeObjectURL(u));
      thumbsRef.current = {};
    };
  }, [stopCamera]);

  // 載入存證清單
  const loadList = useCallback(async () => {
    setListMsg(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(customerId)}/photos`, {
        credentials: 'include',
      });
      if (res.status === 403 || res.status === 404) {
        setListMsg('找不到客戶或沒有權限');
        setList(null);
        return;
      }
      if (!res.ok) {
        // 401 走共用規則且不導頁:這個元件所在的頁面可能已經有拍好、還沒送出的照片
        setListMsg(
          await apiErrorMessage(res, '存證清單載入失敗,請稍後再試', {
            onUnauthorized: 'stay',
          }),
        );
        setList(null);
        return;
      }
      const d = (await res.json()) as Partial<PhotoList> & { photos?: Partial<ServerPhoto>[] };
      const photos: ServerPhoto[] = (Array.isArray(d.photos) ? d.photos : [])
        .filter((p): p is ServerPhoto => typeof p.id === 'string' && isKind(p.kind))
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          takenAt: typeof p.takenAt === 'string' ? p.takenAt : '',
          interactionId: typeof p.interactionId === 'string' ? p.interactionId : '',
          byName: typeof p.byName === 'string' ? p.byName : '',
          sizeBytes: typeof p.sizeBytes === 'number' ? p.sizeBytes : 0,
        }));
      // 代碼只驗格式:合法值是後台設定的那一份,寫死清單的話後台新增的場所類型
      // 會在這裡被丟掉,畫面上只顯示「尚未設定場所類型」而看不出原因
      const premisesType =
        typeof d.premisesType === 'string' && STAGE_KEY_PATTERN.test(d.premisesType)
          ? d.premisesType
          : null;
      setList({
        premisesType,
        premisesTypeMissing: d.premisesTypeMissing === true || premisesType === null,
        required: (Array.isArray(d.required) ? d.required : []).filter(isKind),
        photos,
        missing: (Array.isArray(d.missing) ? d.missing : []).filter(isKind),
      });
    } catch (e) {
      if (isNetworkError(e)) {
        reportNetworkFailure();
        // 「請稍後再試」沒說出原因,而且在沒訊號的地方那個動作永遠不會成功
        setListMsg('目前沒有網路連線,無法載入存證清單。拍照不需要網路,可以先拍。');
      } else {
        setListMsg('存證清單載入失敗,請稍後再試');
      }
      setList(null);
    }
  }, [base, customerId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 外層打卡成功後:清掉待上傳、重新載入
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    setPending([]);
    setCapture(null);
    setMsg(null);
    void loadList();
  }, [reloadKey, loadList]);

  // 待上傳清單變動 → 通知外層
  useEffect(() => {
    onChangeRef.current?.(
      pending.map((p) => ({
        kind: p.kind,
        mime: p.result.mime,
        base64: p.result.base64,
        takenAt: p.result.takenAt,
      })),
    );
  }, [pending]);

  // 抓伺服器照片縮圖(帶 cookie,不能直接 img src),並回收已不存在的
  useEffect(() => {
    if (!list) return;
    let alive = true;
    const ids = new Set(list.photos.map((p) => p.id));
    // 回收
    const cur = thumbsRef.current;
    let changed = false;
    for (const [id, url] of Object.entries(cur)) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        delete cur[id];
        changed = true;
      }
    }
    if (changed) setThumbs({ ...cur });
    // 補抓
    (async () => {
      for (const p of list.photos) {
        if (thumbsRef.current[p.id]) continue;
        try {
          const r = await fetch(`${base}/photo/${encodeURIComponent(p.id)}`, {
            credentials: 'include',
          });
          if (!alive) return;
          if (!r.ok) continue;
          const url = URL.createObjectURL(await r.blob());
          if (!alive) {
            URL.revokeObjectURL(url);
            return;
          }
          thumbsRef.current[p.id] = url;
          setThumbs({ ...thumbsRef.current });
        } catch {
          /* 縮圖抓不到就顯示文字 */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [list, base]);

  // 外層 position 用 ref 鏡像:拍照的 callback 可能是較早綁定的閉包,直接讀 prop 會拿到舊值(曾造成頁面已定位、照片卻印「未定位」)
  const positionRef = useRef<PhotoPosition | null | undefined>(position);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  /** 取座標:優先外層 position;undefined 就自己定位(快取 60 秒);拿不到回 null */
  const resolvePosition = useCallback(async (): Promise<PhotoPosition | null> => {
    const outer = positionRef.current;
    if (outer !== undefined && outer !== null) return outer;
    const cached = ownFix.current;
    if (cached && performance.now() - cached.at < OWN_FIX_MAX_AGE_MS) {
      return { lat: cached.lat, lng: cached.lng, accuracy: cached.accuracy };
    }
    try {
      const pos = await getCurrentPosition();
      const acc = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
      ownFix.current = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: acc,
        at: performance.now(),
      };
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: acc };
    } catch {
      return null;
    }
  }, []);

  /** 影像 → 浮水印 → 預覽 */
  const processBlob = useCallback(
    async (blob: Blob, kind: PhotoKind, replaceId: string | null, cameraOpen: boolean) => {
      setMsg(null);
      setCapture({ kind, stage: 'processing', replaceId, cameraOpen });
      try {
        const pos = await resolvePosition();
        const t = nowMs();
        const out = await watermarkPhoto({
          file: blob,
          companyName,
          customerName,
          kindLabel: kindLabel(kind),
          salesName,
          salesTitle,
          lat: pos?.lat ?? null,
          lng: pos?.lng ?? null,
          takenAtMs: t.ms,
          timeZone: timezone,
          deviceTime: t.deviceTime,
        });
        setCapture({
          kind,
          stage: 'preview',
          replaceId,
          cameraOpen,
          result: out,
          dataUrl: photoDataUrl(out),
        });
        setMsg(
          `照片已處理:${out.width}×${out.height},${fmtBytes(out.bytes)}${out.downgraded ? '(已自動降低畫質以符合大小上限)' : ''}${
            pos ? '' : ',未取得座標,浮水印標示「未定位」'
          }${t.deviceTime ? ',浮水印時間為裝置時間' : ''}。請確認後按「確認使用」。`,
        );
      } catch {
        if (!cameraOpen) stopCamera();
        setCapture(cameraOpen ? { kind, stage: 'camera', replaceId } : null);
        setMsg('照片處理失敗,請重新拍一張');
      }
    },
    [
      companyName,
      customerName,
      salesName,
      salesTitle,
      nowMs,
      resolvePosition,
      stopCamera,
      kindLabel,
      timezone,
    ],
  );

  /** 檔案 input(手機相機或選檔) */
  const pendingFileKind = useRef<{ kind: PhotoKind; replaceId: string | null } | null>(null);
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // 清掉 input 的值,同一張圖再選一次也會觸發 change
    e.target.value = '';
    const target = pendingFileKind.current;
    pendingFileKind.current = null;
    if (!file || !target) return;
    if (!file.type.startsWith('image/')) {
      setMsg('請選擇圖片檔(JPEG 或 PNG)');
      return;
    }
    stopCamera();
    void processBlob(file, target.kind, target.replaceId, false);
  }

  function openFilePicker(kind: PhotoKind, replaceId: string | null, withCapture: boolean) {
    pendingFileKind.current = { kind, replaceId };
    (withCapture ? captureInputRef : fileInputRef).current?.click();
  }

  /** 電腦鏡頭 */
  async function openCamera(kind: PhotoKind, replaceId: string | null) {
    setMsg(null);
    stopCamera();
    setCapture({ kind, stage: 'camera', replaceId });
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {
          /* autoplay 被擋時使用者按「拍下」前畫面仍會出現 */
        }
      }
    } catch {
      setCapture(null);
      setMsg('無法開啟鏡頭,請確認已允許相機權限,或改用「選擇檔案」');
    }
  }

  function closeCamera() {
    if (busy) return;
    stopCamera();
    setCapture(null);
    setMsg('已關閉鏡頭');
  }

  // 鏡頭已開但 video 元素後來才掛上(stage 切換)時把串流接回去
  useEffect(() => {
    if (
      capture?.stage === 'camera' &&
      videoRef.current &&
      streamRef.current &&
      videoRef.current.srcObject !== streamRef.current
    ) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [capture]);

  function snapFrame() {
    if (busy || !capture || capture.stage !== 'camera') return;
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) {
      setMsg('鏡頭畫面尚未就緒,請稍候再按「拍下」');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setMsg('此瀏覽器不支援影像處理,請改用「選擇檔案」');
      return;
    }
    ctx.drawImage(v, 0, 0);
    const { kind, replaceId } = capture;
    canvas.toBlob(
      (blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (!blob) {
          setMsg('擷取畫面失敗,請再試一次');
          return;
        }
        void processBlob(blob, kind, replaceId, true);
      },
      'image/jpeg',
      0.92,
    );
  }

  /** 預覽階段按「重拍」:鏡頭還開著就回到即時預覽,否則回到入口 */
  function retake() {
    if (busy || !capture || capture.stage !== 'preview') return;
    if (capture.cameraOpen && streamRef.current) {
      setCapture({ kind: capture.kind, stage: 'camera', replaceId: capture.replaceId });
    } else {
      stopCamera();
      setCapture(null);
    }
    setMsg('請重新拍攝');
  }

  /** 預覽階段按「確認使用」 */
  async function confirmPhoto() {
    if (busy || !capture || capture.stage !== 'preview') return;
    const { kind, replaceId, result, dataUrl } = capture;
    stopCamera();
    if (mode === 'checkin') {
      const rest = replaceId ? pending.filter((p) => p.localId !== replaceId) : pending;
      if (rest.length >= MAX_PENDING) {
        setMsg(`一次打卡最多 ${MAX_PENDING} 張,請先移除部分照片`);
        return;
      }
      const restBytes = rest.reduce((sum, p) => sum + p.result.bytes, 0);
      if (restBytes + result.bytes > MAX_PENDING_BYTES) {
        setMsg('照片總量超過 3MB,請先送出打卡或移除幾張');
        return;
      }
      setPending([...rest, { localId: nextLocalId(), kind, result, dataUrl }]);
      setCapture(null);
      setMsg(`已加入「${kindLabel(kind)}」照片,打卡時一起上傳`);
      return;
    }
    // standalone:立刻上傳
    setCapture({ kind, stage: 'uploading', replaceId });
    // 已經知道沒有網路就不要送:在沒訊號的地方 fetch 會卡到逾時,而結果一定是失敗。
    // 直接存進待送出,照片才不會只留在這個分頁的記憶體裡。
    if (offline) {
      const pos = await resolvePosition();
      await queuePhoto(kind, result, pos, '目前沒有網路連線。');
      return;
    }
    try {
      const pos = await resolvePosition();
      const res = await fetch(`${base}/${encodeURIComponent(customerId)}/photos`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: [{ kind, mime: result.mime, base64: result.base64, takenAt: result.takenAt }],
          lat: pos?.lat,
          lng: pos?.lng,
          accuracy: pos?.accuracy ?? undefined,
          clientTime: new Date().toISOString(),
        }),
      });
      if (res.status === 403 || res.status === 404) {
        setCapture({ kind, stage: 'preview', replaceId, cameraOpen: false, result, dataUrl });
        setMsg('找不到客戶或沒有權限');
        return;
      }
      if (res.status === 400) {
        setCapture({ kind, stage: 'preview', replaceId, cameraOpen: false, result, dataUrl });
        setMsg(await apiErrorMessage(res, '照片上傳失敗,請稍後再試'));
        return;
      }
      if (res.status === 413) {
        setCapture({ kind, stage: 'preview', replaceId, cameraOpen: false, result, dataUrl });
        setMsg('照片太大,請重拍一張');
        return;
      }
      if (!res.ok) {
        // 保留預覽(照片還在畫面上)再回報。401 也走這一條:登入過期時
        // 訊息要說得出原因,而且不能把剛拍好的那一張弄丟。
        setCapture({ kind, stage: 'preview', replaceId, cameraOpen: false, result, dataUrl });
        setMsg(await apiErrorMessage(res, '照片上傳失敗,請稍後再試', { onUnauthorized: 'stay' }));
        return;
      }
      setCapture(null);
      // 重拍:新照片上傳成功後才移除舊的;舊的刪不掉(已結案)就兩張都留
      let extra = '';
      if (replaceId) {
        const del = await fetch(`${base}/photo/${encodeURIComponent(replaceId)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!del.ok) {
          extra =
            del.status === 403
              ? ',原照片只有拍攝者本人或主管可以刪除,已一併保留'
              : del.status === 400
                ? `,原照片未能移除(${await apiErrorMessage(del, '後端未允許刪除')}),已一併保留`
                : ',原照片未能移除,已一併保留';
        } else {
          // 舊照片已刪:立刻釋放它的縮圖 blob URL(loadList 也會回收,這裡先放不等清單)
          const old = thumbsRef.current[replaceId];
          if (old) {
            URL.revokeObjectURL(old);
            delete thumbsRef.current[replaceId];
            setThumbs({ ...thumbsRef.current });
          }
        }
      }
      setMsg(`「${kindLabel(kind)}」照片已上傳存證${extra}`);
      reportNetworkSuccess();
      await loadList();
    } catch (e) {
      if (isNetworkError(e)) {
        reportNetworkFailure();
        const pos = await resolvePosition();
        await queuePhoto(kind, result, pos, '送不出去,目前沒有網路連線。');
        return;
      }
      setCapture({ kind, stage: 'preview', replaceId, cameraOpen: false, result, dataUrl });
      setMsg('照片上傳失敗,請稍後再試');
    }
  }

  /**
   * standalone 模式送不出去時的退路:把這一張寫進裝置上的「待送出」。
   *
   * 存進去才清掉預覽。存不進去(配額滿、無痕視窗把 IndexedDB 關掉)時預覽留著,
   * 並且明講不要關分頁 —— 那時候記憶體是唯一還留著這張照片的地方。
   * 拍攝時間原樣帶走,不改寫成「現在」:改寫等於偽造存證,而且後端只收 24 小時內拍的,
   * 逾時該被擋下來就是要被擋下來。
   */
  async function queuePhoto(
    kind: PhotoKind,
    result: WatermarkResult,
    pos: PhotoPosition | null,
    lead: string,
  ) {
    const res = await enqueue(
      ownerKey,
      {
        type: 'photos',
        customerId,
        customerName,
        capturedAt: result.takenAt,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        accuracy: pos?.accuracy ?? null,
        photos: [{ kind, mime: result.mime, base64: result.base64, takenAt: result.takenAt }],
      },
      Date.now(),
    );
    if (!res.ok) {
      setMsg(`${lead}${res.message}`);
      return;
    }
    setCapture(null);
    setMsg(
      `${lead}這張「${kindLabel(kind)}」照片已存進這台裝置的「待送出」,關掉分頁也不會消失。` +
        '回到有網路的地方,到「GPS 到訪打卡」頁按「全部重送」即可上傳。伺服器只收 24 小時內拍的照片,請盡快重送。',
    );
  }

  /** 取消整個拍照流程(處理中不可取消) */
  function cancelCapture() {
    if (busy) return;
    stopCamera();
    setCapture(null);
    setMsg('已取消');
  }

  function removePending(localId: string) {
    setPending((prev) => prev.filter((p) => p.localId !== localId));
    setMsg('已移除待上傳照片');
  }

  async function deleteServerPhoto(id: string) {
    if (busy) return;
    setDeletingId(id);
    setMsg(null);
    try {
      const res = await fetch(`${base}/photo/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.status === 403) {
        setMsg('只有拍攝者本人或主管可以刪除');
        return;
      }
      if (res.status === 400) {
        setMsg(await apiErrorMessage(res, '這張照片目前不可刪除'));
        return;
      }
      if (res.status === 404) {
        setMsg('照片已不存在,清單已更新');
        await loadList();
        return;
      }
      if (!res.ok) {
        setMsg(await apiErrorMessage(res, '刪除失敗,請稍後再試', { onUnauthorized: 'stay' }));
        return;
      }
      const old = thumbsRef.current[id];
      if (old) {
        URL.revokeObjectURL(old);
        delete thumbsRef.current[id];
        setThumbs({ ...thumbsRef.current });
      }
      setMsg('照片已刪除');
      await loadList();
    } catch {
      setMsg('刪除失敗,請稍後再試');
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  // ---- 衍生資料 ----
  /** 要顯示的必拍類型:後端給的 required;場所類型未設定時先列後台標為必拍的那些 */
  const requiredKinds = useMemo<PhotoKind[]>(() => {
    if (!list) return [];
    if (list.required.length > 0) return list.required;
    return list.premisesType === null ? requiredCapableKinds : [];
  }, [list, requiredCapableKinds]);

  /** 還缺哪些:後端 missing 扣掉本地已拍到的(checkin 模式) */
  const stillMissing = useMemo<PhotoKind[]>(() => {
    if (!list) return [];
    const have = new Set<PhotoKind>([
      ...list.photos.map((p) => p.kind),
      ...pending.map((p) => p.kind),
    ]);
    const src =
      list.required.length > 0
        ? list.missing
        : list.premisesType === null
          ? requiredCapableKinds
          : [];
    return src.filter((k) => !have.has(k));
  }, [list, pending, requiredCapableKinds]);

  const photosByKind = useMemo(() => {
    const m = new Map<PhotoKind, ServerPhoto[]>();
    if (list) for (const p of list.photos) m.set(p.kind, [...(m.get(p.kind) ?? []), p]);
    return m;
  }, [list]);

  const pendingBytes = useMemo(
    () => pending.reduce((sum, p) => sum + p.result.bytes, 0),
    [pending],
  );

  const pendingByKind = useMemo(() => {
    const m = new Map<PhotoKind, LocalPhoto[]>();
    for (const p of pending) m.set(p.kind, [...(m.get(p.kind) ?? []), p]);
    return m;
  }, [pending]);

  /** 「其他照片」區:kind = other 的,加上不在必拍清單裡的類型(例如場所類型改過) */
  const otherKinds = useMemo<PhotoKind[]>(() => {
    const req = new Set(requiredKinds);
    const ks = new Set<PhotoKind>([OTHER_PHOTO_KIND]);
    for (const k of photosByKind.keys()) if (!req.has(k)) ks.add(k);
    for (const k of pendingByKind.keys()) if (!req.has(k)) ks.add(k);
    return [...ks];
  }, [requiredKinds, photosByKind, pendingByKind]);

  // ---- render 小零件 ----
  /**
   * 一格的兩顆入口按鈕(開啟鏡頭 / 選擇檔案)。
   *
   * 兩顆的可見文字在每一格都一樣,所以必拍七項一列開,Tab 序列就是七個「開啟鏡頭」
   * 加七個「選擇檔案」,螢幕閱讀器叫出按鈕清單看到的是十四個沒有差別的項目
   * (「這是哪一項的按鈕」只寫在旁邊的 heading 上,那不是按鈕的可及名稱)。
   * 所以每一顆都自帶一個講得完整的 aria-label:客戶、照片項目、要做的事。
   * ordinal 是同一項底下第幾張照片的重拍鈕,有多張時才需要它來分辨。
   */
  function entryButtons(
    kind: PhotoKind,
    replaceId: string | null,
    label: string,
    ordinal?: number,
  ) {
    // 一次只做一格:有拍照流程進行中就先把所有入口收起來
    if (capture) return null;
    const entryRef = mapRef(entryBtnRefs.current, slotKey(kind, replaceId));
    const scope =
      `${customerName} ${kindLabel(kind)}` + (ordinal === undefined ? '' : ` 第 ${ordinal} 張`);
    const cameraText = label === '拍照' ? '開啟鏡頭' : `${label}(開啟鏡頭)`;
    return (
      <div className="flex flex-wrap gap-2">
        {desktopCamera ? (
          <button
            type="button"
            ref={entryRef}
            className="btn"
            onClick={() => void openCamera(kind, replaceId)}
            disabled={busy}
            aria-label={`${scope}:${cameraText}`}
          >
            {cameraText}
          </button>
        ) : (
          <button
            type="button"
            ref={entryRef}
            className="btn"
            onClick={() => openFilePicker(kind, replaceId, true)}
            disabled={busy}
            aria-label={`${scope}:${label}`}
          >
            {label}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => openFilePicker(kind, replaceId, false)}
          disabled={busy}
          aria-label={`${scope}:選擇檔案`}
        >
          選擇檔案
        </button>
      </div>
    );
  }

  /** 進行中的拍照面板(鏡頭 / 處理中 / 預覽),只在對應的格子裡出現 */
  function capturePanel(kind: PhotoKind, replaceId: string | null) {
    if (!capture || capture.kind !== kind || capture.replaceId !== replaceId) return null;
    const label = kindLabel(kind);
    if (capture.stage === 'camera') {
      return (
        <div className="mt-2 flex flex-col gap-2">
          {/* 即時鏡頭預覽:沒有音訊,也沒有可加字幕的內容;畫面內容由 aria-label 說明 */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label={`鏡頭即時預覽,${customerName} ${label}`}
            className="w-full max-w-md rounded-md border border-border bg-black"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              ref={panelFirstBtnRef}
              className="btn btn-primary"
              onClick={snapFrame}
              aria-busy={busy}
            >
              拍下
            </button>
            <button type="button" className="btn" onClick={closeCamera} aria-busy={busy}>
              關閉鏡頭
            </button>
          </div>
        </div>
      );
    }
    if (capture.stage === 'processing') {
      return <p className="mt-2 text-sm text-muted-foreground">處理照片中…</p>;
    }
    if (capture.stage === 'uploading') {
      return <p className="mt-2 text-sm text-muted-foreground">上傳中…</p>;
    }
    const r = capture.result;
    return (
      <figure className="mt-2 flex flex-col gap-2">
        <Image
          src={capture.dataUrl}
          alt={`${customerName} ${label} 存證照片預覽`}
          width={r.width}
          height={r.height}
          unoptimized
          className="h-auto w-full max-w-md rounded-md border border-border"
        />
        <figcaption className="text-xs text-muted-foreground">
          {r.width}×{r.height},{fmtBytes(r.bytes)}(已壓浮水印)
        </figcaption>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            ref={panelFirstBtnRef}
            className="btn btn-primary"
            onClick={() => void confirmPhoto()}
            aria-busy={busy}
          >
            確認使用
          </button>
          <button type="button" className="btn" onClick={retake} aria-busy={busy}>
            重拍
          </button>
          <button type="button" className="btn" onClick={cancelCapture} aria-busy={busy}>
            取消
          </button>
        </div>
      </figure>
    );
  }

  function serverPhotoItem(p: ServerPhoto, ordinal: number) {
    const label = kindLabel(p.kind);
    const thumb = thumbs[p.id];
    const confirming = confirmDeleteId === p.id;
    return (
      <div
        key={p.id}
        className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      >
        <div className="flex flex-wrap items-start gap-3">
          {thumb ? (
            <Image
              src={thumb}
              alt={`${customerName} ${label} 存證照片`}
              width={192}
              height={144}
              unoptimized
              className="h-auto w-40 rounded-md border border-border"
            />
          ) : (
            <div className="flex h-28 w-40 items-center justify-center rounded-md border border-border text-xs text-muted-foreground">
              縮圖載入中…
            </div>
          )}
          <dl className="flex-1 text-xs">
            <dt className="text-muted-foreground">拍攝時間</dt>
            <dd>{p.takenAt ? fmtIso(p.takenAt, timezone) : '未知'}</dd>
            <dt className="mt-1 text-muted-foreground">拍攝者</dt>
            <dd>{p.byName || '未知'}</dd>
            {p.sizeBytes > 0 && (
              <>
                <dt className="mt-1 text-muted-foreground">大小</dt>
                <dd>{fmtBytes(p.sizeBytes)}</dd>
              </>
            )}
          </dl>
        </div>
        {capturePanel(p.kind, p.id)}
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>確定要刪除這張「{label}」存證照片?</span>
            <button
              type="button"
              ref={mapRef(confirmDeleteBtnRefs.current, p.id)}
              className="btn btn-danger"
              onClick={() => void deleteServerPhoto(p.id)}
              aria-busy={busy}
            >
              {deletingId === p.id ? '刪除中…' : '確定刪除'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (busy) return;
                setConfirmDeleteId(null);
              }}
              aria-busy={busy}
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entryButtons(p.kind, p.id, '重拍', ordinal)}
            {!capture && (
              <button
                type="button"
                ref={mapRef(deleteBtnRefs.current, p.id)}
                className="btn btn-danger"
                onClick={() => {
                  setMsg(null);
                  setConfirmDeleteId(p.id);
                }}
                disabled={busy}
              >
                刪除
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  function pendingItem(p: LocalPhoto, ordinal: number) {
    const label = kindLabel(p.kind);
    return (
      <div
        key={p.localId}
        className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      >
        <div className="flex flex-wrap items-start gap-3">
          <Image
            src={p.dataUrl}
            alt={`${customerName} ${label} 存證照片(待上傳)`}
            width={p.result.width}
            height={p.result.height}
            unoptimized
            className="h-auto w-40 rounded-md border border-border"
          />
          <dl className="flex-1 text-xs">
            <dt className="text-muted-foreground">拍攝時間</dt>
            <dd>{fmtIso(p.result.takenAt, timezone)}</dd>
            <dt className="mt-1 text-muted-foreground">狀態</dt>
            <dd>待上傳(打卡時一起送出),{fmtBytes(p.result.bytes)}</dd>
          </dl>
        </div>
        {capturePanel(p.kind, p.localId)}
        <div className="flex flex-wrap gap-2">
          {entryButtons(p.kind, p.localId, '重拍', ordinal)}
          {!capture && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => removePending(p.localId)}
              disabled={busy}
            >
              移除
            </button>
          )}
        </div>
      </div>
    );
  }

  function slot(kind: PhotoKind, required: boolean) {
    const label = kindLabel(kind);
    const server = photosByKind.get(kind) ?? [];
    const local = pendingByKind.get(kind) ?? [];
    const has = server.length + local.length > 0;
    const headingId = `${uid}-${kind}`;
    return (
      <li
        key={kind}
        className="rounded-md border border-border bg-surface p-3"
        aria-labelledby={headingId}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 id={headingId} className="text-sm font-semibold">
            {label}
            {required && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">(必拍)</span>
            )}
          </h5>
          <span className="text-xs text-muted-foreground">
            {has ? `已拍 ${server.length + local.length} 張` : '尚未拍攝'}
          </span>
        </div>
        {has && (
          <div className="mt-2 flex flex-col gap-2">
            {server.map((p, i) => serverPhotoItem(p, i + 1))}
            {local.map((p, i) => pendingItem(p, server.length + i + 1))}
          </div>
        )}
        <div className="mt-2 flex flex-col gap-2">
          {entryButtons(kind, null, has ? '再拍一張' : '拍照')}
          {capturePanel(kind, null)}
        </div>
      </li>
    );
  }

  // ---- render ----
  const missingText =
    list == null
      ? ''
      : stillMissing.length === 0
        ? '必拍存證照片已齊全'
        : `還缺 ${stillMissing.length} 張:${stillMissing.map(kindLabel).join('、')}`;

  return (
    <div className="flex flex-col gap-3">
      {/* 隱藏的檔案輸入:一個帶 capture(手機開相機)、一個不帶(選檔備援);由可見按鈕觸發,不進 Tab 順序 */}
      <input
        ref={captureInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">存證照片</h3>
        <button
          type="button"
          ref={refreshBtnRef}
          className="btn"
          onClick={() => void loadList()}
          disabled={busy}
        >
          重新整理
        </button>
      </div>

      {listMsg && (
        <p role="alert" className="rounded-md border border-border bg-background p-2 text-sm">
          {listMsg}
        </p>
      )}

      {list && list.premisesTypeMissing && (
        <p className="rounded-md border border-border bg-background p-2 text-sm text-warning">
          注意:此客戶尚未設定場所類型,請先到客戶卡選一個。在那之前先列出全部類型,可先拍。
        </p>
      )}

      <p role="status" aria-live="polite" className="text-sm">
        {list == null && !listMsg ? '存證清單載入中…' : missingText}
        {mode === 'checkin' && pending.length > 0 && (
          <span className="ml-2 text-xs text-muted-foreground">
            (已選 {pending.length} 張,共 {(pendingBytes / (1024 * 1024)).toFixed(2)} MB
            {pendingBytes > MAX_PENDING_BYTES ? ',已超過 3MB 上限' : ''})
          </span>
        )}
        {list && list.premisesType && (
          <span className="ml-2 text-xs text-muted-foreground">
            (場所類型:{labelOf(premisesTypes, list.premisesType)})
          </span>
        )}
      </p>

      {list && (
        <>
          <h4 className="text-sm font-semibold">必拍存證照片</h4>
          <ul className="flex flex-col gap-2" aria-label="必拍存證照片">
            {requiredKinds.map((k) => slot(k, true))}
          </ul>
          <h4 className="mt-1 text-sm font-semibold">其他照片</h4>
          <ul className="flex flex-col gap-2" aria-label="其他照片">
            {otherKinds.map((k) => slot(k, false))}
          </ul>
        </>
      )}

      <p role="status" aria-live="polite" className="min-h-[1.25rem] text-xs text-muted-foreground">
        {capture?.stage === 'processing'
          ? '處理照片中…'
          : capture?.stage === 'uploading'
            ? '照片上傳中…'
            : (msg ??
              (desktopCamera
                ? '按「開啟鏡頭」用電腦鏡頭拍攝,或「選擇檔案」上傳既有照片。'
                : '按「拍照」會直接開手機相機,或「選擇檔案」上傳既有照片。'))}
      </p>
      <p className="text-xs text-muted-foreground">
        照片會在裝置端壓上客戶名稱與類型、拍攝者、時間(含時區)與座標浮水印後才上傳。首次使用會請求相機與定位權限。
      </p>
    </div>
  );
}
