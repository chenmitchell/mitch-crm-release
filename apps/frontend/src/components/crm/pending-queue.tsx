// ref:3687 mc/陳彥輔/米球®
'use client';

// 外勤「待送出」清單與一鍵重送。
//
// 佇列本身在 lib/offline-queue(IndexedDB),這個元件只負責畫出來、把重送的
// fetch 交給它,以及把結果講成中文。
//
// ── 為什麼不自動重送 ────────────────────────────────────────────────
// 一回到有網路就默默送出去,聽起來體貼,但打卡是會寫進稽核記錄的動作:
// 使用者不知道送了什麼、也不知道送成功沒有,而失敗的那幾筆會一直在背景重試。
// 這裡改成:網路恢復時把按鈕變成主要按鈕、把筆數講出來,由人按一下。
// 按完的結果(成功幾筆、失敗幾筆、為什麼)一次講清楚。
//
// ── 拍攝時間超過 24 小時的那些 ──────────────────────────────────────
// 後端會擋(照片拍攝時間與伺服器時間相差不得超過 24 小時),所以這裡連送都不送,
// 直接在該筆旁邊寫清楚,並且**不自動刪** —— 那是使用者在現場拍的東西,
// 要不要丟掉由他決定。
//
// 無障礙:清單是 <ul>/<li>;狀態訊息 role="status" aria-live="polite";
// 「已逾時」不只靠顏色,每一筆都有文字說明;所有按鈕走 .btn(≥44px);
// 刪除有二次確認,焦點在確認鈕與取消鈕之間走得回來。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { useMe } from '@/lib/me-context';
import { useAppSettings } from '@/lib/app-settings';
import { fmtOrgTime } from '@/lib/photo-watermark';
import { useNetworkState, isNetworkError, reportNetworkFailure } from '@/lib/network-status';
import {
  flushPending,
  listPending,
  noteWithOfflineMark,
  ownerKeyOf,
  removePending,
  resendDeadline,
  resendWindow,
  type QueuedItem,
  type SendOutcome,
} from '@/lib/offline-queue';

export interface PendingQueueProps {
  /** 外層送出成功後改這個值,清單會重新讀一次 */
  reloadKey?: number;
  /** 重送成功之後通知外層(例如打卡頁要刷新客戶清單的 lastContactAt) */
  onFlushed?: () => void;
}

/**
 * 到訪打卡缺定位精度時的說法。
 *
 * 後端的 accuracy 是必填(見 checkin/dto/checkin.dto.ts),這種一筆送幾次都會被退回,
 * 而且退回的原因是「缺少定位精度」,對站在清單前面的人來說不知道要做什麼。
 * 所以連送都不送,直接在該筆旁邊講清楚沒救,以及下一次怎麼做才會成功。
 */
const NO_ACCURACY_TEXT =
  '這台裝置沒有回報定位精度,系統無法判斷打卡位置是否可信,重送幾次都會被退回。請改用手機的瀏覽器或開啟高精度定位,到現場重新打卡。';

/** 這一筆是不是因為缺精度而永遠送不出去 */
function missingAccuracy(item: QueuedItem): boolean {
  return item.type === 'checkin' && item.accuracy == null;
}

/** 時間戳;算不出來就講「未知」,不要在畫面上印 NaN */
function fmtStamp(ms: number, timeZone: string): string {
  return Number.isFinite(ms) ? fmtOrgTime(ms, timeZone) : '未知';
}

/** 剩餘時間講成人話 */
function fmtRemaining(ms: number): string {
  if (ms <= 0) return '已逾時';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `約 ${h} 小時 ${m} 分`;
  return `約 ${m} 分`;
}

