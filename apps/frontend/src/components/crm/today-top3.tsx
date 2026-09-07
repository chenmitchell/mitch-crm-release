'use client';

// 客戶管理 CRM「今日三件事」(/admin/crm 看板上方使用)。
// 從看板客戶陣列自行算出今天最該做的三件事,優先序:
//   (a) 下次跟進已逾期(以組織設定的時區計),逾期越久越前
//   (b) 下次跟進就是今天
//   (c) 流程後段(快到手)的階段,但超過 7 天沒聯絡(越久越前)
//   (d) 其他開發中、最久沒聯絡的
// 每筆給一句人話理由、公司名、一鍵撥號(tel:)與客戶卡連結。
// 「開啟提醒」用瀏覽器 Notification API 把今日三件事推一次,localStorage 記 crm-top3-notified-YYYY-MM-DD 避免同一天重複推。
// 不從 page.tsx import,型別用最小結構 TodayCustomer,任何來源的客戶資料都能直接傳入。
// 無障礙:section 有標題、ol 語意、tel/客戶卡連結 ≥44×44、狀態訊息 role="status" aria-live、
// 逾期/今日以文字理由呈現不靠顏色;配色沿用看板 STAGE_COLORS 手法(淺底 + 深字 ≥7:1)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useMemo, useState } from 'react';
import { orgDateKey } from '@mitchcrm/shared';
import {
  hotStageKeys,
  inProgressStageKeys,
  useAppSettings,
  type StageDef,
} from '@/lib/app-settings';

/** 最小結構:只用得到這幾個欄位,其餘一律不管 */
export interface TodayCustomer {
  id: string;
  companyName: string | null;
  taxId: string | null;
  stage: string;
  nextFollowUpAt: string | null;
  lastContactAt: string | null;
  contactPhone: string | null;
}

export interface TodayTop3Props {
  customers: TodayCustomer[];
}

type TaskKind = 'overdue' | 'today' | 'stale-hot' | 'stale';

interface TodayTask {
  kind: TaskKind;
  customer: TodayCustomer;
  /** 一句人話理由,例:「逾期 3 天未跟進」 */
  reason: string;
  /** 同一組內排序用:數字越大越前 */
  weight: number;
}

// 階段清單一律由後台設定供應(見 lib/app-settings),這裡不寫死任何代碼:
// 「開發中」= 沒有標記為終止的階段,「快到手」= 流程後段的那幾個階段。
const HOT_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

// 各類任務配色:一律走 globals.css 的 --st-* 狀態色(bg/fg/bar),深色模式自動換底,不會淺色塊坐在深色卡片上。
// 字底對比實測(WCAG 公式):逾期 7.60、今天 8.75、久未聯絡 7.22、該聯絡 8.01,都 ≥ 7:1(AAA)。
const KIND_COLORS: Record<TaskKind, { bg: string; border: string; fg: string; label: string }> = {
  overdue: {
    bg: 'var(--st-red-bg)',
    border: 'var(--st-red-bar)',
    fg: 'var(--st-red-fg)',
    label: '逾期',
  },
  today: {
    bg: 'var(--st-amber-bg)',
    border: 'var(--st-amber-bar)',
    fg: 'var(--st-amber-fg)',
    label: '今天',
  },
  'stale-hot': {
    bg: 'var(--st-pink-bg)',
    border: 'var(--st-pink-bar)',
    fg: 'var(--st-pink-fg)',
    label: '久未聯絡',
  },
  stale: {
    bg: 'var(--st-info-bg)',
    border: 'var(--st-info-bar)',
    fg: 'var(--st-info-fg)',
    label: '該聯絡',
  },
};

/**
 * 把時間轉成組織時區的 YYYY-MM-DD;無效值回 null。
 * 時區由呼叫端從設定帶進來 —— 寫死台北的話,設在別的時區的組織會在當地下午
 * 就把今天的跟進算成「逾期」或直接跳到隔天。
 */
function dateKeyIn(input: string | number | Date | null, tz: string): string | null {
  if (input === null) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return orgDateKey(d, tz);
}

/** 兩個 YYYY-MM-DD 相差的天數(a - b) */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

/**
 * 算今天最該做的三件事。
 *
 * stages 由呼叫端從設定帶進來(不是在這裡打 API):這支是純函式,
 * 同一批客戶配同一份階段設定,結果永遠一樣,測試也接得住。
 */
