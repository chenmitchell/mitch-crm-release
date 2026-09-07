'use client';

// 日報送主管(外勤頁「拜訪日報」區塊下方使用)。
// textarea 預填外勤頁產出的日報文字,業務可改,按「送給主管」呼叫
// POST /api/admin/crm-daily-reports(同人同日覆蓋,所以再按一次就是覆蓋今天的)。
// 另外提供三種傳送方式,都以 textarea 目前的文字為內容:
//   「用 LINE 傳送」開 LINE 官方分享網址(手機會叫出 LINE App 選對象)、
//   「分享到其他 App」走 navigator.share(只在支援的瀏覽器顯示,通常是手機)、
//   「複製文字」寫進剪貼簿。這三個不會送後端,跟「送給主管」互不影響。
// 離線:沒有網路時先講清楚「按下去送不出去」,而不是等他按完再說。打好的字留在畫面上不清空。
//   日報是純文字,不進「待送出」佇列 —— 佇列留給補拍不回來的存證照片。
// 無障礙:label 綁 textarea、狀態訊息 role="status" aria-live、錯誤不只靠顏色(有「送出失敗:」前綴)、按鈕 ≥44px。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect, useId, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import {
  isNetworkError,
  reportNetworkFailure,
  reportNetworkSuccess,
  useNetworkState,
} from '@/lib/network-status';
import DonePanel from './done-panel';

const MAX_LEN = 5000;
// LINE 分享網址帶的文字太長時,LINE 端可能截掉後段,超過這個長度就提示改用複製
const LINE_WARN_LEN = 1500;
const LINE_SHARE_URL = 'https://line.me/R/share?text=';

export interface DailyReportSubmitProps {
  /** 外勤頁產出的日報文字,作為 textarea 預設值(外部更新時會同步覆蓋尚未編輯的內容) */
  defaultText: string;
  /** 報表統計數字(例如 interactions / visits),一併送給後端存 stats */
  stats?: Record<string, number>;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string };

