'use client';

// GPS 到訪打卡(/admin/crm/field/checkin)。原本在 /admin/crm/field 頁的第一區,拆頁後獨立。
// 流程:選客戶(可用 ?customerId= 預選,從我的首頁或拜訪計畫點過來)→ 自動定位 → 依場所類型拍存證照片
//   → 按「到訪打卡」一起送出 → 顯示結果與距離,下面給「回我的首頁」與「繼續下一家」。
// 資料來源:GET /api/admin/crm(客戶下拉)、POST /api/admin/crm-checkin/:customerId(body 含 photos)。
//   浮水印要的組織名稱與拍攝者姓名職稱不自己打 API:前者讀 useAppSettings(),後者讀 useMe(),
//   兩份都由 root layout 的 Provider 供應。這一頁原本自己各打一次,而同一次載入裡
//   那兩支端點已經被打過了。
// 離線:現場常常沒有訊號(地下室機房、鐵皮廠房、山區站台)。這一頁做兩件事 ——
//   (a) 送不出去時明確說「目前沒有網路連線」,不是「請稍後再試」(那句話建議的動作永遠不會成功);
//   (b) 把這一筆打卡與已經拍好的照片寫進 IndexedDB 的「待送出」(見 lib/offline-queue),
//       關掉分頁、手機重開都還在,回到有網路的地方按「全部重送」。
//   佇列保留原始拍攝時間不改寫,而後端只收 24 小時內拍的照片,所以清單上會寫出「可重送到什麼時候」。
//   注意:這套系統沒有 service worker,離線時**重新整理這一頁會打不開**,能救的是「頁面已經開著」那一段。
// 無障礙:定位狀態與打卡結果都在 role="status" aria-live 區塊、按鈕 >= 44px(.btn 已含)、
//   可疑打卡用 role="alert" 與文字說明,不只靠顏色。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import PhotoCapture, { type PendingPhoto } from '@/components/crm/photo-capture';
import { canUseCrm, useCrmRole } from '@/lib/crm-shared';
import { useAppSettings, useLookupLabel } from '@/lib/app-settings';
import { useMe } from '@/lib/me-context';
import PendingQueue from '@/components/crm/pending-queue';
import {
  isNetworkError,
  reportNetworkFailure,
  reportNetworkSuccess,
  useNetworkState,
} from '@/lib/network-status';
import { enqueue, ownerKeyOf } from '@/lib/offline-queue';

interface FieldCustomer {
  id: string;
  taxId: string | null;
  companyName: string | null;
  stage: string;
  lastContactAt: string | null;
}

interface GpsFix {
  lat: number;
  lng: number;
  /** 公尺;瀏覽器沒給就 null */
  accuracy: number | null;
  /** 取得時間(performance.now()),判斷新鮮度用 */
  at: number;
}

interface CheckInResult {
  interactionId: string;
  distanceM: number | null;
  suspicious: boolean;
  suspiciousReason: string | null;
  photoIds: string[];
  serverTime: string | null;
}

/** 定位精度超過這個值就提醒使用者到戶外 */
const ACCURACY_WARN_M = 300;

/**
 * 瀏覽器沒回報定位精度時的說法。
 *
 * 後端的 accuracy 是必填(見 checkin/dto/checkin.dto.ts),缺了就回「缺少定位精度」。
 * 前端以前在這種情況顯示「已取得目前座標(瀏覽器未提供精度)」,看起來一切正常,
 * 按下去才失敗;離線時還會被存進待送出,之後每次重送都是同一句,永遠送不出去。
 * 所以在畫面上就講清楚這台裝置打不了卡,以及可以換什麼做法。
 */
const NO_ACCURACY_TEXT =
  '這台裝置沒有回報定位精度,系統無法判斷打卡位置是否可信,請改用手機的瀏覽器或開啟高精度定位';
/** 打卡時沿用先前定位的最長時間(毫秒),超過就重新定位 */
const FIX_MAX_AGE_MS = 60 * 1000;

/** 客戶下拉一次要幾筆(後端 CUSTOMER_LIST_TAKE_MAX 同值) */
const CUSTOMER_TAKE = 1000;