export default function PendingQueue({ reloadKey, onFlushed }: PendingQueueProps) {
  const { me } = useMe();
  const { timezone } = useAppSettings();
  const netState = useNetworkState();
  const ownerKey = ownerKeyOf(me);

  const [items, setItems] = useState<QueuedItem[]>([]);
  const [othersCount, setOthersCount] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 「現在」拿一次就好,不要每次 render 都動:剩餘時間跟著清單重讀而更新
  const [now, setNow] = useState<number>(() => Date.now());

  const onFlushedRef = useRef(onFlushed);
  onFlushedRef.current = onFlushed;
  const flushBtnRef = useRef<HTMLButtonElement | null>(null);
  const deleteBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const confirmBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const mapRef =
    (m: Map<string, HTMLButtonElement>, key: string) => (el: HTMLButtonElement | null) => {
      if (el) m.set(key, el);
      else m.delete(key);
    };

  const reload = useCallback(async () => {
    const t = Date.now();
    setNow(t);
    const res = await listPending(ownerKey, t);
    setItems(res.items);
    setOthersCount(res.othersCount);
    setUnavailable(res.unavailable);
    if (res.pruned > 0) {
      setMsg(`已清掉 ${res.pruned} 筆超過 7 天的待送出資料。`);
    }
  }, [ownerKey]);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  // 每分鐘重算一次剩餘時間:「還有 3 分鐘可以重送」不會停在畫面上不動
  useEffect(() => {
    if (items.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [items.length]);

  // 刪除確認列的焦點:出現時到「確定刪除」,收起時回該筆的「刪除」
  const prevConfirm = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevConfirm.current;
    prevConfirm.current = confirmId;
    if (confirmId) {
      confirmBtnRefs.current.get(confirmId)?.focus();
      return;
    }
    if (prev) (deleteBtnRefs.current.get(prev) ?? flushBtnRef.current)?.focus();
  }, [confirmId]);

  /** 真正把一筆送出去。回傳的 outcome 決定 lib 要不要把它從佇列刪掉 */
  const sendOne = useCallback(
    async (item: QueuedItem): Promise<SendOutcome> => {
      // 缺定位精度的到訪打卡不用送:後端必填,送出去只會拿回一句看不懂的 400,
      // 而下一次重送還是同一句。
      if (missingAccuracy(item)) return { kind: 'drop', message: NO_ACCURACY_TEXT };
      const base = `${getApiBase()}/api/admin/crm-checkin`;
      const url =
        item.type === 'checkin'
          ? `${base}/${encodeURIComponent(item.customerId)}`
          : `${base}/${encodeURIComponent(item.customerId)}/photos`;
      // 原始的現場時間照送,不改寫成「現在」。後端會因為時鐘偏差把這一筆標成
      // 待主管確認 —— 對一筆補送的打卡來說那是對的,備註裡會寫清楚真正的原因。
      const resentAt = fmtOrgTime(Date.now(), timezone);
      const body =
        item.type === 'checkin'
          ? {
              lat: item.lat,
              lng: item.lng,
              accuracy: item.accuracy ?? undefined,
              clientTime: item.capturedAt,
              note: noteWithOfflineMark(item.note, resentAt),
              photos: item.photos.length > 0 ? item.photos : undefined,
            }
          : {
              photos: item.photos,
              // 補拍那一支的座標是選填:當初沒定位就不要送 0,那是幾內亞灣的海上
              lat: item.lat ?? undefined,
              lng: item.lng ?? undefined,
              accuracy: item.accuracy ?? undefined,
              clientTime: item.capturedAt,
            };
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) return { kind: 'sent' };
        if (res.status === 401) {
          return {
            kind: 'retry',
            message: await apiErrorMessage(res, '登入已過期,請重新登入後再重送', {
              onUnauthorized: 'stay',
            }),
          };
        }
        if (res.status >= 500) return { kind: 'retry', message: '伺服器暫時無法處理,請稍後再重送' };
        // 400 / 403 / 404 / 413:再送幾次都一樣,但不自動刪
        return { kind: 'drop', message: await apiErrorMessage(res, '伺服器拒絕了這一筆') };
      } catch (e) {
        if (isNetworkError(e)) {
          reportNetworkFailure();
          return { kind: 'retry', message: '仍然沒有網路連線' };
        }
        return { kind: 'retry', message: '送出失敗,請稍後再重送' };
      }
    },
    [timezone],
  );

  async function handleFlush() {
    if (sending || items.length === 0) return;
    setSending(true);
    setMsg(null);
    try {
      const t = Date.now();
      const summary = await flushPending(ownerKey, sendOne, t);
      const parts: string[] = [];
      if (summary.sent > 0) parts.push(`已送出 ${summary.sent} 筆`);
      if (summary.lapsed > 0) parts.push(`${summary.lapsed} 筆照片已超過 24 小時,伺服器不會接受`);
      if (summary.failed > 0) parts.push(`${summary.failed} 筆沒送成功`);
      const detail = summary.messages.length > 0 ? `。${summary.messages.join(';')}` : '';
      setMsg(parts.length > 0 ? `${parts.join(',')}${detail}` : '沒有可以重送的資料。');
      if (summary.sent > 0) onFlushedRef.current?.();
      await reload();
    } finally {
      setSending(false);
    }
  }

  async function handleDelete(id: string) {
    const ok = await removePending(id);
    setConfirmId(null);
    setMsg(ok ? '已刪除一筆待送出資料。' : '刪除失敗,請重新整理後再試。');
    await reload();
  }

  const photoCount = useMemo(() => items.reduce((s, it) => s + it.photos.length, 0), [items]);

  // 沒有待送出、佇列也正常時整個區塊不出現:平常這一頁不該多一塊空的東西
  if (items.length === 0 && othersCount === 0 && !unavailable) {
    return (
      <div role="status" aria-live="polite" className="sr-only">
        {msg}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="pending-queue-heading"
      className="rounded-lg border-2 border-border bg-surface p-4"
      style={{ borderColor: 'var(--st-info-bar)' }}
    >
      <h2 id="pending-queue-heading" className="text-base font-semibold">
        待送出({items.length} 筆{photoCount > 0 ? `,含 ${photoCount} 張照片` : ''})
      </h2>

      {unavailable ? (
        <p className="mt-2 text-sm">
          這個瀏覽器不支援離線暫存(無痕視窗常常會關掉),送不出去的打卡不會被保留。
          沒有網路時請不要關閉分頁,回到有網路的地方再送出一次。
        </p>
      ) : (
        <p className="mt-2 text-sm">
          這些是沒有網路時存在這台裝置上的打卡與照片,已經關過分頁也還在。
          回到有網路的地方按「全部重送」即可送出,送成功才會從這裡消失。
          照片的拍攝時間不會被改寫,而伺服器只接受 24 小時內拍的照片,請盡快重送。
        </p>
      )}

      {othersCount > 0 && (
        <p className="mt-2 text-sm">
          這台裝置上另外有 {othersCount} 筆是別的帳號留下的,不會跟著送出,也不會顯示內容。
        </p>
      )}

      {items.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {items.map((it) => {
            const w = resendWindow(it, now);
            const deadline = resendDeadline(it);
            const confirming = confirmId === it.id;
            return (
              <li
                key={it.id}
                className="rounded-md border border-border bg-background p-3 text-sm"
                style={
                  w === 'lapsed'
                    ? { backgroundColor: 'var(--st-red-bg)', color: 'var(--st-red-fg)' }
                    : undefined
                }
              >
                <p className="font-semibold">
                  {it.customerName || '(未命名客戶)'}
                  {it.type === 'photos' ? '(補拍照片)' : '(到訪打卡)'}
                </p>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt>現場時間</dt>
                  <dd>{fmtStamp(Date.parse(it.capturedAt), timezone)}</dd>
                  <dt>存入待送出</dt>
                  <dd>{fmtStamp(it.queuedAt, timezone)}</dd>
                  <dt>照片</dt>
                  <dd>{it.photos.length} 張</dd>
                  <dt>可重送到</dt>
                  <dd>
                    {deadline === null
                      ? '沒有照片,不受 24 小時限制'
                      : `${fmtStamp(deadline, timezone)}(剩 ${fmtRemaining(deadline - now)})`}
                  </dd>
                </dl>
                {missingAccuracy(it) && (
                  <p className="mt-2 font-semibold" style={{ color: 'var(--color-destructive)' }}>
                    {NO_ACCURACY_TEXT}
                  </p>
                )}
                {w === 'lapsed' && (
                  <p className="mt-2 font-semibold">
                    已逾時:照片拍攝時間超過 24 小時,伺服器不會接受這一筆。
                    這一筆不會被自動刪除,存證請重新到現場拍攝。
                  </p>
                )}
                {w === 'soon' && (
                  <p className="mt-2 font-semibold">快要逾時:請盡快回到有網路的地方重送。</p>
                )}
                {it.lastError && (
                  <p className="mt-2">
                    上次重送失敗({it.attempts} 次):{it.lastError}
                  </p>
                )}
                {confirming ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span>確定要刪除這一筆?刪掉之後照片就找不回來了。</span>
                    <button
                      type="button"
                      ref={mapRef(confirmBtnRefs.current, it.id)}
                      className="btn btn-danger"
                      onClick={() => void handleDelete(it.id)}
                    >
                      確定刪除
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <div className="mt-2">
                    <button
                      type="button"
                      ref={mapRef(deleteBtnRefs.current, it.id)}
                      className="btn"
                      onClick={() => setConfirmId(it.id)}
                    >
                      刪除這一筆
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {items.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {/* 送出中不 disabled(會把焦點丟到 body),改 aria-busy,handler 早退 */}
          <button
            type="button"
            ref={flushBtnRef}
            className={netState === 'online' ? 'btn btn-primary' : 'btn'}
            onClick={() => void handleFlush()}
            aria-busy={sending}
          >
            {sending ? '重送中…' : `全部重送(${items.length} 筆)`}
          </button>
          {netState !== 'online' && (
            <span className="text-sm">目前沒有網路,現在按也送不出去。</span>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm">
        {msg}
      </p>
    </section>
  );
}
