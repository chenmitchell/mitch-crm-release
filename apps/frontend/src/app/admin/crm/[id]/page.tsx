'use client';

// 客戶卡詳情頁(/admin/crm/[id])。
// 資料來源:GET/PATCH /api/admin/crm/:id、POST /api/admin/crm/:id/{interactions,transfer}。
// 訪查人員清單(轉派下拉)取自 GET /api/admin/crm/sales-users(回 { rows: [{id,name}] };限主管/admin)。
// 角色:admin/sales/sales_manager 可用;轉派僅 admin/sales_manager(isManager)。
// 存證照片:GET /api/admin/crm-checkin/:customerId/photos(必備清單 + 已拍 + 缺項),
// 圖檔 GET /api/admin/crm-checkin/photo/:photoId(帶 cookie 抓成 blob URL 顯示)。
// 成交:GET /api/admin/crm/:id/convert-check 先問「還缺什麼」,齊備才 POST /api/admin/crm/:id/convert
//   (右欄的「標記為成交」動作區,元件在 components/crm/convert-panel.tsx)。
// 補拍:存證照片區的「補拍存證照片」直接用 PhotoCapture 的 standalone 模式,
//   照片走 POST /api/admin/crm-checkin/:customerId/photos,不會另外記一次到訪。
// 刪除:GET /api/admin/crm/:id/delete-check 先問「刪得掉嗎、會帶走什麼」,再 DELETE /api/admin/crm/:id。
// 刪除是軟刪除,客戶會從所有清單消失但資料還在,主管可以在 /admin/crm/data 的回收桶還原。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { Route } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import VisitPlanPanel from '@/components/crm/visit-plan-panel';
import ConvertPanel from '@/components/crm/convert-panel';
import PhotoCapture from '@/components/crm/photo-capture';
import { isConvertedCustomer } from '@/lib/crm-convert';
import { useMe } from '@/lib/me-context';
import {
  canUseCrm,
  isViewAllRole,
  useCrmRole,
  useStageMeta,
  type CrmCustomerCard,
} from '@/lib/crm-shared';
import {
  labelOf,
  manualChannels,
  useAppSettings,
  useCrmVocab,
  useLookupLabel,
  usePhotoKindLabel,
} from '@/lib/app-settings';
// 日期換算全部走組織時區的那一份(純函式,測試在 tests/org-time.spec.ts)
import { fmtOrgDate, fmtOrgDateTime, followUpPatch, toDateInput } from '@/lib/crm-dates';

// 互動管道與場所類型都由後台決定(dev_interaction_channels / dev_premises_types),
// 這裡不留任何一份寫死的清單或中文對照表:留了的話,設備維修公司想把管道換成
// 「工單、現場、電話」就得改程式重新部署,而那正是這套系統要避免的事。
// 清單從 useCrmVocab() 讀,見 lib/app-settings.tsx。
type ChannelKey = string;
type PremisesType = string;

// 存證照片類型的 key(與後端 VisitPhotoKind enum 一致)。
// 顯示用的中文由後台的照片存證檢查表決定,見 lib/app-settings.tsx 的 usePhotoKindLabel()。
type PhotoKind = string;

interface VisitPhoto {
  id: string;
  kind: PhotoKind | string;
  takenAt: string;
  interactionId: string;
  byName: string | null;
  sizeBytes: number;
}
/**
 * 存證照片的配額現況(後端 listPhotos 回的 quota)。
 *
 * over 為真表示這位客戶的照片已經超過「每位客戶 40 張 / 20MB」的上限,而超額
 * 只可能來自查重合併:合併把兩筆重複客戶的照片併到同一筆,刻意不擋(擋了重複
 * 建檔就修不乾淨)。代價是這一筆之後的補拍會被擋下來,所以要在畫面上直接寫出來,
 * 不要讓使用者按下補拍才知道。notice 由後端寫好整句,前端不自己拼字。
 */
