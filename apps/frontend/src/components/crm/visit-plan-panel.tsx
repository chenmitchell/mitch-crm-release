'use client';

// 客戶卡的「排拜訪」區塊:選一天(預設明天)排進去,可勾「連續一週」一次排七天,
// 「今天」以組織設定的時區計(useAppSettings 的 timezone),不是瀏覽器所在時區也不是寫死的台北,
// 下面列出這位客戶今天起的排程與狀態,尚未完成的可以取消。
// API:GET/POST /api/admin/crm-visit-plans、POST .../bulk、PATCH .../:id { status: 'cancelled' }。
// 無障礙:label 綁 input、狀態訊息 role="status" aria-live、狀態用文字標籤不只靠顏色、
// 按鈕與日期欄 ≥44px(.btn / .input 已含)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useId, useState } from 'react';
import { addCalendarDays, orgToday } from '@mitchcrm/shared';
import { useAppSettings } from '@/lib/app-settings';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';

export interface VisitPlanRow {
  id: string;
  customerId: string;
  ownerId: string;
  ownerName: string;
  plannedDate: string;
  status: 'planned' | 'done' | 'missed' | 'cancelled';
  note: string | null;
  interactionId: string | null;
  companyName: string;
  taxId: string | null;
  address: string;
  stage: string;
}

export const VISIT_PLAN_STATUS_LABEL: Record<VisitPlanRow['status'], string> = {
  planned: '已排定',
  done: '已完成',
  missed: '未完成',
  cancelled: '已取消',
};

// 狀態標籤配色:走 globals.css 的 --st-* 狀態色(淺深模式各一組,對比 >=7:1),狀態文字本身就寫出來,不靠顏色傳達
export const VISIT_PLAN_STATUS_COLORS: Record<VisitPlanRow['status'], { bg: string; fg: string }> =
  {
    planned: { bg: 'var(--st-info-bg)', fg: 'var(--st-info-fg)' },
    done: { bg: 'var(--st-green-bg)', fg: 'var(--st-green-fg)' },
    missed: { bg: 'var(--st-red-bg)', fg: 'var(--st-red-fg)' },
    cancelled: { bg: 'var(--st-neutral-bg)', fg: 'var(--st-neutral-fg)' },
  };

/**
 * 「今天是哪一天」與日期加減都用 @mitchcrm/shared 的 org-time(前後端同一份)。
 * 這裡不再自己寫 UTC+8:那會讓設定裡的時區完全沒有作用。
 */
export const addDays = addCalendarDays;

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