export function computeTodayTasks(
  customers: TodayCustomer[],
  stages: readonly StageDef[],
  timeZone: string,
  now: number = Date.now(),
): TodayTask[] {
  const inProgress = inProgressStageKeys(stages);
  const hot = hotStageKeys(stages);
  const stageLabel = new Map(stages.map((s) => [s.key, s.label]));
  const today = dateKeyIn(now, timeZone);
  if (!today) return [];

  const overdue: TodayTask[] = [];
  const dueToday: TodayTask[] = [];
  const staleHot: TodayTask[] = [];
  const stale: TodayTask[] = [];

  for (const c of customers) {
    if (!inProgress.has(c.stage)) continue;

    const followKey = dateKeyIn(c.nextFollowUpAt, timeZone);
    if (followKey) {
      const diff = dayDiff(today, followKey);
      if (diff > 0) {
        overdue.push({
          kind: 'overdue',
          customer: c,
          reason: `逾期 ${diff} 天未跟進`,
          weight: diff,
        });
        continue;
      }
      if (diff === 0) {
        dueToday.push({ kind: 'today', customer: c, reason: '今天要回電', weight: 0 });
        continue;
      }
    }

    // 沒聯絡過 → 視為無限久,排最前
    const lastKey = dateKeyIn(c.lastContactAt, timeZone);
    const silentDays = lastKey ? dayDiff(today, lastKey) : Number.POSITIVE_INFINITY;
    const stageText = stageLabel.get(c.stage) ?? '開發中';

    if (hot.has(c.stage) && silentDays > HOT_STALE_DAYS) {
      staleHot.push({
        kind: 'stale-hot',
        customer: c,
        reason: lastKey ? `${stageText}但已 ${silentDays} 天沒聯絡` : `${stageText}但還沒聯絡過`,
        weight: silentDays,
      });
      continue;
    }

    stale.push({
      kind: 'stale',
      customer: c,
      reason: lastKey ? `${stageText},已 ${silentDays} 天沒聯絡` : `${stageText},還沒聯絡過`,
      weight: silentDays,
    });
  }

  const byWeight = (x: TodayTask, y: TodayTask) => y.weight - x.weight;
  overdue.sort(byWeight);
  staleHot.sort(byWeight);
  stale.sort(byWeight);

  return [...overdue, ...dueToday, ...staleHot, ...stale].slice(0, 3);
}

function displayName(c: TodayCustomer): string {
  return c.companyName || c.taxId || '(未命名)';
}

/** tel: 連結只留數字與 +,避免把括號、空白塞進 href */
function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

