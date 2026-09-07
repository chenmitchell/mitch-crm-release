'use client';

// 主管戰情圖表(/admin/crm 主管區塊使用)。自己抓兩支 API:
//   GET /api/admin/crm-stats/by-sales?range=week|month|quarter → 各業務戰情 + 貢獻度分級
//   GET /api/admin/crm-stats/funnel                              → 各階段目前筆數
// 三張圖:(1) 各訪查人員長條圖(拜訪 / 有意願 / 成交,名稱跟著後台階段設定)、(2) 階段漏斗、(3) 貢獻度表格(A/B/C)。
// 圖全部用純 inline SVG(viewBox + width 100%,手機可看),每根長條旁直接印數字,
// 顏色只當輔助:圖例用文字、等級用字母 + 淺色底,不以顏色當唯一訊息。
// 無障礙:每張 SVG 有 <title> 與 role="img" aria-label,並附同資料的 <table>(可收合「以表格檢視」);
// 載入中 / 失敗 / 無資料都用 role="status" aria-live 中文提示;範圍切換鈕 ≥ 44px 且有 aria-pressed。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { useStageMeta } from '@/lib/crm-shared';
import { useStatMetricLabel } from '@/lib/app-settings';

type StatRange = 'week' | 'month' | 'quarter';
type Grade = 'A' | 'B' | 'C';

interface SalesRow {
  userId: string;
  userName: string;
  /** 帳號還啟用嗎;停用(離職)帳號一樣列出、名下客戶一樣算。舊版後端沒回就當啟用 */
  active?: boolean;
  inDev: number;
  interested: number;
  converted: number;
  convertedTotal: number;
  visits: number;
  // 可疑打卡(GPS 精度差或距離太遠),不計入 visits;舊版後端沒回就當 0
  suspiciousVisits?: number;
  interactions: number;
  overdue: number;
  newCustomers: number;
  score: number;
  grade: Grade;
}
interface BySalesResp {
  range: StatRange;
  from: string;
  to: string;
  note?: string;
  rows: SalesRow[];
  totals: Omit<SalesRow, 'userId' | 'userName' | 'grade'>;
}
interface FunnelResp {
  stages: Array<{ stage: string; count: number }>;
}

const RANGE_LABEL: Record<StatRange, string> = { week: '本週', month: '本月', quarter: '本季' };
const RANGES: StatRange[] = ['week', 'month', 'quarter'];

// 長條圖三個系列:第一個系列用品牌 --accent,其餘沿用狀態色,三個色相彼此可分辨,
// 圖例與表格都寫出系列名稱,不靠顏色當唯一資訊。
//
// key 是後端 stats API 固定回的三個計數欄位(visits / interested / converted),那是 API 合約;
// 顯示名稱則跟著後台的階段設定走(見 lib/app-settings 的 useStatMetricLabel)——
// interested 算的是「進行中排最後那一階」、converted 算的是成交階段,
// 寫死中文的話,後台把階段改名之後圖例還印舊名字,而數字是新的。
type SeriesKey = 'visits' | 'interested' | 'converted';
const SERIES_COLOR: Record<SeriesKey, string> = {
  visits: 'var(--accent)',
  interested: 'var(--st-pink-fg)',
  converted: 'var(--st-green-fg)',
};
const SERIES_KEYS: SeriesKey[] = ['visits', 'interested', 'converted'];

function useSeries(): Array<{ key: SeriesKey; label: string; color: string }> {
  const metricLabel = useStatMetricLabel();
  return useMemo(
    () =>
      SERIES_KEYS.map((key) => ({ key, label: metricLabel[key] ?? key, color: SERIES_COLOR[key] })),
    [metricLabel],
  );
}

// 等級配色:字母永遠印出來,底色只是輔助;一律走 --st-* 狀態色,深色模式跟著換底。
const GRADE_STYLE: Record<Grade, { bg: string; fg: string; label: string }> = {
  A: { bg: 'var(--st-green-bg)', fg: 'var(--st-green-fg)', label: 'A 級' },
  B: { bg: 'var(--st-info-bg)', fg: 'var(--st-info-fg)', label: 'B 級' },
  C: { bg: 'var(--st-neutral-bg)', fg: 'var(--st-neutral-fg)', label: 'C 級' },
};