/** 距離顯示:公尺四捨五入;超過 1 公里改用公里 */
function fmtDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} 公里`;
  return `${Math.round(m)} 公尺`;
}

/** 瀏覽器定位包成 Promise */
function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

function CheckinInner() {
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();

  const role = useCrmRole();
  const params = useSearchParams();
  const presetCustomerId = params.get('customerId') ?? '';

  // 浮水印用:訪查人員姓名、職稱與組織名稱。
  // 組織名稱讀 organizationName,不是相容用的舊欄位名 companyName ——
  // 舊欄位哪天從後端白名單拿掉,讀舊欄位的地方會安靜地印出空字串。
  const { organizationName: company } = useAppSettings();
  const { me } = useMe();
  const salesName = me?.name ?? '';
  const salesTitle = me?.title ?? '';
  // 離線時這一筆要掛在誰名下:共用裝置上換帳號登入之後,前一個人的待送出不會被送出去
  const ownerKey = ownerKeyOf(me);
  const netState = useNetworkState();
  const offline = netState !== 'online';

  const [rows, setRows] = useState<FieldCustomer[]>([]);
  // 客戶清單被後端上限切掉:下拉裡不是全部,要說出來
  const [listTruncated, setListTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string>('');
  const [note, setNote] = useState('');
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);

  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  const [photoRefresh, setPhotoRefresh] = useState(0);
  // 待送出清單重讀用:存進佇列或打卡成功後 +1
  const [queueRefresh, setQueueRefresh] = useState(0);
  // 存不進待送出時的警告。跟一般狀態訊息分開:這一種要人立刻做點什麼
  //(不要關分頁、清空間),所以是 role="alert" 而不是 role="status"
  const [queueError, setQueueError] = useState<string | null>(null);
  const handlePhotosChange = useCallback((p: PendingPhoto[]) => setPendingPhotos(p), []);

  const crmBase = `${getApiBase()}/api/admin/crm`;
  const checkinBase = `${getApiBase()}/api/admin/crm-checkin`;
  const canUse = canUseCrm(role);

  const loadCustomers = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 明確帶 limit:不帶的話後端只給 500 筆,而下拉裡挑不到的客戶在畫面上等於不存在。
      // 被上限切到就在下拉旁邊講一句(listTruncated),不要安靜地少幾家。
      const res = await fetch(`${crmBase}?limit=${CUSTOMER_TAKE}`, { credentials: 'include' });
      if (res.status === 403) {
        setError('你的帳號沒有查看客戶的權限,請找系統管理員開通');
        return;
      }
      if (!res.ok) {
        // 401 走共用規則,但用 'stay':這一頁可能已經有拍好的存證照片,
        // 直接導頁等於把人在現場拍的東西丟掉(見 lib/api-error 的說明)
        setError(
          await apiErrorMessage(res, '客戶清單載入失敗,請稍後再試', {
            onUnauthorized: 'stay',
          }),
        );
        return;
      }
      const data = (await res.json()) as { rows?: FieldCustomer[]; nextCursor?: string | null };
      reportNetworkSuccess();
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setListTruncated(typeof data.nextCursor === 'string');
    } catch (e) {
      if (isNetworkError(e)) {
        reportNetworkFailure();
        // 「請稍後再試」在沒訊號的地方是一句沒有用的話:它沒說出原因,而它建議的
        // 動作永遠不會成功。講清楚是沒網路,並說出這個狀態下還做得到什麼。
        setError(
          '目前沒有網路連線,無法載入客戶清單。定位與拍照不需要網路,可以先拍;' +
            '按下「到訪打卡」時會存進裝置上的「待送出」,回到有網路的地方再重送。',
        );
      } else {
        setError('客戶清單載入失敗,請稍後再試');
      }
    } finally {
      setLoading(false);
    }
  }, [role, canUse, crmBase]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

  // ?customerId= 預選:等清單載進來、且使用者還沒自己選過才套用
  useEffect(() => {
    if (!presetCustomerId || selectedId) return;
    if (rows.some((r) => r.id === presetCustomerId)) setSelectedId(presetCustomerId);
  }, [presetCustomerId, rows, selectedId]);

  /** 取得定位;成功回 GpsFix 並存進 state,失敗回 null 並把原因寫到 locateMsg */
  const locate = useCallback(async (): Promise<GpsFix | null> => {
    setLocating(true);
    setLocateMsg(null);
    try {
      const pos = await getCurrentPosition();
      const acc = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
      const f: GpsFix = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: acc,
        at: performance.now(),
      };
      setFix(f);
      return f;
    } catch (e) {
      // 只講「需要權限」等於沒講:人不知道那個開關在哪裡。把實際要按的地方寫出來。
      const msg =
        e instanceof Error && e.message === 'unsupported'
          ? '此裝置或瀏覽器不支援定位,無法打卡'
          : '需要開啟定位權限才能打卡。請點網址列旁邊的鎖頭圖示,把「位置」改成允許,再按「重新定位」。如果還是不行,請確認手機的定位服務有打開。';
      setLocateMsg(msg);
      setFix(null);
      return null;
    } finally {
      setLocating(false);
    }
  }, []);

  /** 有新鮮的定位就直接用,否則重新定位 */
  const ensureFix = useCallback(async (): Promise<GpsFix | null> => {
    if (fix && performance.now() - fix.at < FIX_MAX_AGE_MS) return fix;
    return locate();
  }, [fix, locate]);

  // 選了客戶就先定位一次,讓使用者在打卡前看到精度
  useEffect(() => {
    if (!selectedId || !canUse) return;
    void locate();
  }, [selectedId, canUse, locate]);

  /** 繼續下一家:清掉選擇與上一次的結果,焦點回到客戶下拉 */
  function resetForNext() {
    setSelectedId('');
    setNote('');
    setResult(null);
    setCheckMsg(null);
    setPendingPhotos([]);
    setFix(null);
    setLocateMsg(null);
    setQueueRefresh((n) => n + 1);
    document.getElementById('field-customer')?.focus();
  }

  /** 目前選到的那一家叫什麼(待送出清單上要看得出是哪一家) */
  function selectedCustomerName(): string {
    const r = rows.find((x) => x.id === selectedId);
    return r?.companyName ?? (r?.taxId ? `${lookupLabel} ${r.taxId}` : '(未命名客戶)');
  }

  /**
   * 把這一筆打卡與已經拍好的照片存進裝置上的「待送出」。
   *
   * 這是整頁最重要的一段:照片原本只在 React state 裡,關掉分頁或系統回收記憶體
   * 就沒了,而人已經離開那個座標,補拍不回來。存進去之後畫面才清空。
   * 存不進去(配額滿、無痕視窗關掉 IndexedDB)時**不清空**,並且告訴使用者
   * 不要關閉分頁 —— 那時候記憶體是唯一還留著照片的地方。
   */
  async function queueCurrent(f: GpsFix, capturedAt: string, lead: string) {
    const photoCount = pendingPhotos.length;
    const res = await enqueue(
      ownerKey,
      {
        type: 'checkin',
        customerId: selectedId,
        customerName: selectedCustomerName(),
        capturedAt,
        lat: f.lat,
        lng: f.lng,
        accuracy: f.accuracy,
        note: note.trim() || undefined,
        photos: pendingPhotos,
      },
      Date.now(),
    );
    if (!res.ok) {
      setCheckMsg(null);
      setQueueError(`${lead}${res.message}`);
      return;
    }
    setQueueError(null);
    setCheckMsg(
      `${lead}這一筆打卡${photoCount > 0 ? `與 ${photoCount} 張照片` : ''}已存進這台裝置的「待送出」,` +
        '關掉分頁也不會消失。回到有網路的地方,在下方按「全部重送」即可送出。' +
        (photoCount > 0 ? '照片的拍攝時間不會被改寫,伺服器只收 24 小時內拍的,請盡快重送。' : ''),
    );
    setNote('');
    setPendingPhotos([]);
    setPhotoRefresh((n) => n + 1);
    setQueueRefresh((n) => n + 1);
  }

  async function handleCheckIn() {
    // 打卡中 / 定位中按鈕不 disabled(避免焦點掉到 body),在這裡早退
    if (checking || locating) return;
    setCheckMsg(null);
    setQueueError(null);
    setResult(null);
    if (!selectedId) {
      setCheckMsg('請先選擇要打卡的客戶');
      return;
    }
    setChecking(true);
    try {
      // 定位不需要網路,離線時照樣先取座標,存進待送出的那一筆才有座標可用
      const f = await ensureFix();
      if (!f) {
        setCheckMsg('取得座標失敗。請走到戶外或窗邊,再按「重新定位」;現在拍的照片不會不見。');
        return;
      }
      // 沒有精度就不要往下走:後端必填,存進待送出也只是每次重送都退回同一句。
      if (f.accuracy == null) {
        setCheckMsg(NO_ACCURACY_TEXT);
        return;
      }
      const capturedAt = new Date().toISOString();
      // 已經知道沒有網路就不要送了:在沒訊號的地方 fetch 會卡到逾時,
      // 讓人對著「打卡中…」等三十秒,最後還是失敗。直接存進待送出。
      if (offline) {
        await queueCurrent(f, capturedAt, '目前沒有網路連線。');
        return;
      }
      await submitCheckIn(f, capturedAt);
    } finally {
      setChecking(false);
    }
  }

  async function submitCheckIn(f: GpsFix, capturedAt: string) {
    try {
      const res = await fetch(`${checkinBase}/${selectedId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: f.lat,
          lng: f.lng,
          accuracy: f.accuracy ?? undefined,
          clientTime: capturedAt,
          note: note.trim() || undefined,
          photos: pendingPhotos.length > 0 ? pendingPhotos : undefined,
        }),
      });
      if (res.status === 404) {
        setCheckMsg('找不到客戶或沒有權限');
        return;
      }
      if (res.status === 400) {
        setCheckMsg(await apiErrorMessage(res, '打卡失敗,請檢查定位與照片後再試'));
        return;
      }
      if (res.status === 401) {
        // 登入過期。以前這裡掉進下面那個 `!res.ok`,顯示「打卡失敗,請稍後再試」,
        // 而再試永遠不會成功 —— 人就站在客戶門口一直按。
        // 訊息換成「登入已過期」,而且**不導頁**:pendingPhotos 只存在這個分頁的
        // 記憶體裡,導頁就沒了,人已經離開那個座標,補拍不回來。
        setCheckMsg(await apiErrorMessage(res, '打卡失敗,請稍後再試', { onUnauthorized: 'stay' }));
        return;
      }
      if (res.status === 413) {
        setCheckMsg('照片太大,請移除部分照片後重拍');
        return;
      }
      if (!res.ok) {
        setCheckMsg(await apiErrorMessage(res, '打卡失敗,請稍後再試', { onUnauthorized: 'stay' }));
        return;
      }
      reportNetworkSuccess();
      const d = (await res.json()) as Partial<CheckInResult>;
      const r: CheckInResult = {
        interactionId: d.interactionId ?? '',
        distanceM: typeof d.distanceM === 'number' ? d.distanceM : null,
        suspicious: d.suspicious === true,
        suspiciousReason: typeof d.suspiciousReason === 'string' ? d.suspiciousReason : null,
        photoIds: Array.isArray(d.photoIds)
          ? d.photoIds.filter((x): x is string => typeof x === 'string')
          : [],
        serverTime: typeof d.serverTime === 'string' ? d.serverTime : null,
      };
      setResult(r);
      setCheckMsg(
        r.photoIds.length > 0
          ? `已打卡(座標已記錄),已上傳 ${r.photoIds.length} 張存證照片`
          : '已打卡(座標已記錄)',
      );
      setNote('');
      setPendingPhotos([]);
      setPhotoRefresh((n) => n + 1);
      setQueueRefresh((n) => n + 1);
      // 打卡後刷新客戶清單(lastContactAt 會更新)
      await loadCustomers();
    } catch (e) {
      if (isNetworkError(e)) {
        reportNetworkFailure();
        await queueCurrent(f, capturedAt, '送不出去,目前沒有網路連線。');
        return;
      }
      setCheckMsg('打卡失敗,請稍後再試');
    }
  }

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">GPS 到訪打卡</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用外勤拜訪。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  const selectedCustomer = selectedId ? (rows.find((r) => r.id === selectedId) ?? null) : null;
  const accuracyPoor = fix?.accuracy != null && fix.accuracy > ACCURACY_WARN_M;

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">GPS 到訪打卡</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        選擇要拜訪的客戶,系統會先定位並顯示精度;依客戶場所類型拍攝存證照片(裝置端壓上客戶名稱與類型、姓名職稱、時間與座標浮水印),再按「到訪打卡」一起送出。不一定每次都要拍,但結案前必須拍齊。
      </p>

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm"
          style={{ color: 'var(--color-destructive)' }}
        >
          {error}
        </div>
      ) : null}

      <section className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        {/* 一家客戶都沒有時,只給一個選不出東西的下拉等於把人卡在這裡。
            這種情況只有兩條路可走,兩條都寫出來。 */}
        {!loading && !error && rows.length === 0 ? (
          <div className="rounded-md border border-border bg-background p-3 text-sm">
            <p>你名下還沒有客戶。先到「新增客戶」建一家,或請主管把名單分派給你,再回來打卡。</p>
            <p className="mt-2">
              <Link href="/admin/crm/new" className="btn btn-primary">
                新增客戶
              </Link>
            </p>
          </div>
        ) : null}
        <label htmlFor="field-customer" className="flex flex-col gap-1 text-sm">
          <span>拜訪客戶</span>
          <select
            id="field-customer"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            style={{ minHeight: 44 }}
            value={selectedId}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setCheckMsg(null);
              setResult(null);
              setPendingPhotos([]);
            }}
          >
            <option value="">— 請選擇客戶 —</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.companyName ?? '(未命名客戶)'}
                {r.taxId ? `(${r.taxId})` : ''}
              </option>
            ))}
          </select>
        </label>
        {listTruncated ? (
          <p className="text-xs text-muted-foreground">
            你看得到的客戶超過 {CUSTOMER_TAKE} 筆,下拉裡只有跟進日期最早的那一批。
            找不到要拜訪的那一家時,先在該客戶卡排一筆今日拜訪計畫,再從我的首頁的「今日拜訪計畫」點進來打卡。
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p id="field-accuracy" role="status" aria-live="polite" className="flex-1 text-sm">
            {locating
              ? '定位中…'
              : locateMsg
                ? locateMsg
                : fix
                  ? fix.accuracy != null
                    ? `目前定位精度約 ${Math.round(fix.accuracy)} 公尺`
                    : NO_ACCURACY_TEXT
                  : selectedId
                    ? '尚未取得定位'
                    : '選擇客戶後會自動定位'}
          </p>
          {/* 定位中 / 打卡中不 disabled(會把焦點丟掉),改 aria-busy,handler 早退 */}
          <button
            type="button"
            className="btn shrink-0"
            onClick={() => {
              if (locating || checking) return;
              void locate();
            }}
            aria-busy={locating || checking}
          >
            重新定位
          </button>
        </div>
        {fix && fix.accuracy == null && (
          <p
            role="alert"
            className="rounded-md border border-border bg-background p-2 text-sm"
            style={{ color: 'var(--color-destructive)' }}
          >
            {NO_ACCURACY_TEXT}
          </p>
        )}
        {accuracyPoor && (
          <p className="rounded-md border border-border bg-background p-2 text-sm text-warning">
            注意:定位精度不足,建議到戶外再打卡(仍可送出,主管會看到精度)。
          </p>
        )}

        {/* 拍照存證:選了客戶才顯示;key 綁客戶,換客戶就重置 */}
        {selectedId ? (
          <div className="rounded-md border border-border bg-background p-3">
            <PhotoCapture
              key={selectedId}
              mode="checkin"
              customerId={selectedId}
              customerName={
                selectedCustomer?.companyName ||
                (selectedCustomer?.taxId ? `${lookupLabel} ${selectedCustomer.taxId}` : '')
              }
              salesName={salesName}
              salesTitle={salesTitle}
              companyName={company}
              position={fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy } : undefined}
              onChange={handlePhotosChange}
              reloadKey={photoRefresh}
              disabled={checking}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">請先選擇客戶再拍照存證。</p>
        )}

        <label htmlFor="field-note" className="flex flex-col gap-1 text-sm">
          <span>備註(選填)</span>
          <textarea
            id="field-note"
            rows={2}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例:已交付報價單,下週回訪"
            maxLength={500}
          />
        </label>

        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleCheckIn()}
            disabled={loading}
            aria-busy={checking || locating}
          >
            {checking
              ? '打卡中…'
              : offline
                ? pendingPhotos.length > 0
                  ? `存到待送出(含 ${pendingPhotos.length} 張照片)`
                  : '存到待送出'
                : pendingPhotos.length > 0
                  ? `到訪打卡(含 ${pendingPhotos.length} 張照片)`
                  : '到訪打卡'}
          </button>
        </div>

        {/* 存不進待送出:照片這時候只剩記憶體裡那一份,要人立刻做點什麼,所以用 alert */}
        {queueError ? (
          <div
            role="alert"
            className="rounded-md p-3 text-sm"
            style={{
              backgroundColor: 'var(--st-red-bg)',
              color: 'var(--st-red-fg)',
              border: '2px solid var(--st-red-bar)',
            }}
          >
            <p className="font-semibold">照片沒有存進待送出</p>
            <p className="mt-1">{queueError}</p>
          </div>
        ) : null}

        {/* 離線時按鈕做的事不一樣,先講清楚再讓人按。狀態不只靠顏色,這裡就是一句話 */}
        {offline && (
          <p role="status" aria-live="polite" className="text-sm">
            目前沒有網路連線,按下去不會送到伺服器,而是存進這台裝置的「待送出」,回到有網路的地方再重送。定位與拍照不需要網路,可以照常做。
          </p>
        )}

        {selectedCustomer && !result && (
          <p className="text-xs text-muted-foreground">
            將為「{selectedCustomer.companyName ?? '(未命名客戶)'}」記錄一筆到訪打卡。
          </p>
        )}

        <div role="status" aria-live="polite">
          {checkMsg && (
            <div className="rounded-md border border-border bg-background p-2 text-sm">
              {checkMsg}
            </div>
          )}

          {result && (
            <div className="mt-3 flex flex-col gap-2 text-sm">
              {result.distanceM != null ? (
                <p>距客戶地址約 {fmtDistance(result.distanceM)}。</p>
              ) : (
                <p>客戶地址尚未定位,無法計算距離。</p>
              )}
              {result.suspicious && (
                <div
                  role="alert"
                  className="rounded-md p-3"
                  style={{
                    backgroundColor: 'var(--st-red-bg)',
                    color: 'var(--st-red-fg)',
                    border: '2px solid var(--st-red-bar)',
                  }}
                >
                  <p className="font-semibold">注意:此筆已標記待主管確認</p>
                  {result.suspiciousReason && <p className="mt-1">{result.suspiciousReason}</p>}
                </div>
              )}
              {result.photoIds.length > 0 && (
                <p>已上傳 {result.photoIds.length} 張存證照片,可在上方存證清單查看。</p>
              )}
            </div>
          )}
        </div>

        {/* 打卡完成後的去處:主按鈕回我的首頁,次按鈕清空繼續下一家 */}
        {result && (
          <div className="flex flex-wrap gap-3 border-t border-border pt-3">
            <Link href="/admin/crm/home" className="btn btn-primary">
              回我的首頁
            </Link>
            <button type="button" className="btn" onClick={resetForNext}>
              繼續下一家
            </button>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          首次使用瀏覽器或手機會請求定位與相機權限,同意後才能打卡與拍照。
        </p>
      </section>

      {/* 待送出清單:沒有東西待送就整塊不出現(元件自己判斷) */}
      <div className="mt-4">
        <PendingQueue reloadKey={queueRefresh} onFlushed={() => void loadCustomers()} />
      </div>

      <p className="mt-6 flex flex-wrap gap-3 text-sm">
        <Link href="/admin/crm/field/report" className="underline underline-offset-2">
          寫今天的拜訪日報
        </Link>
        <Link href="/admin/crm/map" className="underline underline-offset-2">
          看拜訪地圖
        </Link>
      </p>
    </div>
  );
}

export default function FieldCheckinPage() {
  // useSearchParams 需要 Suspense 邊界,預先包起來(?customerId= 由我的首頁與拜訪計畫帶進來)
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">載入中…</div>}>
      <CheckinInner />
    </Suspense>
  );
}
