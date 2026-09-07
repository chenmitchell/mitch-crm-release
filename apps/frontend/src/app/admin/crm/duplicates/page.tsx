'use client';

// 客戶查重合併頁(/admin/crm/duplicates)。
// 資料來源:GET /api/admin/crm-duplicates(群組,可帶 ownerId / stage 篩選)、
//           POST /api/admin/crm-duplicates/merge。
// 角色:admin/sales/sales_manager 可用;業務只看到、只能合併自己的客戶。
// 流程:每群用 radio 選「保留哪一筆」,按「合併」,顯示確認說明,確認後送出,成功後該群從清單移除。
//
// 篩選器不是加值功能:後端一次最多比對一萬筆,超過就整支回 400。沒有篩選器的話,
// 客戶多的部署每次打開這一頁都只拿得到一句「請縮小範圍」,而縮小範圍的操作並不存在。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import { canUseCrm, isViewAllRole, useCrmRole, useStageMeta } from '@/lib/crm-shared';
import { useLookupLabel } from '@/lib/app-settings';

interface DupeCustomer {
  id: string;
  taxId: string | null;
  companyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  stage: string;
  ownerName: string;
  interactionCount: number;
  createdAt: string;
}
interface DupeGroup {
  key: string;
  reason: string;
  customers: DupeCustomer[];
}
/** 負責人篩選的選項來源(與本週工作報告同一支端點) */
interface SalesUser {
  id: string;
  name: string | null;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function nameOf(c: DupeCustomer): string {
  return c.companyName || c.taxId || '(未命名)';
}

export default function CrmDuplicatesPage() {
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();

  const stageMeta = useStageMeta();
  // 角色走共用 hook(見 lib/crm-shared 的 useCrmRole),整站對 /api/auth/me 只有一個呼叫點
  const role = useCrmRole();
  const [groups, setGroups] = useState<DupeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 篩選條件。ownerId 只有看得到全部的角色才用得上(業務本來就只看得到自己的)
  const [ownerId, setOwnerId] = useState('');
  const [stage, setStage] = useState('');
  const [users, setUsers] = useState<SalesUser[]>([]);
  // 這一次實際比對了幾筆、上限是多少。沒有這兩個數字,使用者分不出
  // 「真的沒有重複」與「條件篩得太窄所以沒比到」
  const [scanned, setScanned] = useState<number | null>(null);
  const [scanLimit, setScanLimit] = useState<number | null>(null);
  // 每群目前選到要保留的 id
  const [keepByGroup, setKeepByGroup] = useState<Record<string, string>>({});
  // 正在確認中的群(顯示確認說明)
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 焦點管理:按「合併此群組」後焦點移到「確定合併」;取消或失敗回到「合併此群組」
  const confirmBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const mergeBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // 上一次 confirmKey(關掉確認框時知道要把焦點還給哪一群)
  const prevConfirmKeyRef = useRef<string | null>(null);
  // 合併成功時該群已從清單移除,焦點改到標題,不要再找那群的按鈕
  const mergedOkKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevConfirmKeyRef.current;
    prevConfirmKeyRef.current = confirmKey;
    if (confirmKey) {
      confirmBtnRefs.current[confirmKey]?.focus();
      return;
    }
    if (prev && mergedOkKeyRef.current !== prev) mergeBtnRefs.current[prev]?.focus();
    mergedOkKeyRef.current = null;
  }, [confirmKey]);

  const canUse = canUseCrm(role);
  const isManager = isViewAllRole(role);
  const base = `${getApiBase()}/api/admin/crm-duplicates`;

  // 負責人清單只有主管與系統管理員需要,而且抓不到也不影響本頁主要內容
  useEffect(() => {
    if (!isManager) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/admin/crm/sales-users`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { rows?: SalesUser[] };
        if (alive) setUsers(data.rows ?? []);
      } catch {
        // 抓不到就維持「全部負責人」,篩選器少一個選項不該讓整頁失敗
      }
    })();
    return () => {
      alive = false;
    };
  }, [isManager]);

  const load = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      // 業務不送 ownerId:他的可見範圍本來就只有自己,送了也只是多一個參數
      if (isManager && ownerId) qs.set('ownerId', ownerId);
      if (stage) qs.set('stage', stage);
      const query = qs.toString();
      const res = await fetch(query ? `${base}?${query}` : base, { credentials: 'include' });
      if (!res.ok) {
        // 401 走全站共用規則(見 lib/api-error):以前這裡把狀態碼丟成例外,
        // 畫面顯示的是通用的載入失敗,登入過期看不出原因。
        // 400(超過比對上限)後端給的就是「請用篩選器縮小範圍」,原句照顯示,
        // 而那句話指的篩選器就在這一頁上面
        setError(await apiErrorMessage(res, '查重資料載入失敗,請稍後再試'));
        setGroups([]);
        setScanned(null);
        return;
      }
      const data = (await res.json()) as {
        groups?: DupeGroup[];
        scanned?: number;
        scanLimit?: number;
      };
      const list = data.groups ?? [];
      setGroups(list);
      setScanned(typeof data.scanned === 'number' ? data.scanned : null);
      setScanLimit(typeof data.scanLimit === 'number' ? data.scanLimit : null);
      // 預設保留互動最多的那筆(同數取最早建檔)。
      // 只對新出現的群組補預設;使用者已經選過的(例如合併失敗後重載)照舊保留,
      // 但選的那筆若已不在群組裡就重設
      setKeepByGroup((prev) => {
        const next: Record<string, string> = {};
        for (const g of list) {
          const chosen = prev[g.key];
          if (chosen && g.customers.some((c) => c.id === chosen)) {
            next[g.key] = chosen;
            continue;
          }
          const best = [...g.customers].sort(
            (a, b) =>
              b.interactionCount - a.interactionCount || a.createdAt.localeCompare(b.createdAt),
          )[0];
          if (best) next[g.key] = best.id;
        }
        return next;
      });
    } catch {
      setError('讀取疑似重複清單失敗,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canUse, base, isManager, ownerId, stage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doMerge(g: DupeGroup) {
    const keepId = keepByGroup[g.key];
    const keep = g.customers.find((c) => c.id === keepId);
    const others = g.customers.filter((c) => c.id !== keepId);
    if (!keep || others.length === 0) return;
    setMergingKey(g.key);
    setStatus(`合併中:${others.map(nameOf).join('、')} 併入 ${nameOf(keep)}`);
    let movedTotal = 0;
    try {
      // 群內可能超過兩筆:逐筆併入保留者
      for (const o of others) {
        const res = await fetch(`${base}/merge`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keepId: keep.id, mergeId: o.id }),
        });
        if (!res.ok) {
          const fallback =
            res.status === 403 || res.status === 404
              ? `你沒有合併 ${nameOf(o)} 的權限`
              : `${nameOf(o)} 尚未併入,請稍後再試`;
          setStatus(`合併失敗:${await apiErrorMessage(res, fallback)}`);
          // 先解除 fieldset 的 disabled,焦點才回得到「合併此群組」按鈕
          setMergingKey(null);
          setConfirmKey(null);
          await load();
          return;
        }
        movedTotal += o.interactionCount;
      }
      setGroups((prev) => prev.filter((x) => x.key !== g.key));
      mergedOkKeyRef.current = g.key;
      setConfirmKey(null);
      setStatus(
        `已合併:${others.map(nameOf).join('、')} 併入 ${nameOf(keep)},移入 ${movedTotal} 筆互動`,
      );
      headingRef.current?.focus();
    } catch {
      setStatus('合併失敗:連線異常,請稍後再試');
      setMergingKey(null);
      setConfirmKey(null);
    } finally {
      setMergingKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="outline-none">
            客戶查重合併
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            列出{lookupLabel}
            、電話或公司名相同的客戶。選好要保留的那一筆,其他筆的互動紀錄會併入,原本那筆會標成「無效/放棄」。
          </p>
        </div>
        <Link href="/admin/crm" className="btn">
          回客戶看板
        </Link>
      </header>

      <p role="status" aria-live="polite" className="min-h-[1.5rem] text-sm text-foreground">
        {status}
      </p>

      {canUse && (
        <section
          aria-labelledby="dupe-filter-title"
          className="rounded-md border border-border bg-surface p-3"
        >
          <h2 id="dupe-filter-title" className="text-base font-semibold text-foreground">
            篩選比對範圍
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            一次最多比對
            {scanLimit === null ? '一定筆數' : ` ${scanLimit} 筆`}
            客戶。超過的話這裡先選一位負責人或一個階段,把範圍縮小再查。
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {isManager && (
              <div className="flex min-w-[12rem] flex-col gap-1">
                <label htmlFor="dupe-owner" className="field-label">
                  負責人
                </label>
                <select
                  id="dupe-owner"
                  className="input"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                >
                  <option value="">全部負責人</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || '(未命名)'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex min-w-[12rem] flex-col gap-1">
              <label htmlFor="dupe-stage" className="field-label">
                階段
              </label>
              {/* 階段清單一律從後台設定讀(useStageMeta),不在畫面裡寫死任何一組階段 */}
              <select
                id="dupe-stage"
                className="input"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                <option value="">全部階段</option>
                {stageMeta.all.map((st) => (
                  <option key={st.key} value={st.key}>
                    {st.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOwnerId('');
                  setStage('');
                }}
                disabled={!ownerId && !stage}
              >
                清除篩選
              </button>
            </div>
          </div>
          {scanned !== null && !error && (
            <p className="mt-2 text-sm text-foreground">
              這一次比對了 {scanned} 筆客戶,找到 {groups.length} 組疑似重複。
            </p>
          )}
        </section>
      )}

      {role !== null && !canUse && (
        <p className="rounded-md border border-border bg-surface p-3 text-sm text-foreground">
          你的帳號沒有客戶管理的使用權限,請找系統管理員開通。
        </p>
      )}

      {loading && canUse && <p className="text-sm text-muted-foreground">載入中…</p>}

      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-3 text-sm">
          <span className="text-foreground">{error}</span>
          <button type="button" className="btn" onClick={() => void load()}>
            重新讀取
          </button>
        </div>
      )}

      {!loading && canUse && !error && groups.length === 0 && (
        <p className="text-sm text-foreground">
          {ownerId || stage
            ? '這個範圍裡沒有疑似重複的客戶。換一組篩選條件可以再查一次。'
            : '目前沒有疑似重複的客戶。'}
        </p>
      )}

      {groups.length > 0 && (
        <ul className="flex flex-col gap-4" aria-label="疑似重複群組">
          {groups.map((g, gi) => {
            const keepId = keepByGroup[g.key];
            const keep = g.customers.find((c) => c.id === keepId);
            const others = g.customers.filter((c) => c.id !== keepId);
            const groupLabelId = `dupe-group-${gi}-label`;
            const busy = mergingKey === g.key;
            const confirming = confirmKey === g.key;
            return (
              <li key={g.key} className="card">
                <fieldset className="m-0 border-0 p-0" disabled={busy}>
                  <legend
                    id={groupLabelId}
                    className="mb-2 text-base font-semibold text-foreground"
                  >
                    群組 {gi + 1}:{g.reason}(共 {g.customers.length} 筆)
                  </legend>
                  <p className="mb-2 text-sm text-muted-foreground">
                    請選擇要保留的那一筆,其餘會併入它。
                  </p>
                  <ul className="flex flex-col gap-2">
                    {g.customers.map((c) => {
                      const radioId = `dupe-${gi}-${c.id}`;
                      const selected = keepId === c.id;
                      return (
                        <li
                          key={c.id}
                          className="rounded-md border bg-background p-2"
                          style={{
                            borderColor: selected ? 'var(--color-primary)' : 'var(--color-border)',
                          }}
                        >
                          <label htmlFor={radioId} className="w-full">
                            <input
                              id={radioId}
                              type="radio"
                              name={`keep-${gi}`}
                              value={c.id}
                              checked={selected}
                              onChange={() =>
                                setKeepByGroup((prev) => ({ ...prev, [g.key]: c.id }))
                              }
                            />
                            <span className="font-medium text-foreground">
                              保留:{nameOf(c)}
                              {selected ? '(目前選取)' : ''}
                            </span>
                          </label>
                          <dl className="ml-7 grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm text-muted-foreground sm:grid-cols-2">
                            <div>
                              <dt className="inline">{lookupLabel}:</dt>
                              <dd className="inline">{c.taxId || '—'}</dd>
                            </div>
                            <div>
                              <dt className="inline">電話:</dt>
                              <dd className="inline">{c.contactPhone || '—'}</dd>
                            </div>
                            <div>
                              <dt className="inline">聯絡人:</dt>
                              <dd className="inline">{c.contactName || '—'}</dd>
                            </div>
                            <div>
                              <dt className="inline">階段:</dt>
                              <dd className="inline">{stageMeta.label(c.stage)}</dd>
                            </div>
                            <div>
                              <dt className="inline">負責人:</dt>
                              <dd className="inline">{c.ownerName}</dd>
                            </div>
                            <div>
                              <dt className="inline">互動:</dt>
                              <dd className="inline">{c.interactionCount} 筆</dd>
                            </div>
                            <div>
                              <dt className="inline">建檔:</dt>
                              <dd className="inline">{fmtDate(c.createdAt)}</dd>
                            </div>
                            <div>
                              <Link
                                href={`/admin/crm/${c.id}`}
                                className="inline-flex min-h-[44px] items-center"
                              >
                                開啟 {nameOf(c)} 的客戶卡
                              </Link>
                            </div>
                          </dl>
                        </li>
                      );
                    })}
                  </ul>

                  {!confirming && (
                    <div className="mt-3">
                      <button
                        type="button"
                        ref={(el) => {
                          mergeBtnRefs.current[g.key] = el;
                        }}
                        className="btn btn-primary"
                        disabled={!keep || others.length === 0}
                        onClick={() => setConfirmKey(g.key)}
                      >
                        合併此群組
                      </button>
                    </div>
                  )}

                  {confirming && keep && (
                    <div
                      role="group"
                      aria-labelledby={`dupe-confirm-${gi}`}
                      className="mt-3 rounded-md border-2 p-3 text-sm"
                      style={{
                        borderColor: 'var(--color-warning)',
                        backgroundColor: 'var(--color-surface)',
                      }}
                    >
                      <h2 id={`dupe-confirm-${gi}`} className="text-base">
                        確認合併
                      </h2>
                      <ul className="mt-1 list-disc pl-5 text-foreground">
                        <li>
                          保留:<strong>{nameOf(keep)}</strong>(負責人 {keep.ownerName})
                        </li>
                        <li>
                          併入並標成「無效/放棄」:
                          {others.map((o) => (
                            <span key={o.id}>
                              {' '}
                              <strong>{nameOf(o)}</strong>({o.interactionCount} 筆互動)
                            </span>
                          ))}
                        </li>
                        <li>
                          被併入那幾筆的互動紀錄會全部移到保留的客戶底下,保留者空白的欄位會用被併入者的資料補上。
                        </li>
                        <li>這個動作不可復原。</li>
                      </ul>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          ref={(el) => {
                            confirmBtnRefs.current[g.key] = el;
                          }}
                          className="btn btn-warning"
                          onClick={() => void doMerge(g)}
                          disabled={busy}
                        >
                          {busy ? '合併中…' : '確定合併'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setConfirmKey(null)}
                          disabled={busy}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </fieldset>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