interface PhotoQuota {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
  over: boolean;
  overCount: number;
  overBytes: number;
  notice: string | null;
}
interface PhotosInfo {
  premisesType: PremisesType | null;
  premisesTypeMissing?: boolean;
  required: (PhotoKind | string)[];
  photos: VisitPhoto[];
  missing: (PhotoKind | string)[];
  quota?: PhotoQuota | null;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Interaction {
  id: string;
  channel: ChannelKey | string;
  note: string | null;
  occurredAt: string;
  nextAction: string | null;
  user: { name: string | null } | null;
}
/**
 * 客戶卡的回應。
 *
 * 客戶本身的欄位不在這裡手寫,直接用前後端共用的契約 CrmCustomerCard
 * (定義在 @mitchcrm/shared 的 api/,後端 crm.service.ts 對同一份負責)。
 * 手寫一份的話,後端少給一格不會有任何檢查看得到,畫面上只會空白。
 * 時間軸與 _count 是這一頁自己要的關聯資料,接在這裡。
 */
type DevCustomer = Omit<CrmCustomerCard, 'premisesType'> & {
  /** 場所類型;這一頁另外收斂成後台設定過的代碼(見 PremisesType) */
  premisesType?: PremisesType | null;
  interactions: Interaction[];
  /** 時間軸只帶最近 50 筆,總筆數另外由後端的 _count 提供 */
  _count?: { interactions: number };
};

interface UserRow {
  id: string;
  name: string | null;
  role?: string;
  status?: string;
}

/** 管道代碼 → 名稱。清單由呼叫端從設定帶進來;查不到就顯示代碼本身 */
function channelLabelOf(
  channels: ReadonlyArray<{ key: string; label: string }>,
  c: string | null,
): string {
  if (!c) return '—';
  return labelOf(channels, c) || '—';
}
// 日期換算全部走 lib/crm-dates(以組織設定的時區為準,不是看畫面的人的裝置時區)。
// 這一頁原本自己寫了三支用 getFullYear() / getMonth() / getDate() / getHours() 的小工具,
// 那是瀏覽器時區;而後端的逾期、地圖「今日要拜訪」與統計全部走組織時區,兩邊會差一天。

// ---- 編輯表單狀態 ----
interface EditState {
  taxId: string;
  companyName: string;
  representative: string;
  registeredAddress: string;
  actualAddress: string;
  contactAddress: string;
  website: string;
  social: string;
  category: string;
  stage: string;
  source: string;
  contactName: string;
  contactPhone: string;
  note: string;
  nextFollowUpAt: string;
}
/**
 * 商業分類的值來自 dev_categories(後台可增減),不是寫死的清單。
 *
 * 客戶身上可能留著主檔裡沒有的舊值(分類主檔上線前存的是顯示文字)。
 * 那種值原樣留著,並在下拉裡多開一個選項給它 —— 硬把它清成空白或
 * 塞成「其他」,等於在使用者沒按存檔的情況下改掉他的資料。
 */
function toEditState(c: DevCustomer, knownStages: readonly string[], timeZone: string): EditState {
  const cat = c.category ?? '';
  return {
    taxId: c.taxId ?? '',
    companyName: c.companyName ?? '',
    representative: c.representative ?? '',
    registeredAddress: c.registeredAddress ?? '',
    actualAddress: c.actualAddress ?? '',
    contactAddress: c.contactAddress ?? '',
    website: c.website ?? '',
    social: c.social ?? '',
    category: cat,
    stage: knownStages.includes(c.stage) ? c.stage : (knownStages[0] ?? c.stage),
    source: c.source ?? '',
    contactName: c.contactName ?? '',
    contactPhone: c.contactPhone ?? '',
    note: c.note ?? '',
    nextFollowUpAt: toDateInput(c.nextFollowUpAt, timeZone),
  };
}

// 縮圖按鈕:圖還沒抓回來時顯示文字;點了放大
function PhotoThumb({
  url,
  kindLabel,
  onOpen,
}: {
  url: string | undefined;
  /** 這張是哪一類的照片(中文)。由呼叫端從後台的照片檢查表查好再傳進來 */
  kindLabel: string;
  onOpen: () => void;
}) {
  const label = `放大檢視${kindLabel}照片`;
  if (!url) {
    return (
      <div
        role="img"
        aria-label={`${kindLabel}照片載入中`}
        className="flex h-24 w-32 shrink-0 items-center justify-center rounded border border-border bg-muted text-xs text-muted-foreground"
      >
        圖片載入中…
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="h-24 w-32 shrink-0 overflow-hidden rounded border border-border p-0"
    >
      <Image
        src={url}
        alt=""
        width={128}
        height={96}
        unoptimized
        className="h-24 w-32 object-cover"
      />
    </button>
  );
}

// 小工具:key-value 一列
function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

const inputCls = 'rounded-md border border-border bg-background px-2 py-1.5 text-sm';

/**
 * 刪除前預檢的回應(GET /api/admin/crm/:id/delete-check)。
 * block 不為 null 代表被擋下來;forcible 為 true 時系統管理員可以帶 force 強制。
 */
interface DeleteCheck {
  canDelete: boolean;
  block: { code: string; message: string; forcible: boolean } | null;
  facts: { humanInteractions: number; photos: number; converted: boolean };
}

export default function CrmDetailPage() {
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();

  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : (params?.id as string | undefined);

  // 角色走共用 hook(見 lib/crm-shared 的 useCrmRole),整站對 /api/auth/me 只有一個呼叫點
  const role = useCrmRole();
  const router = useRouter();
  const [customer, setCustomer] = useState<DevCustomer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  /**
   * 此客戶已被合併。
   *
   * 後端 400 的 body 是 { message, mergedIntoId }(見後端 crm-messages.ts 的
   * mergedCustomerError):mergedIntoId 只有在「這個人本來就看得到保留的那一筆」時
   * 才有值,看不到的人拿到 null,畫面只顯示訊息不給連結。
   * 原本是從訊息字串裡用正則抓 uuid,而訊息裡從來沒有 uuid,整段是永遠到不了的死碼。
   */
  const [merged, setMerged] = useState<{ mergedIntoId: string | null } | null>(null);

  // 編輯
  const [editing, setEditing] = useState(false);
  /** 檢視與編輯互相取代,焦點要在兩邊之間交接:進編輯給表單第一格,離開還給「編輯」那顆 */
  const editBtnRef = useRef<HTMLButtonElement>(null);
  const editFirstFieldRef = useRef<HTMLInputElement>(null);
  /** 編輯表單開著沒有:loadCustomer 在 callback 裡看的是這一份,不然它會吃到舊的閉包 */
  const editingRef = useRef(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editMsg, setEditMsg] = useState<string | null>(null);

  // 日期一律以組織設定的時區顯示與寫入(後端的逾期、地圖「今日要拜訪」、
  // 統計全部走這個時區;這一頁以前用的是瀏覽器時區,兩邊會差一天)
  const { timezone, organizationName } = useAppSettings();
  // 補拍的浮水印要印訪查人員姓名與職稱,跟外勤打卡頁同一份來源
  const { me } = useMe();

  // 互動管道與場所類型:兩份清單都由後台決定
  const { channels, premisesTypes, categories } = useCrmVocab();
  const channelOptions = useMemo(() => manualChannels(channels), [channels]);
  useEffect(() => {
    // 清單換過之後(或第一次載進來),把選到的管道收斂回清單裡的第一個
    setLogChannel((cur) =>
      channelOptions.some((c) => c.key === cur) ? cur : (channelOptions[0]?.key ?? ''),
    );
  }, [channelOptions]);

  // 三秒記錄。預設選第一個可手動記錄的管道,不寫死 call ——
  // 後台把管道整組換掉之後,寫死的預設值會是一個下拉裡不存在的選項
  const [logChannel, setLogChannel] = useState<ChannelKey>('');
  const [logNote, setLogNote] = useState('');
  const [logNext, setLogNext] = useState('');
  const [logSaving, setLogSaving] = useState(false);
  const [logMsg, setLogMsg] = useState<string | null>(null);

  // 轉派
  const [users, setUsers] = useState<UserRow[]>([]);
  const [usersErr, setUsersErr] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [transferSaving, setTransferSaving] = useState(false);
  const [transferMsg, setTransferMsg] = useState<string | null>(null);

  // 刪除。三段式:按「刪除這筆客戶」先打 delete-check(唯讀),把「會帶走什麼」講清楚,
  // 使用者看過再按確定。直接跳一個 confirm() 對話框問「確定嗎」等於什麼都沒說。
  const [deleteCheck, setDeleteCheck] = useState<DeleteCheck | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  // 標記為成交。convertRefresh 一加一,右欄的成交動作區就重新打一次 convert-check
  // (改完場所類型、補拍完照片之後,畫面上的「還缺什麼」要跟著更新)。
  const [convertRefresh, setConvertRefresh] = useState(0);
  // 存證照片的補拍區(PhotoCapture 的 standalone 模式)。展開時由它自己畫存證清單,
  // 所以這一頁唯讀的那份縮圖清單先收起來,兩份清單不會在同一個畫面上互相矛盾。
  const [captureOpen, setCaptureOpen] = useState(false);
  const premisesSelectRef = useRef<HTMLSelectElement | null>(null);
  const captureToggleRef = useRef<HTMLButtonElement | null>(null);

  // 場所類型(改變即 PATCH)
  const [premisesSaving, setPremisesSaving] = useState(false);
  const [premisesMsg, setPremisesMsg] = useState<string | null>(null);
  // 忙碌旗標用 ref 早退,不用 disabled(disabled 會讓焦點掉出去;改用 aria-busy 保留可聚焦)
  const premisesBusyRef = useRef(false);

  // 存證照片
  const [photosInfo, setPhotosInfo] = useState<PhotosInfo | null>(null);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosErr, setPhotosErr] = useState<string | null>(null);
  // photoId → blob URL(帶 cookie 抓回來的圖);unmount 時 revoke
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const photoUrlsRef = useRef<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<VisitPhoto | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // 階段清單由後台設定供應(lib/app-settings),不在這一頁寫死
  const stageMeta = useStageMeta();
  const photoKindLabelOf = usePhotoKindLabel();
  const formStageKeys = useMemo(() => stageMeta.form.map((st) => st.key), [stageMeta]);

  const base = getApiBase();
  const crmBase = `${base}/api/admin/crm`;
  const checkinBase = `${base}/api/admin/crm-checkin`;

  const canUse = canUseCrm(role);
  const isManager = isViewAllRole(role);

  // 載入客戶卡
  const loadCustomer = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    if (!id) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound(false);
    setMerged(null);
    try {
      const res = await fetch(`${crmBase}/${id}`, { credentials: 'include' });
      if (res.status === 404 || res.status === 403) {
        setNotFound(true);
        return;
      }
      if (res.status === 400) {
        // 被合併掉的客戶:body 的 mergedIntoId 就是保留的那一筆(看不到它的人拿到 null)
        const body = (await res
          .clone()
          .json()
          .catch(() => null)) as { mergedIntoId?: unknown } | null;
        const msg = await apiErrorMessage(res, '');
        if (msg.includes('已合併')) {
          setMerged({
            mergedIntoId: typeof body?.mergedIntoId === 'string' ? body.mergedIntoId : null,
          });
          return;
        }
        setError(msg || '客戶資料載入失敗,請稍後再試');
        return;
      }
      if (!res.ok) {
        // 401 走共用規則:訊息換成「登入已過期」並導回登入頁(帶 next)。
        // 以前這裡一律顯示「載入失敗,請稍後再試」,而再試永遠不會成功。
        setError(await apiErrorMessage(res, '客戶資料載入失敗,請稍後再試'));
        return;
      }
      const data = (await res.json()) as DevCustomer;
      setCustomer(data);
      // 為了補件而暫時收起來的編輯內容(見 startEdit / focusPremises)在這裡作廢:
      // 那份是照舊資料填的,伺服器上的欄位已經換過一輪,再套回去等於用舊值覆蓋。
      if (!editingRef.current) setEdit(null);
    } catch {
      setError('客戶資料載入失敗,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canUse, id, crmBase]);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    void loadCustomer();
  }, [loadCustomer]);

  // 載入存證照片清單(必備清單 + 已拍 + 缺項);回傳結果給結案預檢用
  const loadPhotos = useCallback(async (): Promise<{ info: PhotosInfo } | { error: string }> => {
    if (!id || !canUse) return { error: '無法確認存證照片狀態,請稍後再試' };
    setPhotosLoading(true);
    setPhotosErr(null);
    try {
      const res = await fetch(`${checkinBase}/${id}/photos`, { credentials: 'include' });
      if (!res.ok) {
        const error = await apiErrorMessage(res, '存證照片載入失敗,請稍後再試');
        setPhotosErr(error);
        return { error };
      }
      const data = (await res.json()) as Partial<PhotosInfo>;
      const info: PhotosInfo = {
        premisesType: data.premisesType ?? null,
        premisesTypeMissing: data.premisesTypeMissing,
        required: Array.isArray(data.required) ? data.required : [],
        photos: Array.isArray(data.photos) ? data.photos : [],
        missing: Array.isArray(data.missing) ? data.missing : [],
        // 舊版後端沒有這一包,當作沒有超額(前端就不顯示那段說明)
        quota: data.quota ?? null,
      };
      setPhotosInfo(info);
      return { info };
    } catch {
      const error = '存證照片載入失敗,請稍後再試';
      setPhotosErr(error);
      return { error };
    } finally {
      setPhotosLoading(false);
    }
  }, [id, canUse, checkinBase]);

  useEffect(() => {
    if (role === null) return;
    void loadPhotos();
  }, [role, loadPhotos]);

  // 依清單抓圖:每張 fetch 一次(帶 cookie)轉 blob URL;已抓過的不重抓
  useEffect(() => {
    if (!photosInfo) return;
    let alive = true;
    // 清單重載後已不存在的照片(被刪、被別人重拍),先把它的 blob URL 釋放掉
    const ids = new Set(photosInfo.photos.map((p) => p.id));
    const stale = Object.keys(photoUrlsRef.current).filter((id) => !ids.has(id));
    if (stale.length > 0) {
      const next = { ...photoUrlsRef.current };
      for (const id of stale) {
        const url = next[id];
        if (url) URL.revokeObjectURL(url);
        delete next[id];
      }
      photoUrlsRef.current = next;
      setPhotoUrls(next);
    }
    const todo = photosInfo.photos.filter((p) => !photoUrlsRef.current[p.id]);
    if (todo.length === 0) return;
    (async () => {
      for (const p of todo) {
        try {
          const res = await fetch(`${checkinBase}/photo/${p.id}`, { credentials: 'include' });
          if (!res.ok) continue;
          const blob = await res.blob();
          if (!alive) return;
          const url = URL.createObjectURL(blob);
          photoUrlsRef.current = { ...photoUrlsRef.current, [p.id]: url };
          setPhotoUrls(photoUrlsRef.current);
        } catch {
          // 單張抓不到就顯示文字說明,不影響其他張
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [photosInfo, checkinBase]);

  // 離開頁面時釋放 blob URL
  useEffect(() => {
    return () => {
      for (const url of Object.values(photoUrlsRef.current)) URL.revokeObjectURL(url);
      photoUrlsRef.current = {};
    };
  }, []);

  // 放大檢視:用原生 <dialog>,Esc 由瀏覽器處理,關閉事件同步狀態
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (lightbox && !dlg.open) dlg.showModal();
    else if (!lightbox && dlg.open) dlg.close();
  }, [lightbox]);

  async function changePremises(value: string) {
    if (!id || !customer) return;
    if (premisesBusyRef.current) return;
    // 只收主檔裡有的代碼;未選(空字串)與不認得的值一律視為清掉
    const next: PremisesType | null = premisesTypes.some((p) => p.key === value) ? value : null;
    premisesBusyRef.current = true;
    setPremisesSaving(true);
    setPremisesMsg(null);
    try {
      const res = await fetch(`${crmBase}/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ premisesType: next }),
      });
      if (!res.ok) {
        setPremisesMsg(await apiErrorMessage(res, '場所類型儲存失敗,請稍後再試'));
        return;
      }
      setCustomer({ ...customer, premisesType: next });
      setPremisesMsg(next ? `已設為${labelOf(premisesTypes, next)}` : '已清除場所類型');
      await loadPhotos();
      // 場所類型決定要拍哪幾張,成交預檢的答案跟著變
      setConvertRefresh((n) => n + 1);
    } catch {
      setPremisesMsg('場所類型儲存失敗,請稍後再試');
    } finally {
      premisesBusyRef.current = false;
      setPremisesSaving(false);
    }
  }

  /**
   * 補件入口(一):把焦點送回場所類型那一格。
   * 編輯表單開著的時候那一格不在畫面上,所以先收掉表單,下一輪 render 才送焦點。
   * scrollIntoView 用預設的瞬間捲動,不做平滑動畫(尊重 prefers-reduced-motion)。
   */
  const focusPremises = useCallback(() => {
    setEditing(false);
    requestAnimationFrame(() => {
      const el = premisesSelectRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.focus();
    });
  }, []);

  /** 補件入口(二):展開存證照片的補拍區,焦點落在補拍那一顆按鈕上 */
  const openCapture = useCallback(() => {
    setCaptureOpen(true);
    requestAnimationFrame(() => {
      const el = captureToggleRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      el.focus();
    });
  }, []);

  /** 收合補拍區:補拍期間照片是由 PhotoCapture 直接上傳的,收合時把這一頁的清單與成交預檢重讀 */
  const closeCapture = useCallback(async () => {
    setCaptureOpen(false);
    await loadPhotos();
    setConvertRefresh((n) => n + 1);
    captureToggleRef.current?.focus();
  }, [loadPhotos]);

  // 載入訪查人員清單(給轉派下拉)—— 僅主管需要
  useEffect(() => {
    if (!isManager) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${base}/api/admin/crm/sales-users`, { credentials: 'include' });
        if (!res.ok) {
          if (alive) setUsersErr('訪查人員清單載入失敗');
          return;
        }
        const data = (await res.json()) as { rows?: UserRow[] };
        const sales = data.rows ?? [];
        if (alive) {
          setUsers(sales);
          setUsersErr(sales.length === 0 ? '沒有可轉派的訪查人員' : null);
        }
      } catch {
        if (alive) setUsersErr('訪查人員清單載入失敗');
      }
    })();
    return () => {
      alive = false;
    };
  }, [isManager, base]);

  function startEdit() {
    if (!customer) return;
    // 已經有填到一半的內容就接著用。成交面板的「去選場所類型」會把表單收起來
    // (那一格在唯讀那一面),重建的話,使用者剛打進去、還沒儲存的欄位會靜靜消失。
    // 按「取消」與儲存成功都會把 edit 清成 null,那兩條路徑照樣是從客戶資料重建。
    if (!edit) setEdit(toEditState(customer, formStageKeys, timezone));
    setEditMsg(null);
    setEditing(true);
    // 「編輯」這顆按鈕在切過去之後就不見了,焦點會跟著掉到 body。
    // 下一輪 render 把焦點交給表單第一格,鍵盤使用者才接得下去。
    requestAnimationFrame(() => editFirstFieldRef.current?.focus());
  }
  function cancelEdit() {
    setEditing(false);
    setEdit(null);
    setEditMsg(null);
    // 反過來也一樣:表單收掉之後焦點要回到觸發它的那顆「編輯」
    requestAnimationFrame(() => editBtnRef.current?.focus());
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit || !id || !customer) return;
    const taxId = edit.taxId.trim();
    const companyName = edit.companyName.trim();
    if (!taxId && !companyName) {
      setEditMsg(`${lookupLabel}或公司名至少要填一個`);
      return;
    }
    const category = edit.category.trim();
    setSavingEdit(true);
    setEditMsg(null);
    try {
      const body: Record<string, unknown> = {
        taxId: taxId || null,
        companyName: companyName || null,
        representative: edit.representative.trim() || null,
        registeredAddress: edit.registeredAddress.trim() || null,
        actualAddress: edit.actualAddress.trim() || null,
        contactAddress: edit.contactAddress.trim() || null,
        website: edit.website.trim() || null,
        social: edit.social.trim() || null,
        category: category || null,
        source: edit.source.trim() || null,
        contactName: edit.contactName.trim() || null,
        contactPhone: edit.contactPhone.trim() || null,
        note: edit.note.trim() || null,
      };
      /**
       * 跟進日「沒改就不送」。
       *
       * 這一格在畫面上是 <input type="date">,只有日期沒有時間,所以送出去一定會
       * 把時間壓成當天的 00:00。原本每次存檔都無條件送,後果是:打卡流程設定的
       * 「9/10 14:30」跟進時間,只要有人在客戶卡上改了**其他任何欄位**再存檔,
       * 就會被靜默改寫成 9/10 00:00 —— 使用者沒有碰過那一格,畫面上也沒有任何提示。
       * 比對用的是同一個時區換算出來的日期字串(toDateInput ⇄ toInstantFromDateInput
       * 是一來一回),所以「打開什麼都不改就存檔」一定判定為沒改。
       */
      Object.assign(body, followUpPatch(edit.nextFollowUpAt, customer.nextFollowUpAt, timezone));
      // 階段沒改就不送 stage,免得後端把「原樣送回」也當成一次階段變更寫進稽核記錄
      if (edit.stage !== customer.stage) body.stage = edit.stage;
      const res = await fetch(`${crmBase}/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setEditMsg(await apiErrorMessage(res, '儲存失敗,請確認欄位後再試'));
        return;
      }
      setEditing(false);
      setEdit(null);
      // 儲存成功後表單也收掉,焦點同樣還給「編輯」那顆,不要掉到 body
      requestAnimationFrame(() => editBtnRef.current?.focus());
      await loadCustomer();
    } catch {
      setEditMsg('儲存失敗,請稍後再試');
    } finally {
      setSavingEdit(false);
    }
  }

  async function addInteraction(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    if (!logNote.trim() && !logNext.trim()) {
      setLogMsg('請至少填寫內容或下一步');
      return;
    }
    setLogSaving(true);
    setLogMsg(null);
    try {
      const body = {
        channel: logChannel,
        note: logNote.trim() || null,
        nextAction: logNext.trim() || null,
      };
      const res = await fetch(`${crmBase}/${id}/interactions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setLogMsg(await apiErrorMessage(res, '記錄失敗,請稍後再試'));
        return;
      }
      setLogNote('');
      setLogNext('');
      setLogChannel('call');
      setLogMsg('已記錄');
      await loadCustomer();
    } catch {
      setLogMsg('記錄失敗,請稍後再試');
    } finally {
      setLogSaving(false);
    }
  }