export default function DailyReportSubmit({ defaultText, stats }: DailyReportSubmitProps) {
  const id = useId();
  const [text, setText] = useState<string>(defaultText);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [sentOnce, setSentOnce] = useState(false);
  // navigator.share 只在瀏覽器端才知道有沒有,放 effect 裡判斷避免 SSR 與 client 第一次 render 不一致
  const [canShare, setCanShare] = useState(false);
  const [shareMsg, setShareMsg] = useState('');
  const offline = useNetworkState() !== 'online';

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  // 外勤頁日報重新載入時,若業務還沒動過內容,跟著更新
  useEffect(() => {
    if (!dirty) setText(defaultText);
  }, [defaultText, dirty]);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_LEN;
  const canSend = status.kind !== 'sending' && trimmed.length > 0 && !tooLong;

  async function handleSend() {
    if (!canSend) return;
    setStatus({ kind: 'sending' });
    try {
      const res = await fetch(`${getApiBase()}/api/admin/crm-daily-reports`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed, ...(stats ? { stats } : {}) }),
      });
      if (!res.ok) {
        // 外勤頁面:401 不導頁,已經打好的日報內容留在畫面上(見 lib/api-error)
        setStatus({
          kind: 'error',
          text: `送出失敗:${await apiErrorMessage(res, '請稍後再試', { onUnauthorized: 'stay' })}`,
        });
        return;
      }
      reportNetworkSuccess();
      setSentOnce(true);
      setStatus({ kind: 'ok', text: '已送出,主管會在後台看到' });
    } catch (e) {
      if (isNetworkError(e)) {
        reportNetworkFailure();
        // 日報是純文字,不進待送出佇列(佇列留給存證照片那種「補拍不回來」的東西)。
        // 這裡能做的是講清楚原因,並保證打好的字還在畫面上。
        setStatus({
          kind: 'error',
          text: '送出失敗:目前沒有網路連線。你打的內容還在這個畫面上,回到有網路的地方再按一次「送給主管」即可,不必重打。請先不要關掉這一頁。',
        });
        return;
      }
      setStatus({ kind: 'error', text: '送出失敗:請稍後再試' });
    }
  }

  const hasText = trimmed.length > 0;
  const lineTooLong = trimmed.length > LINE_WARN_LEN;
  const lineHref = `${LINE_SHARE_URL}${encodeURIComponent(trimmed)}`;

  async function handleShare() {
    if (!hasText) return;
    try {
      await navigator.share({ title: '拜訪日報', text: trimmed });
      setShareMsg('已開啟分享面板');
    } catch (err) {
      // 使用者自己取消分享面板不算錯
      if (err instanceof Error && err.name === 'AbortError') {
        setShareMsg('');
        return;
      }
      setShareMsg('分享失敗,請改用複製文字');
    }
  }

  async function handleCopy() {
    if (!hasText) return;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard)
        throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(trimmed);
      setShareMsg('已複製,貼到 LINE 或信件即可');
    } catch {
      setShareMsg('複製失敗,請手動選取文字複製');
    }
  }

  const helpId = `${id}-help`;
  const countId = `${id}-count`;
  const lineHintId = `${id}-line-hint`;

  return (
    <div className="mt-4 border-t border-border pt-4">
      <label htmlFor={`${id}-text`} className="field-label">
        送給主管的日報內容
      </label>
      <p id={helpId} className="mb-2 text-sm text-muted-foreground">
        預填上方的當日日報,可自行修改後送出。同一天再送一次會覆蓋前一次的內容。
      </p>
      <textarea
        id={`${id}-text`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          if (status.kind !== 'sending') setStatus({ kind: 'idle' });
          setShareMsg('');
        }}
        rows={8}
        maxLength={MAX_LEN + 500}
        aria-describedby={`${helpId} ${countId}`}
        aria-invalid={tooLong || undefined}
        className="w-full rounded-md border border-border-strong bg-background px-2 py-1.5 text-sm"
        placeholder="請輸入今天的日報內容"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSend}
          disabled={!canSend}
          aria-busy={status.kind === 'sending' || undefined}
        >
          {status.kind === 'sending'
            ? '送出中…'
            : sentOnce
              ? '重新送給主管(覆蓋今天的)'
              : '送給主管'}
        </button>
        <span id={countId} className="text-sm text-muted-foreground">
          {text.length} / {MAX_LEN} 字{tooLong ? ',已超過上限,請縮短' : ''}
        </span>
      </div>
      {/* 先講清楚按下去會怎樣,不要等他按完再說。狀態寫在文字裡,不只靠顏色 */}
      {offline && (
        <p role="status" aria-live="polite" className="mt-2 text-sm">
          目前沒有網路連線,現在按「送給主管」送不出去。你打的內容不會消失,回到有網路的地方再按一次即可。
        </p>
      )}
      <p role="status" aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm text-foreground">
        {status.kind === 'ok' || status.kind === 'error' ? status.text : ''}
      </p>

      {/* 送出成功後的完成畫面:回我的首頁,或再看一次日報 */}
      {status.kind === 'ok' ? (
        <DonePanel
          title="日報已送給主管"
          description="同一天再送一次會覆蓋這份內容。"
          primary={{ label: '回我的首頁', href: '/admin/crm/home' }}
          secondary={{ label: '再看一次日報', href: '/admin/crm/field/report' }}
        />
      ) : null}

      {/* 其他傳送方式:不經後端,直接把目前文字交給 LINE / 系統分享 / 剪貼簿 */}
      <p className="mt-3 text-sm text-muted-foreground">也可以直接把上面的內容傳給主管或其他人:</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {hasText ? (
          <a
            href={lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="btn"
            aria-describedby={lineTooLong ? lineHintId : undefined}
          >
            用 LINE 傳送<span className="sr-only">(開新視窗)</span>
          </a>
        ) : (
          <button type="button" className="btn" disabled>
            用 LINE 傳送
          </button>
        )}
        {canShare ? (
          <button type="button" className="btn" onClick={handleShare} disabled={!hasText}>
            分享到其他 App
          </button>
        ) : null}
        <button type="button" className="btn" onClick={handleCopy} disabled={!hasText}>
          複製文字
        </button>
      </div>
      {lineTooLong ? (
        <p id={lineHintId} className="mt-2 text-sm text-foreground">
          內容較長,LINE 可能截斷,建議改用複製
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm text-foreground">
        {shareMsg}
      </p>
    </div>
  );
}