// SVG 內的文字與軸線:var() 放在 fill / stroke「屬性」上部分瀏覽器不吃,一律走 style prop。
const NUM_COLOR = 'var(--text)';
const AXIS_COLOR = 'var(--border-strong)';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 可收合的「以表格檢視」包裝:SVG 的無障礙替代 */
function TableToggle({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="mt-2">
      <summary className="btn inline-flex cursor-pointer text-xs">{summary}</summary>
      <div className="mt-2 overflow-x-auto">{children}</div>
    </details>
  );
}

/* ---------- (1) 各訪查人員長條圖 ---------- */
function SalesBarChart({ rows, rangeLabel }: { rows: SalesRow[]; rangeLabel: string }) {
  const SERIES = useSeries();
  const titleId = useId();
  const W = 640;
  const LABEL_W = 120;
  const VALUE_W = 44;
  const BAR_H = 14;
  const BAR_GAP = 3;
  const GROUP_GAP = 14;
  const TOP = 8;
  const groupH = SERIES.length * (BAR_H + BAR_GAP) + GROUP_GAP;
  const H = TOP + rows.length * groupH + 8;
  const plotW = W - LABEL_W - VALUE_W - 16;
  const max = Math.max(1, ...rows.flatMap((r) => SERIES.map((s) => r[s.key])));
  const seriesNames = SERIES.map((s) => s.label).join('、');
  const aria = `${rangeLabel}各訪查人員${seriesNames}長條圖,共 ${rows.length} 位業務。詳細數字見下方表格。`;

  return (
    <figure className="m-0">
      <div
        className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground"
        aria-hidden="true"
      >
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ minWidth: 420, height: 'auto', display: 'block' }}
          role="img"
          aria-labelledby={titleId}
          aria-label={aria}
        >
          <title id={titleId}>{aria}</title>
          <line
            x1={LABEL_W}
            y1={TOP}
            x2={LABEL_W}
            y2={H - 8}
            style={{ stroke: AXIS_COLOR }}
            strokeWidth={1}
          />
          {rows.map((r, gi) => {
            const gy = TOP + gi * groupH;
            const labelY = gy + (SERIES.length * (BAR_H + BAR_GAP)) / 2;
            return (
              <g key={r.userId}>
                <text
                  x={LABEL_W - 8}
                  y={labelY}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={13}
                  style={{ fill: NUM_COLOR }}
                >
                  {r.userName.length > 8 ? `${r.userName.slice(0, 8)}…` : r.userName}
                </text>
                {SERIES.map((s, si) => {
                  const v = r[s.key];
                  const y = gy + si * (BAR_H + BAR_GAP);
                  const w = Math.max(v > 0 ? 2 : 0, (v / max) * plotW);
                  return (
                    <g key={s.key}>
                      <rect
                        x={LABEL_W + 1}
                        y={y}
                        width={w}
                        height={BAR_H}
                        style={{ fill: s.color }}
                        rx={2}
                      />
                      <text
                        x={LABEL_W + 1 + w + 5}
                        y={y + BAR_H / 2}
                        dominantBaseline="middle"
                        fontSize={12}
                        style={{ fill: NUM_COLOR }}
                      >
                        {s.label} {v}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="sr-only">{aria}</figcaption>
      <TableToggle summary="以表格檢視各訪查人員長條圖">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {rangeLabel}各訪查人員{seriesNames}
          </caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-1 pr-2">
                訪查人員
              </th>
              {SERIES.map((s) => (
                <th key={s.key} scope="col" className="py-1 pr-2 text-right">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-b border-border">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {r.userName}
                  {r.active === false ? (
                    // 「已停用」寫成文字,不只用顏色或位置表達
                    <span className="ml-1 rounded border border-border px-1 text-xs font-semibold">
                      已停用
                    </span>
                  ) : null}
                </th>
                {SERIES.map((s) => (
                  <td key={s.key} className="py-1 pr-2 text-right tabular-nums">
                    {r[s.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </figure>
  );
}

/* ---------- (2) 漏斗 ---------- */
function FunnelChart({ stages }: { stages: FunnelResp['stages'] }) {
  const stageMeta = useStageMeta();
  const titleId = useId();
  const W = 640;
  const LABEL_W = 96;
  const VALUE_W = 56;
  const ROW_H = 26;
  const BAR_H = 18;
  const TOP = 6;
  const H = TOP + stages.length * ROW_H + 6;
  const plotW = W - LABEL_W - VALUE_W - 16;
  const max = Math.max(1, ...stages.map((s) => s.count));
  const total = stages.reduce((a, s) => a + s.count, 0);
  const aria = `客戶階段漏斗,共 ${total} 筆客戶,依各階段目前筆數繪製。詳細數字見下方表格。`;

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ minWidth: 420, height: 'auto', display: 'block' }}
          role="img"
          aria-labelledby={titleId}
          aria-label={aria}
        >
          <title id={titleId}>{aria}</title>
          {stages.map((s, i) => {
            const y = TOP + i * ROW_H;
            const w = Math.max(s.count > 0 ? 2 : 0, (s.count / max) * plotW);
            // 漏斗:長條置中,越窄的階段左右縮進
            const x = LABEL_W + 1 + (plotW - w) / 2;
            const color = stageMeta.has(s.stage) ? stageMeta.colors(s.stage).fg : AXIS_COLOR;
            return (
              <g key={s.stage}>
                <text
                  x={LABEL_W - 8}
                  y={y + BAR_H / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={13}
                  style={{ fill: NUM_COLOR }}
                >
                  {stageMeta.label(s.stage)}
                </text>
                <rect x={x} y={y} width={w} height={BAR_H} style={{ fill: color }} rx={2} />
                <text
                  x={LABEL_W + 1 + plotW + 6}
                  y={y + BAR_H / 2}
                  dominantBaseline="middle"
                  fontSize={12}
                  style={{ fill: NUM_COLOR }}
                >
                  {s.count} 筆
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="sr-only">{aria}</figcaption>
      <TableToggle summary="以表格檢視漏斗">
        <table className="w-full text-sm">
          <caption className="sr-only">各階段目前筆數</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-1 pr-2">
                階段
              </th>
              <th scope="col" className="py-1 pr-2 text-right">
                筆數
              </th>
              <th scope="col" className="py-1 pr-2 text-right">
                占比
              </th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.stage} className="border-b border-border">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {stageMeta.label(s.stage)}
                </th>
                <td className="py-1 pr-2 text-right tabular-nums">{s.count}</td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {total ? Math.round((s.count / total) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableToggle>
    </figure>
  );
}

/* ---------- (3) 貢獻度表格 ---------- */
function ContributionTable({ data, rangeLabel }: { data: BySalesResp; rangeLabel: string }) {
  const metricLabel = useStatMetricLabel();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-1 text-left text-xs text-muted-foreground">
          {rangeLabel}貢獻度:分數 = {metricLabel.converted}×10 + {metricLabel.interested}×3 +{' '}
          {metricLabel.visits}×1 + 新客戶×0.5;前 25% A 級、前 60% B 級、其餘 C 級(少於 3 人時全部 B
          級)。
        </caption>
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-1 pr-2">
              姓名
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              分數
            </th>
            <th scope="col" className="py-1 pr-2">
              等級
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              開發中
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              {metricLabel.interested}
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              {metricLabel.converted}
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              拜訪
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              可疑打卡
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              互動
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              逾期
            </th>
            <th scope="col" className="py-1 pr-2 text-right">
              新客戶
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const g = GRADE_STYLE[r.grade] ?? GRADE_STYLE.B;
            return (
              <tr key={r.userId} className="border-b border-border">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {r.userName}
                  {r.active === false ? (
                    // 「已停用」寫成文字,不只用顏色或位置表達
                    <span className="ml-1 rounded border border-border px-1 text-xs font-semibold">
                      已停用
                    </span>
                  ) : null}
                </th>
                <td className="py-1 pr-2 text-right tabular-nums font-semibold">{r.score}</td>
                <td className="py-1 pr-2">
                  <span
                    className="inline-block rounded px-2 py-0.5 text-xs font-bold"
                    style={{ backgroundColor: g.bg, color: g.fg }}
                  >
                    {g.label}
                  </span>
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.inDev}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.interested}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.converted}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.visits}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.suspiciousVisits ?? 0}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.interactions}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.overdue}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.newCustomers}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <th scope="row" className="py-1 pr-2">
              合計
            </th>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.score}</td>
            <td className="py-1 pr-2">—</td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.inDev}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.interested}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.converted}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.visits}</td>
            <td className="py-1 pr-2 text-right tabular-nums">
              {data.totals.suspiciousVisits ?? 0}
            </td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.interactions}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.overdue}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{data.totals.newCustomers}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/* ---------- 主元件 ---------- */
export default function SalesCharts() {
  const metricLabel = useStatMetricLabel();
  const [range, setRange] = useState<StatRange>('week');
  const [bySales, setBySales] = useState<BySalesResp | null>(null);
  const [funnel, setFunnel] = useState<FunnelResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const load = useCallback(async (r: StatRange, signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const base = getApiBase();
      const [a, b] = await Promise.all([
        fetch(`${base}/api/admin/crm-stats/by-sales?range=${r}`, {
          credentials: 'include',
          signal,
        }),
        fetch(`${base}/api/admin/crm-stats/funnel`, { credentials: 'include', signal }),
      ]);
      if (a.status === 403 || b.status === 403)
        throw new Error('僅訪查主管與系統管理員可檢視戰情圖表');
      if (!a.ok || !b.ok) throw new Error('戰情資料載入失敗,請稍後再試');
      const [aj, bj] = (await Promise.all([a.json(), b.json()])) as [BySalesResp, FunnelResp];
      if (signal.aborted) return;
      setBySales({ ...aj, rows: Array.isArray(aj.rows) ? aj.rows : [] });
      setFunnel({ stages: Array.isArray(bj.stages) ? bj.stages : [] });
    } catch (e) {
      if (signal.aborted) return;
      // 不把外部錯誤字串直接顯示;只顯示自己的中文訊息
      setError(
        e instanceof Error && /^[一-鿿]/.test(e.message)
          ? e.message
          : '戰情資料載入失敗,請稍後再試',
      );
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(range, ac.signal);
    return () => ac.abort();
  }, [range, load]);

  const rangeLabel = RANGE_LABEL[range];
  const periodText = bySales ? `${fmtDate(bySales.from)}~${fmtDate(bySales.to)}` : '';

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface p-3 sm:p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-base font-bold text-foreground">
          戰情圖表
          {periodText && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({rangeLabel} {periodText})
            </span>
          )}
        </h3>
        <div role="group" aria-label="統計範圍" className="flex flex-wrap gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`btn text-xs ${r === range ? 'btn-primary' : ''}`}
              aria-pressed={r === range}
              onClick={() => setRange(r)}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <p role="status" aria-live="polite" className="mb-2 min-h-[1.25rem] text-sm text-foreground">
        {loading
          ? `載入${rangeLabel}戰情資料中…`
          : error
            ? `錯誤:${error}`
            : bySales && bySales.rows.length === 0
              ? '此期間尚無任何訪查人員資料。'
              : ''}
      </p>

      {!loading && !error && bySales && funnel && (
        <div className="flex flex-col gap-6">
          {bySales.rows.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold text-foreground">
                各訪查人員:{metricLabel.visits} / {metricLabel.interested} / {metricLabel.converted}
              </h4>
              <SalesBarChart rows={bySales.rows} rangeLabel={rangeLabel} />
            </div>
          )}
          <div>
            {/* 後端會依可見範圍限縮:訪查主管看到的是自己團隊,系統管理員才是全部。
                標題寫「全部客戶」的話,主管會拿這個數字跟別人對不起來。 */}
            <h4 className="mb-1 text-sm font-semibold text-foreground">
              客戶階段漏斗(目前看得到的客戶)
            </h4>
            <p className="mb-1 text-xs text-muted-foreground">
              合計等於各訪查人員狀態表的合計:包含停用帳號名下的客戶,不含已被查重合併掉的那些。
            </p>
            <FunnelChart stages={funnel.stages} />
          </div>
          {bySales.rows.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold text-foreground">貢獻度分級</h4>
              <ContributionTable data={bySales} rangeLabel={rangeLabel} />
              <p className="mt-1 text-xs text-muted-foreground">
                「{metricLabel.converted}」為期間內標記成交的筆數;「開發中 /{' '}
                {metricLabel.interested} / 逾期」為目前狀態,不受期間影響。
                停用(離職)帳號一樣列出、名下客戶一樣算,與上方各訪查人員狀態表和漏斗同一個口徑。
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