  /** 刪除前預檢:先問清楚這一筆會帶走什麼,再讓使用者決定 */
  async function askDelete() {
    if (!id) return;
    setDeleteBusy(true);
    setDeleteMsg(null);
    try {
      const res = await fetch(`${crmBase}/${id}/delete-check`, { credentials: 'include' });
      if (!res.ok) {
        setDeleteMsg(await apiErrorMessage(res, '無法確認這筆客戶能不能刪除,請稍後再試'));
        return;
      }
      setDeleteCheck((await res.json()) as DeleteCheck);
    } catch {
      setDeleteMsg('無法確認這筆客戶能不能刪除,請稍後再試');
    } finally {
      setDeleteBusy(false);
    }
  }

  /**
   * 送出刪除。force 只有系統管理員按得到,而且後端會再擋一次 ——
   * 前端隱藏按鈕只是輔助,授權一律在後端做。
   */
  async function doDelete(force: boolean) {
    if (!id) return;
    setDeleteBusy(true);
    setDeleteMsg(null);
    try {
      const res = await fetch(`${crmBase}/${id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReason.trim() || undefined, force }),
      });
      if (!res.ok) {
        setDeleteMsg(await apiErrorMessage(res, '刪除失敗,請稍後再試'));
        return;
      }
      // 客戶卡本身已經讀不到了(後端對已刪除的客戶回 404),留在這一頁只會看到錯誤畫面
      router.push('/admin/crm/search' as Route);
    } catch {
      setDeleteMsg('刪除失敗,請稍後再試');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function doTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !transferTo) {
      setTransferMsg('請先選擇要轉派的訪查人員');
      return;
    }
    setTransferSaving(true);
    setTransferMsg(null);
    try {
      const res = await fetch(`${crmBase}/${id}/transfer`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: transferTo }),
      });
      if (!res.ok) {
        setTransferMsg(
          await apiErrorMessage(res, res.status === 403 ? '你沒有轉派權限' : '轉派失敗,請稍後再試'),
        );
        return;
      }
      setTransferTo('');
      setTransferMsg('已轉派');
      await loadCustomer();
    } catch {
      setTransferMsg('轉派失敗,請稍後再試');
    } finally {
      setTransferSaving(false);
    }
  }

  const title = useMemo(() => {
    if (!customer) return '客戶卡';
    return customer.companyName || customer.taxId || '(未命名)';
  }, [customer]);

  // 存證照片狀態一句話(區塊頂部用;不靠顏色,直接寫字)
  const photoStatusText = useMemo<string | null>(() => {
    if (!photosInfo) return null;
    if (photosInfo.premisesTypeMissing || !photosInfo.premisesType)
      return '請先選擇場所類型,才知道要拍哪些存證照片';
    if (photosInfo.missing.length === 0) return '存證照片已齊全';
    return `還缺 ${photosInfo.missing.length} 張:${photosInfo.missing.map(photoKindLabelOf).join('、')}`;
  }, [photosInfo, photoKindLabelOf]);
  const lightboxUrl = lightbox ? photoUrls[lightbox.id] : undefined;

  // ---- render ----
  if (role === null || loading) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">客戶卡</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用客戶管理。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }
  if (merged) {
    return (
      <div className="p-6">
        <Link href="/admin/crm" className="text-sm text-muted-foreground hover:underline">
          回客戶看板
        </Link>
        {/* 每一種狀態畫面都要有自己的 h1:少了它,螢幕閱讀器使用者用標題導覽跳進來
            只會聽到一段孤立的內文,說不出現在看的是哪一頁(WCAG 2.4.6) */}
        <h1 className="mt-2 text-lg font-semibold">客戶卡</h1>
        <div
          role="status"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-foreground"
        >
          <p>此客戶已合併到另一筆客戶,互動紀錄都在保留的那筆底下。</p>
          {merged.mergedIntoId ? (
            <Link
              href={`/admin/crm/${merged.mergedIntoId}` as Route}
              className="btn mt-3 inline-flex"
            >
              前往保留的客戶卡
            </Link>
          ) : (
            // 保留的那一筆不在這個人的可見範圍內(例如合併之後又被移交出去),
            // 給連結只會導到「找不到」,所以改講下一步該怎麼辦
            <p className="mt-2">
              保留的那一筆不在你負責的範圍內。請回客戶清單重新搜尋,或請主管協助。
            </p>
          )}
        </div>
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="p-6">
        <Link href="/admin/crm" className="text-sm text-muted-foreground hover:underline">
          回客戶看板
        </Link>
        <h1 className="mt-2 text-lg font-semibold">客戶卡</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          找不到此客戶,或你沒有檢視此客戶的權限。
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <Link href="/admin/crm" className="text-sm text-muted-foreground hover:underline">
          回客戶看板
        </Link>
        <h1 className="mt-2 text-lg font-semibold">客戶卡</h1>
        {/* role="alert":這一段是取代整頁內容的錯誤,不是靜態說明文字。
            少了它,載入失敗時螢幕閱讀器什麼都不會說,畫面看起來像空白頁 */}
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm"
          style={{ color: 'var(--color-destructive)' }}
        >
          {error}
        </div>
      </div>
    );
  }
  if (!customer) return null;

  return (
    <div className="p-6">
      <Link href="/admin/crm" className="text-sm text-muted-foreground hover:underline">
        回客戶看板
      </Link>

      <div className="mt-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {stageMeta.label(customer.stage)}、承辦人員 {customer.owner?.name || '未指派'}
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            ref={editBtnRef}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:bg-muted"
            onClick={startEdit}
          >
            編輯
          </button>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 左:客戶資料卡 */}
        <div className="lg:col-span-2">
          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-base font-semibold">客戶資料</h2>

            {!editing ? (
              <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
                <KV label="公司名稱">{customer.companyName || '—'}</KV>
                <KV label={lookupLabel}>{customer.taxId || '—'}</KV>
                <KV label="公司負責人">{customer.representative || '—'}</KV>
                <KV label="商業分類">{labelOf(categories, customer.category) || '未分類'}</KV>
                <KV label="客戶階段">{stageMeta.label(customer.stage)}</KV>
                <div className="flex flex-col gap-0.5 py-1.5">
                  <label htmlFor="premises-type" className="text-xs text-muted-foreground">
                    場所類型(結案前必選,決定要拍哪些存證照片)
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      id="premises-type"
                      ref={premisesSelectRef}
                      className={`min-h-[44px] ${inputCls}`}
                      value={customer.premisesType ?? ''}
                      aria-busy={premisesSaving}
                      onChange={(e) => void changePremises(e.target.value)}
                    >
                      <option value="">未設定</option>
                      {premisesTypes.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <span
                      role="status"
                      aria-live="polite"
                      className="text-xs text-muted-foreground"
                    >
                      {premisesSaving ? '儲存中…' : (premisesMsg ?? '')}
                    </span>
                  </div>
                </div>
                <KV label="來源">{customer.source || '—'}</KV>
                <KV label="窗口">{customer.contactName || '—'}</KV>
                <KV label="窗口電話">{customer.contactPhone || '—'}</KV>
                <KV label="登記地址">{customer.registeredAddress || '—'}</KV>
                <KV label="實際營業地址">{customer.actualAddress || '—'}</KV>
                <KV label="聯絡/寄送地址">{customer.contactAddress || '—'}</KV>
                <KV label="公司網站">
                  {customer.website ? (
                    <a
                      href={
                        /^https?:\/\//.test(customer.website)
                          ? customer.website
                          : `https://${customer.website}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {customer.website}
                    </a>
                  ) : (
                    '—'
                  )}
                </KV>
                <KV label="社群">{customer.social || '—'}</KV>
                <KV label="下次跟進">{fmtOrgDate(customer.nextFollowUpAt, timezone)}</KV>
                <div className="md:col-span-2">
                  <KV label="備註">
                    <span className="whitespace-pre-wrap">{customer.note || '—'}</span>
                  </KV>
                </div>
              </div>
            ) : edit ? (
              <form className="grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={saveEdit}>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{lookupLabel}</span>
                  <input
                    ref={editFirstFieldRef}
                    className={inputCls}
                    value={edit.taxId}
                    onChange={(e) => setEdit({ ...edit, taxId: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>公司名({lookupLabel}或公司名至少一個)</span>
                  <input
                    className={inputCls}
                    value={edit.companyName}
                    onChange={(e) => setEdit({ ...edit, companyName: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>公司負責人</span>
                  <input
                    className={inputCls}
                    value={edit.representative}
                    onChange={(e) => setEdit({ ...edit, representative: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>商業分類</span>
                  <select
                    className={inputCls}
                    value={edit.category}
                    onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                  >
                    <option value="">請選擇</option>
                    {categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                    {edit.category && !categories.some((c) => c.key === edit.category) ? (
                      <option value={edit.category}>{edit.category}(目前的值)</option>
                    ) : null}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>客戶階段</span>
                  <select
                    className={inputCls}
                    value={edit.stage}
                    onChange={(e) => setEdit({ ...edit, stage: e.target.value })}
                  >
                    {/* 這一筆目前的階段若已被管理者從清單裡拿掉,還是要列出來,
                        否則一存檔就被悄悄換成別的階段,使用者不會發現 */}
                    {!stageMeta.form.some((st) => st.key === edit.stage) && (
                      <option value={edit.stage}>{stageMeta.label(edit.stage)}</option>
                    )}
                    {stageMeta.form.map((st) => (
                      <option key={st.key} value={st.key}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground">
                    階段清單由系統管理員在系統設定維護
                  </span>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>來源</span>
                  <input
                    className={inputCls}
                    value={edit.source}
                    onChange={(e) => setEdit({ ...edit, source: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>窗口</span>
                  <input
                    className={inputCls}
                    value={edit.contactName}
                    onChange={(e) => setEdit({ ...edit, contactName: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>窗口電話</span>
                  <input
                    className={inputCls}
                    value={edit.contactPhone}
                    onChange={(e) => setEdit({ ...edit, contactPhone: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>下次跟進</span>
                  <input
                    type="date"
                    className={inputCls}
                    value={edit.nextFollowUpAt}
                    onChange={(e) => setEdit({ ...edit, nextFollowUpAt: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  <span>登記地址</span>
                  <input
                    className={inputCls}
                    value={edit.registeredAddress}
                    onChange={(e) => setEdit({ ...edit, registeredAddress: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  <span>實際營業地址</span>
                  <input
                    className={inputCls}
                    value={edit.actualAddress}
                    onChange={(e) => setEdit({ ...edit, actualAddress: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  <span>聯絡/寄送地址</span>
                  <input
                    className={inputCls}
                    value={edit.contactAddress}
                    onChange={(e) => setEdit({ ...edit, contactAddress: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  <span>公司網站</span>
                  <input
                    className={inputCls}
                    value={edit.website}
                    onChange={(e) => setEdit({ ...edit, website: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  <span>社群</span>
                  <input
                    className={inputCls}
                    value={edit.social}
                    onChange={(e) => setEdit({ ...edit, social: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm md:col-span-2">
                  <span>備註</span>
                  <textarea
                    className={`min-h-[72px] ${inputCls}`}
                    value={edit.note}
                    onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  />
                </label>
                <div className="flex items-center gap-3 md:col-span-2">
                  <button
                    type="submit"
                    disabled={savingEdit}
                    className="rounded-lg border border-border bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
                  >
                    {savingEdit ? '儲存中…' : '儲存'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="rounded-lg border border-border bg-surface px-4 py-2 text-sm hover:bg-muted"
                  >
                    取消
                  </button>
                  {editMsg && (
                    <span className="text-sm" style={{ color: 'var(--color-destructive)' }}>
                      {editMsg}
                    </span>
                  )}
                </div>
              </form>
            ) : null}
          </div>

          {/* 排拜訪:選日期(預設明天)、可連排一週,下面列出未來排程與狀態 */}
          <VisitPlanPanel customerId={customer.id} />

          {/* 存證照片:依場所類型列出必備四格,已拍的顯示縮圖,沒拍的寫「尚未拍攝」 */}
          <section
            aria-labelledby="photos-title"
            className="mt-6 rounded-lg border border-border bg-surface p-4"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="photos-title" className="text-base font-semibold">
                存證照片
                {photosInfo && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    已拍 {photosInfo.photos.length} 張
                  </span>
                )}
              </h2>
              {/* 補拍走 standalone 模式:照片直接上傳,不會另外記一次到訪。
                  原本這裡是一顆導去外勤拜訪頁的按鈕,人在辦公室按下去會被記成一筆
                  距離幾公里的可疑到訪 —— 那顆按鈕已經拿掉,外勤打卡改成下面那一句裡的文字連結。 */}
              <button
                type="button"
                ref={captureToggleRef}
                className="btn"
                aria-expanded={captureOpen}
                onClick={() => (captureOpen ? void closeCapture() : openCapture())}
              >
                {captureOpen ? '收合補拍' : '補拍存證照片'}
              </button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              補拍不會另外記一次到訪,時間軸上只會多一筆「補拍存證照片」。
              人真的到了現場、要留下到訪打卡的話,請到
              <Link href="/admin/crm/field" className="text-primary underline">
                外勤拜訪頁
              </Link>
              打卡。
            </p>
            <p role="status" aria-live="polite" className="mb-3 text-sm font-medium">
              {photosLoading && !photosInfo
                ? '存證照片載入中…'
                : photosErr
                  ? photosErr
                  : (photoStatusText ?? '')}
            </p>

            {/*
              合併造成的超額說明。
              這一段只有超額時才出現,而超額只可能來自查重合併(所有上傳路徑都擋在上限之前)。
              寫成一整段文字而不是只給一個顏色或一個圖示:狀態不能只靠顏色表達,
              而且使用者需要知道的是「為什麼」與「接下來怎麼辦」,那兩件事只有字說得出來。
              role="status" 讓讀螢幕的人在照片區載入完就聽得到,不必自己走到這一行。
            */}
            {photosInfo?.quota?.over && photosInfo.quota.notice ? (
              <p role="status" className="flash flash-warning mb-3">
                <span className="font-semibold">存證照片超過上限:</span>
                {photosInfo.quota.notice}
              </p>
            ) : null}

            {captureOpen ? (
              /* 補拍區自己會畫一份存證清單(含必拍格與其他照片),所以這一頁唯讀的那份先收起來:
                 同一個畫面上兩份清單會有先後差,使用者看到的是互相矛盾的兩個答案。 */
              <PhotoCapture
                mode="standalone"
                customerId={customer.id}
                customerName={title}
                salesName={me?.name ?? ''}
                salesTitle={me?.title ?? ''}
                companyName={organizationName}
              />
            ) : photosInfo && (photosInfo.premisesTypeMissing || !photosInfo.premisesType) ? (
              <p className="text-sm text-muted-foreground">
                請先在上方「場所類型」選一個(
                {premisesTypes.map((p) => p.label).join('、') || '尚未設定任何場所類型'})。
                選好之後這裡才知道要列出哪幾張必拍的存證照片,必拍清單由後台的照片存證檢查表決定。
              </p>
            ) : photosInfo ? (
              <>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="必備存證照片">
                  {photosInfo.required.map((kind) => {
                    const shot = photosInfo.photos.find((p) => p.kind === kind);
                    return (
                      <li
                        key={kind}
                        className="flex gap-3 rounded-md border border-border bg-background p-2"
                      >
                        {shot ? (
                          <PhotoThumb
                            url={photoUrls[shot.id]}
                            kindLabel={photoKindLabelOf(shot.kind)}
                            onOpen={() => setLightbox(shot)}
                          />
                        ) : (
                          <div
                            aria-hidden="true"
                            className="flex h-24 w-32 shrink-0 items-center justify-center rounded border border-dashed border-border-strong text-xs text-muted-foreground"
                          >
                            無照片
                          </div>
                        )}
                        <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                          <span className="font-medium">{photoKindLabelOf(kind)}</span>
                          {shot ? (
                            <>
                              <span className="text-xs text-muted-foreground">
                                拍攝時間 {fmtOrgDateTime(shot.takenAt, timezone)}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                拍攝者 {shot.byName || '—'}、{fmtBytes(shot.sizeBytes)}
                              </span>
                            </>
                          ) : (
                            <span className="text-xs font-medium text-destructive">尚未拍攝</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {(() => {
                  // 上面四格各只放該類型的第一張;其餘(同類型多拍的、其他類型)列在這裡
                  const shownIds = new Set(
                    photosInfo.required
                      .map((k) => photosInfo.photos.find((p) => p.kind === k)?.id)
                      .filter((v): v is string => !!v),
                  );
                  const others = photosInfo.photos.filter((p) => !shownIds.has(p.id));
                  if (others.length === 0) return null;
                  return (
                    <div className="mt-4">
                      <h3 className="mb-2 text-sm font-semibold">其他照片({others.length} 張)</h3>
                      <ul className="flex flex-wrap gap-3" aria-label="其他存證照片">
                        {others.map((p) => (
                          <li
                            key={p.id}
                            className="flex w-56 gap-2 rounded-md border border-border bg-background p-2"
                          >
                            <PhotoThumb
                              url={photoUrls[p.id]}
                              kindLabel={photoKindLabelOf(p.kind)}
                              onOpen={() => setLightbox(p)}
                            />
                            <div className="flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground">
                              <span className="text-sm font-medium text-foreground">
                                {photoKindLabelOf(p.kind)}
                              </span>
                              <span>{fmtOrgDateTime(p.takenAt, timezone)}</span>
                              <span>{p.byName || '—'}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
              </>
            ) : null}
          </section>

          {/* 統一時間軸 */}
          <div className="mt-6 rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-base font-semibold">
              拜訪 / 變動歷程
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {(() => {
                  const total = customer._count?.interactions ?? customer.interactions.length;
                  return total > customer.interactions.length
                    ? `共 ${total} 筆,顯示最近 ${customer.interactions.length} 筆`
                    : `共 ${total} 筆`;
                })()}
              </span>
            </h2>
            {customer.interactions.length === 0 ? (
              <p className="text-sm text-muted-foreground">尚無任何互動紀錄。</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {customer.interactions.map((it) => {
                  const isTransfer = (it.note ?? '').startsWith('【客戶移交】');
                  return (
                    <li key={it.id} className="border-l-2 border-border pl-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span
                          className="rounded border px-2 py-0.5 font-semibold"
                          style={
                            isTransfer
                              ? // muted-foreground #3f3f46 on muted #f4f4f5 = 9.50:1
                                {
                                  background: 'var(--color-muted)',
                                  color: 'var(--color-muted-foreground)',
                                  borderColor: 'var(--color-border)',
                                }
                              : // primary #00588a on background #ffffff = 7.60:1
                                {
                                  background: 'var(--color-background)',
                                  color: 'var(--color-primary)',
                                  borderColor: 'var(--color-border)',
                                }
                          }
                        >
                          {isTransfer ? '移交' : channelLabelOf(channels, it.channel)}
                        </span>
                        <span>{fmtOrgDateTime(it.occurredAt, timezone)}</span>
                        <span>、記錄者 {it.user?.name || '—'}</span>
                      </div>
                      {it.note && <div className="mt-1 whitespace-pre-wrap text-sm">{it.note}</div>}
                      {it.nextAction && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          下一步:{it.nextAction}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>

        {/* 右:三秒記錄 + 轉派 */}
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-base font-semibold">三秒記錄</h2>
            <form className="flex flex-col gap-3" onSubmit={addInteraction}>
              <label className="flex flex-col gap-1 text-sm">
                <span>管道</span>
                <select
                  className={inputCls}
                  value={logChannel}
                  onChange={(e) => setLogChannel(e.target.value as ChannelKey)}
                >
                  {channelOptions.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  拜訪打卡請到
                  <Link href="/admin/crm/field" className="text-primary underline">
                    外勤拜訪頁
                  </Link>
                </span>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>內容</span>
                <textarea
                  className={`min-h-[64px] ${inputCls}`}
                  value={logNote}
                  onChange={(e) => setLogNote(e.target.value)}
                  placeholder="這次聊了什麼、進度如何"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>下一步</span>
                <input
                  className={inputCls}
                  value={logNext}
                  onChange={(e) => setLogNext(e.target.value)}
                  placeholder="下次要做什麼"
                />
              </label>
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={logSaving}
                  className="rounded-lg border border-border bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
                >
                  {logSaving ? '記錄中…' : '記錄'}
                </button>
                {logMsg && <span className="text-sm text-muted-foreground">{logMsg}</span>}
              </div>
            </form>
          </div>

          {isManager && (
            <div className="rounded-lg border border-border bg-surface p-4">
              <h2 className="mb-3 text-base font-semibold">轉派承辦人員</h2>
              <p className="mb-3 text-xs text-muted-foreground">
                目前負責:{customer.owner?.name || '未指派'}。轉派後會在時間軸留下一筆移交紀錄。
              </p>
              <form className="flex flex-col gap-3" onSubmit={doTransfer}>
                <select
                  className={inputCls}
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                  disabled={users.length === 0}
                >
                  <option value="">選擇訪查人員…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || '(未命名)'}
                      {u.id === customer.ownerId ? '(目前負責)' : ''}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={transferSaving || !transferTo}
                    className="rounded-lg border border-border bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
                  >
                    {transferSaving ? '轉派中…' : '轉派'}
                  </button>
                  {transferMsg && (
                    <span className="text-sm text-muted-foreground">{transferMsg}</span>
                  )}
                </div>
                {usersErr && (
                  <span className="text-xs" style={{ color: 'var(--color-destructive)' }}>
                    {usersErr}
                  </span>
                )}
              </form>
            </div>
          )}

          {/* 標記為成交。放在刪除之前:預檢由元件自己打,缺什麼直接寫在上面,
              補件入口分別指回上方的場所類型那一格與存證照片的補拍區。 */}
          <ConvertPanel
            customerId={customer.id}
            converted={isConvertedCustomer(customer)}
            /* 照片清單還沒回來之前兩個值都當成「沒有缺件」:此時什麼都還不知道,
               先給一顆指向場所類型的補件按鈕只會把人帶錯地方 */
            facts={{
              premisesTypeMissing: photosInfo
                ? Boolean(photosInfo.premisesTypeMissing || !photosInfo.premisesType)
                : false,
              missingCount: photosInfo?.missing.length ?? 0,
            }}
            refreshKey={convertRefresh}
            onConverted={async () => {
              await loadCustomer();
              await loadPhotos();
            }}
            onFixPremises={focusPremises}
            onFixPhotos={openCapture}
          />

          {/* 刪除。放在最後一格,而且要按兩次:第一次只是問後端「這一筆刪得掉嗎」,
              把會帶走的東西講清楚,第二次才真的送出。 */}
          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-base font-semibold">刪除這筆客戶</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              刪除之後這筆客戶會從清單、看板、秒查、查重、統計與地圖消失,但資料還在,
              訪查主管與系統管理員可以到「資料管理」的回收桶還原。
              已經有互動紀錄、存證照片或已成交的客戶會被擋下來,需要系統管理員確認。
            </p>
            {!deleteCheck && (
              <button
                type="button"
                className="btn"
                onClick={() => void askDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? '確認中…' : '刪除這筆客戶'}
              </button>
            )}
            {deleteCheck && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-foreground">
                  {deleteCheck.block
                    ? deleteCheck.block.message
                    : '這一筆沒有互動紀錄也沒有存證照片,可以直接刪除。'}
                </p>
                <p className="text-xs text-muted-foreground">
                  目前有 {deleteCheck.facts.humanInteractions} 筆互動紀錄、
                  {deleteCheck.facts.photos} 張存證照片。
                </p>
                <label className="flex flex-col gap-1 text-sm">
                  <span>刪除原因(會顯示在回收桶)</span>
                  <input
                    className={inputCls}
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                    placeholder="例:匯入時欄位錯位"
                    maxLength={300}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  {deleteCheck.canDelete && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => void doDelete(false)}
                      disabled={deleteBusy}
                    >
                      {deleteBusy ? '刪除中…' : '確定刪除'}
                    </button>
                  )}
                  {/* 強制刪除只有系統管理員,而且只在「擋得下來但可以被蓋過」時出現 */}
                  {!deleteCheck.canDelete &&
                    deleteCheck.block?.forcible === true &&
                    role === 'admin' && (
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => void doDelete(true)}
                        disabled={deleteBusy}
                      >
                        {deleteBusy ? '刪除中…' : '仍要刪除(會留稽核紀錄)'}
                      </button>
                    )}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setDeleteCheck(null);
                      setDeleteMsg(null);
                    }}
                    disabled={deleteBusy}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {deleteMsg && (
              <p className="mt-2 text-sm" style={{ color: 'var(--color-destructive)' }}>
                {deleteMsg}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 放大檢視(原生 dialog:Esc 關閉、焦點鎖在對話框內) */}
      <dialog
        ref={dialogRef}
        aria-label={lightbox ? `${photoKindLabelOf(lightbox.kind)}照片放大檢視` : '照片放大檢視'}
        onClose={() => setLightbox(null)}
        className="m-auto max-h-[92vh] max-w-[92vw] rounded-lg border border-border bg-background p-4 text-foreground backdrop:bg-black/70"
      >
        {lightbox && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="font-semibold">{photoKindLabelOf(lightbox.kind)}</span>
                <span className="ml-2 text-muted-foreground">
                  {fmtOrgDateTime(lightbox.takenAt, timezone)}、拍攝者 {lightbox.byName || '—'}、
                  {fmtBytes(lightbox.sizeBytes)}
                </span>
              </div>
              <button type="button" className="btn" onClick={() => setLightbox(null)}>
                關閉
              </button>
            </div>
            {lightboxUrl ? (
              <Image
                src={lightboxUrl}
                alt={`${photoKindLabelOf(lightbox.kind)}存證照片,${fmtOrgDateTime(lightbox.takenAt, timezone)} 由 ${lightbox.byName || '未知'} 拍攝`}
                width={1200}
                height={900}
                unoptimized
                className="h-auto max-h-[75vh] w-auto max-w-full"
              />
            ) : (
              <p className="text-sm text-muted-foreground">圖片載入中…</p>
            )}
          </div>
        )}
      </dialog>
    </div>
  );
}
