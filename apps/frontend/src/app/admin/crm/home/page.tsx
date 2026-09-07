'use client';

// 我的首頁(/admin/crm/home):手機優先、單欄,一頁看完今天要做什麼。
// 由上而下:新增客戶大按鈕 → 今日三件事(共用 today-top3)→ 今日拜訪計畫(當天排程,可直接去打卡或看地圖)
//   → 四個快速入口(打卡、日報、地圖、秒查)。
// 資料來源:角色與自己的 id 讀共用 context(lib/me-context)、GET /api/admin/crm(客戶清單,今日三件事用)、
//   GET /api/admin/crm-visit-plans?from=今天&to=今天(今日拜訪計畫)。
// 無障礙:單一 h1、區塊有 h2、狀態訊息 role="status" aria-live、按鈕與連結 ≥44px(.btn 已含)、
//   排程狀態以文字標籤呈現不只靠顏色。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import TodayTop3, { type TodayCustomer } from '@/components/crm/today-top3';
import { canUseCrm, useCrmRole } from '@/lib/crm-shared';
import { useMe } from '@/lib/me-context';
import {
  VISIT_PLAN_STATUS_COLORS,
  VISIT_PLAN_STATUS_LABEL,
  fmtDateZh,
  type VisitPlanRow,
} from '@/components/crm/visit-plan-panel';
import { orgToday } from '@mitchcrm/shared';
import { useAppSettings } from '@/lib/app-settings';

interface CustomerRow extends TodayCustomer {
  ownerId: string;
}

/** 今日三件事要看的客戶筆數上限(後端 CUSTOMER_LIST_TAKE_MAX 同值) */
const CUSTOMER_TAKE = 1000;

const QUICK_LINKS: { href: string; label: string; desc: string }[] = [
  { href: '/admin/crm/field/checkin', label: 'GPS 到訪打卡', desc: '到客戶門口按一下,留下存證' },
  { href: '/admin/crm/field/report', label: '拜訪日報', desc: '今天跑了哪些家,送給主管' },
  { href: '/admin/crm/map', label: '拜訪地圖', desc: '看客戶在哪,規劃路線' },
  { href: '/admin/crm/search', label: '秒查客戶', desc: '打公司名或識別碼馬上找到' },
];