/** 顯示成「10/07(二)」 */
export function fmtDateZh(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${md}(${WEEKDAY_ZH[d.getUTCDay()]})`;
}

export interface VisitPlanPanelProps {
  customerId: string;
  /** 排程異動後通知外層(例如重新載入時間軸),可省略 */
  onChanged?: () => void;
}

export default function VisitPlanPanel({ customerId, onChanged }: VisitPlanPanelProps) {
  const id = useId();
  const { timezone } = useAppSettings();
  const today = orgToday(new Date(), timezone);
  const [date, setDate] = useState<string>(addCalendarDays(today, 1));
  const [week, setWeek] = useState(false);
  // 後端 MAX_AHEAD_DAYS 是 90 天,而「連續一週」會從選定日往後排 6 天,
  // 所以勾了之後日期上限要收成 today+84,不然選 today+90 送出去直接 400
  const maxDate = addDays(today, week ? 84 : 90);
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<VisitPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const base = `${getApiBase()}/api/admin/crm-visit-plans`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: today, to: addDays(today, 60), customerId });
      const res = await fetch(`${base}?${qs.toString()}`, { credentials: 'include' });
      if (!res.ok) {
        setError(`排程載入失敗:${await apiErrorMessage(res, '請稍後再試')}`);
        return;
      }
      const data = (await res.json()) as { rows?: VisitPlanRow[] };
      setRows(data.rows ?? []);
      setError('');
    } catch {
      setError('排程載入失敗:網路連線異常,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [base, customerId, today]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !date) return;
    setSaving(true);
    setMsg('');
    setError('');
    try {
      const body = week
        ? {
            customerId,
            dates: Array.from({ length: 7 }, (_, i) => addDays(date, i)),
            ...(note.trim() ? { note: note.trim() } : {}),
          }
        : { customerId, plannedDate: date, ...(note.trim() ? { note: note.trim() } : {}) };
      const res = await fetch(week ? `${base}/bulk` : base, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`排程失敗:${await apiErrorMessage(res, '請稍後再試')}`);
        return;
      }
      setMsg(
        week ? `已排定 ${fmtDateZh(date)} 起連續七天的拜訪` : `已排定 ${fmtDateZh(date)} 的拜訪`,
      );
      setNote('');
      await load();
      onChanged?.();
    } catch {
      setError('排程失敗:網路連線異常,請稍後再試');
    } finally {
      setSaving(false);
    }
  }

  async function cancel(planId: string, planDate: string) {
    if (cancelingId) return;
    setCancelingId(planId);
    setMsg('');
    setError('');
    try {
      const res = await fetch(`${base}/${planId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (!res.ok) {
        setError(`取消失敗:${await apiErrorMessage(res, '請稍後再試')}`);
        return;
      }
      setMsg(`已取消 ${fmtDateZh(planDate)} 的拜訪`);
      await load();
      onChanged?.();
    } catch {
      setError('取消失敗:網路連線異常,請稍後再試');
    } finally {
      setCancelingId(null);
    }
  }

  const dateId = `${id}-date`;
  const weekId = `${id}-week`;
  const noteId = `${id}-note`;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-6 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={`${id}-title`} className="mb-3 text-base font-semibold">
        排拜訪
      </h2>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="flex flex-col gap-1">
          <label htmlFor={dateId} className="field-label">
            拜訪日期
          </label>
          <input
            id={dateId}
            type="date"
            className="input"
            value={date}
            min={today}
            max={maxDate}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div className="flex items-center gap-2">
          {/* 勾選框要包在 label 裡面(不是用 htmlFor 當兄弟):globals.css 的 44px 命中區
              是靠 label:has(> input[type='checkbox']) 把整塊 label 撐開的,
              兄弟寫法選擇器不成立,命中區就只剩勾選框自己那 24px(2.5.5 AAA 破功) */}
          <label htmlFor={weekId} className="text-foreground">
            <input
              id={weekId}
              type="checkbox"
              className="h-6 w-6"
              checked={week}
              onChange={(e) => {
                const on = e.target.checked;
                setWeek(on);
                // 已經選到超過新上限的日期,勾起來的當下就收回來,不要等送出才被擋
                if (on && date > addDays(today, 84)) setDate(addDays(today, 84));
              }}
            />
            <span>連續一週(從上面那天起連排七天)</span>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className="field-label">
            備註(可不填)
          </label>
          <input
            id={noteId}
            type="text"
            className="input"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例:先電話約時間"
          />
        </div>
        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !date}
            aria-busy={saving || undefined}
          >
            {saving ? '排定中…' : week ? '排一週' : '排這天'}
          </button>
        </div>
      </form>
      <p role="status" aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm text-foreground">
        {error || msg}
      </p>

      <h3 className="mt-4 text-sm font-semibold text-foreground">未來的排程</h3>
      {loading ? (
        <p className="mt-2 text-sm text-muted-foreground">載入中…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">目前沒有排程</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((r) => {
            const c = VISIT_PLAN_STATUS_COLORS[r.status];
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="text-sm font-semibold text-foreground">
                  {fmtDateZh(r.plannedDate)}
                </span>
                <span
                  className="rounded px-2 py-0.5 text-xs font-semibold"
                  style={{ backgroundColor: c.bg, color: c.fg }}
                >
                  {VISIT_PLAN_STATUS_LABEL[r.status]}
                </span>
                {r.note ? <span className="text-sm text-muted-foreground">{r.note}</span> : null}
                {r.status === 'planned' ? (
                  <button
                    type="button"
                    className="btn btn-sm ml-auto"
                    onClick={() => void cancel(r.id, r.plannedDate)}
                    disabled={cancelingId === r.id}
                  >
                    {cancelingId === r.id ? '取消中…' : '取消'}
                    <span className="sr-only">{fmtDateZh(r.plannedDate)} 的拜訪</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