export default function TodayTop3({ customers }: TodayTop3Props) {
  // 階段清單與時區都由後台設定供應,不在這一支裡寫死
  const { stages, timezone } = useAppSettings();
  const tasks = useMemo(
    () => computeTodayTasks(customers, stages, timezone),
    [customers, stages, timezone],
  );

  // 提醒按鈕狀態:unsupported 不顯示按鈕;denied 顯示說明
  const [notifyState, setNotifyState] = useState<
    'unknown' | 'unsupported' | 'android' | 'default' | 'granted' | 'denied'
  >('unknown');
  const [notifyMsg, setNotifyMsg] = useState('');

  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        setNotifyState('unsupported');
        return;
      }
      // Android Chrome 不允許頁面直接 new Notification(會丟 Illegal constructor,只能經 service worker 的
      // showNotification 推)。這裡沒有註冊 service worker,所以手機上不顯示「開啟提醒」,改提示用主畫面的清單。
      if ('serviceWorker' in navigator && /Android/i.test(navigator.userAgent)) {
        setNotifyState('android');
        return;
      }
      setNotifyState(Notification.permission);
    } catch {
      setNotifyState('unsupported');
    }
  }, []);

  const pushNotification = useCallback(() => {
    try {
      const todayKey = dateKeyIn(Date.now(), timezone) ?? 'unknown';
      const storageKey = `crm-top3-notified-${todayKey}`;
      let already = false;
      try {
        already = window.localStorage.getItem(storageKey) === '1';
      } catch {
        already = false;
      }
      if (already) {
        setNotifyMsg('今天已經提醒過了,明天會再推一次');
        return;
      }
      if (tasks.length === 0) {
        setNotifyMsg('提醒已開啟,今天沒有待辦所以不推播');
        return;
      }
      const body = tasks
        .map((t, i) => `${i + 1}. ${displayName(t.customer)}:${t.reason}`)
        .join('\n');
      new Notification('今日三件事', { body, tag: storageKey, lang: 'zh-TW' });
      try {
        window.localStorage.setItem(storageKey, '1');
      } catch {
        /* 私密模式等寫不進去就算了,頂多同一天再推一次 */
      }
      setNotifyMsg(`已推播今天的 ${tasks.length} 件待辦`);
    } catch {
      setNotifyMsg('這個瀏覽器目前無法推播提醒,請改看下方清單');
    }
  }, [tasks, timezone]);

  const enableNotify = useCallback(async () => {
    try {
      if (!('Notification' in window)) {
        setNotifyState('unsupported');
        setNotifyMsg('這個瀏覽器不支援提醒');
        return;
      }
      let perm: NotificationPermission = Notification.permission;
      if (perm === 'default') {
        setNotifyMsg('請在瀏覽器的提示裡允許通知');
        perm = await Notification.requestPermission();
      }
      setNotifyState(perm);
      if (perm === 'granted') {
        pushNotification();
      } else if (perm === 'denied') {
        setNotifyMsg('通知被封鎖了,請到瀏覽器網站設定裡允許通知後再試');
      } else {
        setNotifyMsg('還沒允許通知,需要時再按一次「開啟提醒」');
      }
    } catch {
      setNotifyState('unsupported');
      setNotifyMsg('這個瀏覽器目前無法開啟提醒');
    }
  }, [pushNotification]);

  return (
    <section
      aria-labelledby="today-top3-title"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="today-top3-title" className="text-base font-semibold">
            今日三件事
          </h2>
          <p className="text-xs text-muted-foreground">依逾期、今天到期、久未聯絡排序,只列前三</p>
        </div>
        {notifyState === 'android' ? (
          <p className="text-xs text-muted-foreground">手機請用主畫面的今日三件事</p>
        ) : notifyState !== 'unsupported' && notifyState !== 'unknown' ? (
          <button
            type="button"
            className="btn"
            onClick={enableNotify}
            aria-describedby={notifyMsg ? 'today-top3-notify-status' : undefined}
          >
            {notifyState === 'granted' ? '再推一次提醒' : '開啟提醒'}
          </button>
        ) : null}
      </div>

      {/* 提醒狀態訊息:aria-live 讓螢幕閱讀器唸出來;空字串時仍保留節點,避免 live region 抓不到變化 */}
      <p
        id="today-top3-notify-status"
        role="status"
        aria-live="polite"
        className="mb-2 min-h-5 text-sm"
      >
        {notifyMsg}
      </p>

      {tasks.length === 0 ? (
        <p className="rounded-md border border-border bg-background px-3 py-3 text-sm">
          今天沒有待辦,去開發新名單吧
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {tasks.map((t, i) => {
            const colors = KIND_COLORS[t.kind];
            const name = displayName(t.customer);
            const phone = t.customer.contactPhone?.trim() || '';
            return (
              <li
                key={t.customer.id}
                className="flex flex-col gap-2 rounded-md border-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                style={{ backgroundColor: colors.bg, borderColor: colors.fg, color: colors.fg }}
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold tabular-nums" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span
                      className="rounded border px-1.5 text-xs font-bold"
                      style={{ borderColor: colors.fg }}
                    >
                      {colors.label}
                    </span>
                    <span className="truncate text-sm font-semibold" title={name}>
                      {name}
                    </span>
                  </div>
                  <p className="m-0 mt-0.5 text-sm">{t.reason}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {phone ? (
                    <a
                      href={telHref(phone)}
                      className="btn"
                      aria-label={`撥電話給 ${name},${phone}`}
                    >
                      撥 {phone}
                    </a>
                  ) : (
                    <span className="inline-flex min-h-11 items-center text-sm">沒有電話</span>
                  )}
                  <a
                    href={`/admin/crm/${t.customer.id}`}
                    className="btn"
                    aria-label={`開啟 ${name} 的客戶卡`}
                  >
                    客戶卡
                  </a>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