export default function CrmHomePage() {
  // 角色與自己的 id 走共用 context(見 lib/crm-shared 的 useCrmRole 與 lib/me-context),
  // 整站對 /api/auth/me 只有一個呼叫點
  const { me } = useMe();
  const role = useCrmRole();
  // 自己的 id 從共用的登入者 context 拿(見 lib/me-context),這一頁不再自己打 /api/auth/me
  const meId = me?.sub ?? null;
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  // 客戶清單被後端上限切掉:今日三件事挑的是最急的幾筆,截掉的是最不急的那一端,
  // 但仍要說出來,不能讓人以為畫面上就是全部
  const [customersTruncated, setCustomersTruncated] = useState(false);
  const [plans, setPlans] = useState<VisitPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 角色判斷一律走 lib/crm-shared 的 canUseCrm,不要在各頁各寫一份(改角色時一定漏掉某一頁)
  const canUse = canUseCrm(role);
  // 「今天」以組織設定的時區計,不是瀏覽器時區也不是寫死的台北
  const { timezone } = useAppSettings();
  const today = orgToday(new Date(), timezone);

  const load = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const base = getApiBase();
      // 這頁是「我今天要做什麼」,不是全隊檢視:主管 / admin 後端預設回全隊,
      // 所以明確帶 ownerId=自己把範圍收回本人(業務帶不帶都一樣,後端本來就只給自己的)
      const mine = meId ? `?ownerId=${encodeURIComponent(meId)}` : '';
      // 清單一次最多 1000 筆(後端上限),而且照 nextFollowUpAt 由早到晚排,
      // 所以被截掉的一定是最不急的那一端;有截到就在畫面上說一句。
      const [cRes, pRes] = await Promise.all([
        fetch(`${base}/api/admin/crm${mine}${mine ? '&' : '?'}limit=${CUSTOMER_TAKE}`, {
          credentials: 'include',
        }),
        fetch(
          `${base}/api/admin/crm-visit-plans?from=${today}&to=${today}${meId ? `&ownerId=${encodeURIComponent(meId)}` : ''}`,
          { credentials: 'include' },
        ),
      ]);
      if (cRes.ok) {
        const data = (await cRes.json()) as { rows?: CustomerRow[]; nextCursor?: string | null };
        setCustomers(data.rows ?? []);
        setCustomersTruncated(typeof data.nextCursor === 'string');
      }
      if (pRes.ok) {
        const data = (await pRes.json()) as { rows?: VisitPlanRow[] };
        setPlans(data.rows ?? []);
      }
      // 任一支 401 都走全站共用規則(見 lib/api-error):登入過期時導回登入頁,
      // 而不是叫人「下拉重整」—— 重整幾次都不會成功
      if (cRes.ok && pRes.ok) setError('');
      else if (!cRes.ok)
        setError(await apiErrorMessage(cRes, '部分資料載入失敗,請下拉重整或稍後再試'));
      else setError(await apiErrorMessage(pRes, '部分資料載入失敗,請下拉重整或稍後再試'));
    } catch {
      setError('資料載入失敗:網路連線異常,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canUse, today, meId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (role === null) {
    return <div className="p-4 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-4">
        <h1 className="text-lg font-semibold">我的首頁</h1>
        <p className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用客戶管理。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </p>
      </div>
    );
  }

  const todoPlans = plans.filter((p) => p.status === 'planned');
  const donePlans = plans.filter((p) => p.status === 'done');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      <h1 className="text-lg font-semibold">我的首頁</h1>

      {/* 主要動作:新增客戶 */}
      <Link
        href={'/admin/crm/new' as Route}
        className="btn btn-primary w-full text-base"
        style={{ minHeight: '56px' }}
      >
        新增客戶
      </Link>

      <p role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-foreground">
        {error}
      </p>

      {/* 今日三件事:從客戶清單自己算,元件內含標題 */}
      {loading ? (
        <p className="text-sm text-muted-foreground">載入中…</p>
      ) : (
        <>
          <TodayTop3 customers={customers} />
          {customersTruncated ? (
            <p className="text-xs text-muted-foreground">
              你名下的客戶超過 {CUSTOMER_TAKE}{' '}
              筆,這裡只看了跟進日期最早的那一批。要找其他客戶請用秒查客戶。
            </p>
          ) : null}
        </>
      )}

      {/* 今日拜訪計畫 */}
      <section
        aria-labelledby="today-plans-title"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="today-plans-title" className="text-base font-semibold">
          今日拜訪計畫
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {fmtDateZh(today)},排 {plans.length} 家、已完成 {donePlans.length} 家
          </span>
        </h2>
        {loading ? (
          <p className="mt-2 text-sm text-muted-foreground">載入中…</p>
        ) : plans.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            今天還沒排拜訪。到客戶卡的「排拜訪」可以先把這週要跑的排好。
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {[...todoPlans, ...plans.filter((p) => p.status !== 'planned')].map((p) => {
              // 後端之後新增狀態時不要整頁壞掉:配色與標籤都退回 planned
              const c = VISIT_PLAN_STATUS_COLORS[p.status] ?? VISIT_PLAN_STATUS_COLORS.planned;
              return (
                <li key={p.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/crm/${p.customerId}` as Route}
                      className="text-sm font-semibold underline"
                    >
                      {p.companyName}
                    </Link>
                    <span
                      className="rounded px-2 py-0.5 text-xs font-semibold"
                      style={{ backgroundColor: c.bg, color: c.fg }}
                    >
                      {VISIT_PLAN_STATUS_LABEL[p.status] ?? VISIT_PLAN_STATUS_LABEL.planned}
                    </span>
                  </div>
                  {p.address ? (
                    <p className="mt-1 text-sm text-muted-foreground">{p.address}</p>
                  ) : null}
                  {p.note ? <p className="mt-1 text-sm text-foreground">{p.note}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-3">
                    <Link
                      href={`/admin/crm/field/checkin?customerId=${p.customerId}` as Route}
                      className="btn btn-primary"
                    >
                      去打卡<span className="sr-only">:{p.companyName}</span>
                    </Link>
                    <Link href={'/admin/crm/map' as Route} className="btn">
                      導航<span className="sr-only">:在拜訪地圖上找 {p.companyName}</span>
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Link href={'/admin/crm/week' as Route} className="btn mt-3 inline-flex">
          看本週工作報告
        </Link>
      </section>

      {/* 快速入口 */}
      <section
        aria-labelledby="quick-title"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="quick-title" className="text-base font-semibold">
          常用功能
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {QUICK_LINKS.map((q) => (
            <li key={q.href}>
              <Link
                href={q.href as Route}
                className="btn w-full flex-col items-start gap-1 px-3 py-3 text-left"
                style={{ minHeight: '64px' }}
              >
                <span className="text-sm font-semibold">{q.label}</span>
                <span className="text-xs font-normal text-muted-foreground">{q.desc}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
