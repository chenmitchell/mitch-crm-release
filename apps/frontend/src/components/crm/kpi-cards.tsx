'use client';

// 客戶管理 CRM 的 KPI 摘要卡(/admin/crm 看板上方使用)。
// 從看板客戶陣列自行算出「開發中 / 有意願 / 逾期追蹤 / 轉換率」,
// 「本週拜訪」則直接吃報表 stats.visits。不從 page.tsx import,
// 型別用最小結構 KpiCustomer,方便任何來源的客戶資料直接傳入。
// 無障礙:section aria-label + dl/dt/dd 語意,dd 內放 sr-only 數值句,螢幕閱讀器會唸「開發中 12 筆」;
// 逾期卡除了配色(--st-red-* 狀態色,淺深模式都 >= 7:1)另加文字「需跟進」,不以顏色當唯一訊息。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useMemo } from 'react';
import { useAppSettings } from '@/lib/app-settings';
import { computeKpiStats, type KpiCustomer } from '@/lib/kpi-stats';

export type { KpiCustomer };

export interface KpiCardsProps {
  /** 看板所有欄 flatten 後的客戶(含 dropped),轉換率分母才算得準 */
  customers: KpiCustomer[];
  /** 報表 stats.visits;null 表示尚未載入或不可用,顯示「—」 */
  weeklyVisits: number | null;
  /** 看板載入中:數字一律顯示「—」並標 aria-busy */
  loading?: boolean;
}

// 階段清單一律由後台設定供應(見 lib/app-settings),這裡不寫死任何階段代碼。
// 「開發中」= 沒有標記為終止的階段;逾期同樣以 terminal 旗標判斷,
// 與後端 crm-scope-filters.ts 的 overdueCustomerWhere 同一套口徑。
// 實際算法在 lib/kpi-stats.ts(純函式,有單元測試 tests/kpi-stats.spec.ts)。

// 逾期卡專用配色(數字 > 0 時):淺紅底 + 深紅字(對比 >= 7:1)+ 紅色粗框,手法同看板 STAGE_COLORS
const OVERDUE_COLORS = {
  bg: 'var(--st-red-bg)',
  border: 'var(--st-red-bar)',
  fg: 'var(--st-red-fg)',
};

interface CardSpec {
  key: string;
  label: string;
  /** 畫面上的大數字 */
  value: string;
  /** 給螢幕閱讀器的數值句(dt 已唸過標題,這裡不重複),例如「12 筆,需跟進」 */
  srText: string;
  /** 小字說明(可省略) */
  hint?: string;
  /** 逾期卡 > 0 時醒目 */
  alert?: boolean;
}

export default function KpiCards({ customers, weeklyVisits, loading = false }: KpiCardsProps) {
  // 階段清單由後台設定供應,卡片的標題與說明也跟著設定走
  const { stages } = useAppSettings();
  const stats = useMemo(() => computeKpiStats(customers, stages), [customers, stages]);
  const inProgressStages = useMemo(() => stages.filter((s) => !s.terminal), [stages]);
  const nearWinLabel = inProgressStages[inProgressStages.length - 1]?.label ?? '快到手';
  const inDevHint =
    inProgressStages.length > 1
      ? `${inProgressStages[0]?.label ?? ''}到${nearWinLabel}`
      : nearWinLabel;

  const cards: CardSpec[] = useMemo(() => {
    const dash = '—';
    if (loading) {
      const pending = (label: string): CardSpec => ({
        key: label,
        label,
        value: dash,
        srText: '載入中',
      });
      return [
        pending('開發中'),
        pending('本週拜訪'),
        pending(nearWinLabel),
        pending('逾期追蹤'),
        pending('轉換率'),
      ];
    }
    const visitsText = weeklyVisits === null ? dash : String(weeklyVisits);
    const rateText = stats.conversionRate === null ? dash : `${stats.conversionRate}%`;
    return [
      {
        key: '開發中',
        label: '開發中',
        value: String(stats.inDev),
        srText: `${stats.inDev} 筆`,
        hint: inDevHint,
      },
      {
        key: '本週拜訪',
        label: '本週拜訪',
        value: visitsText,
        srText: weeklyVisits === null ? '尚無資料' : `${weeklyVisits} 次`,
        hint: weeklyVisits === null ? '尚無資料' : undefined,
      },
      {
        key: 'near-win',
        label: nearWinLabel,
        value: String(stats.interested),
        srText: `${stats.interested} 筆`,
      },
      {
        key: '逾期追蹤',
        label: '逾期追蹤',
        value: String(stats.overdue),
        srText: stats.overdue > 0 ? `${stats.overdue} 筆,需跟進` : '0 筆,目前沒有逾期',
        hint: stats.overdue > 0 ? '需跟進' : '目前沒有逾期',
        alert: stats.overdue > 0,
      },
      {
        key: '轉換率',
        label: '轉換率',
        value: rateText,
        srText:
          stats.conversionRate === null
            ? '尚無資料'
            : `${stats.conversionRate}%,${stats.converted} 筆成交`,
        hint: stats.conversionRate === null ? '尚無資料' : `${stats.converted} 筆成交`,
      },
    ];
  }, [loading, weeklyVisits, stats, nearWinLabel, inDevHint]);

  return (
    <section aria-label="開發 KPI 摘要" aria-busy={loading || undefined}>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((card) => {
          const alertStyle = card.alert
            ? {
                backgroundColor: OVERDUE_COLORS.bg,
                borderColor: OVERDUE_COLORS.border,
                color: OVERDUE_COLORS.fg,
              }
            : undefined;
          return (
            <div
              key={card.key}
              className={
                card.alert
                  ? 'flex min-w-0 flex-col rounded-lg border-2 px-3 py-2'
                  : 'flex min-w-0 flex-col rounded-lg border border-border bg-surface px-3 py-2 text-foreground'
              }
              style={alertStyle}
            >
              <dt className={`text-xs font-bold ${card.alert ? '' : 'text-muted-foreground'}`}>
                {card.label}
              </dt>
              <dd className="m-0 flex min-w-0 flex-col">
                {/* 視覺只顯示大數字與小字;螢幕閱讀器接在 dt 之後唸數值句(例如「開發中 12 筆,需跟進」) */}
                <span aria-hidden="true" className="text-2xl font-bold leading-tight tabular-nums">
                  {card.value}
                </span>
                {card.hint ? (
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 truncate text-xs ${card.alert ? 'font-semibold' : 'text-muted-foreground'}`}
                  >
                    {card.hint}
                  </span>
                ) : null}
                <span className="sr-only">{card.srText}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
