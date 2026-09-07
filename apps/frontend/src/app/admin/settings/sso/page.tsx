'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { useOrgTimeFormat } from '@/lib/app-settings';
import { apiErrorMessage, redirectToLogin } from '@/lib/api-error';

/**
 * 後台「單一登入設定」(admin only)
 *
 * 這頁存在的理由:原本 Microsoft 登入的所有設定都只能改環境變數再重啟服務。
 * IT 想加一個允許的網域、想確認設定對不對、想看誰用 SSO 登入過,後台一律看不到。
 * 交付給企業 IT 自行維運的東西不能長這樣。
 *
 * 這頁能做的:
 *   - 看目前狀態(缺哪幾個值逐條列出,不是只說「未設定」)
 *   - 維護允許登入的網域清單(存資料庫,存完立刻生效,不用重啟)
 *   - 切換「AD 有這個人就自動開帳號」
 *   - 複製要填進 Entra 的重新導向 URI(填錯是最常見的失敗原因)
 *   - 按一顆按鈕實際去打 Microsoft 的 OpenID discovery,確認租用戶存在且連得到
 *   - 看最近的 SSO 登入紀錄(成功與失敗、失敗原因分類)
 *
 * 這頁「不」做的:改租用戶 / 用戶端識別碼 / 用戶端密碼。那三個要與 Entra 上的
 * 應用程式註冊一字不差,而密碼絕對不進資料庫、不回前端。它們留在環境變數。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

interface MissingSetting {
  key: string;
  label: string;
  hint: string;
}

interface SsoStatus {
  enabled: boolean;
  missing: MissingSetting[];
  tenantId: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string | null;
  postLoginUrl: string | null;
  allowedDomains: string[];
  allowedDomainsSource: 'db' | 'env' | 'default';
  autoProvision: boolean;
  autoProvisionSource: 'db' | 'env' | 'default';
  /** 登入時要不要一併同步主管(要 User.Read.All,需要系統管理員同意) */
  syncManager: boolean;
  /**
   * 自動建帳號時的預設歸屬。訪查主管看得到誰是由部門與所屬主管兩欄算的,
   * 兩欄都空著的帳號對所有主管都是隱形的,所以這兩格不是選配的裝飾。
   * 名稱為 null 代表設定裡指的那一筆已經被刪掉或停用了。
   */
  defaultDepartmentId: string | null;
  defaultDepartmentName: string | null;
  defaultManagerId: string | null;
  defaultManagerName: string | null;
  envAllowedDomains: string[];
  envAutoProvision: boolean;
  startPath: string;
  callbackPath: string;
}

interface CheckResult {
  ok: boolean;
  code: string;
  message: string;
  checkedUrl: string | null;
  issuer?: string | null;
  authorizationEndpoint?: string | null;
  tenantMatches?: boolean;
}

interface LoginLogRow {
  id: string;
  result: 'success' | 'denied';
  email: string | null;
  emailDomain: string | null;
  reason: string | null;
  reasonLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** 組織部門(GET /api/admin/departments)。下拉用,只需要這三欄 */
interface DepartmentRow {
  id: string;
  name: string;
  parentId?: string | null;
}

/** 可以當預設主管的帳號(GET /api/admin/users) */
interface UserRow {
  id: string;
  name: string;
  role: string;
  status: 'active' | 'disabled';
}

/**
 * 部門下拉的顯示名稱:上層部門用「上層 / 子部門」串起來。
 * 同名的子部門在不同上層底下很常見,只印自己的名字選不出是哪一個。
 * 有環也不會無限迴圈(走過的節點就停),理由同後端 departmentSubtreeIds。
 */
function departmentPathLabel(rows: readonly DepartmentRow[], id: string): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

/** 畫面上的一列網域。includeSub 對應設定值的 *. 前綴 */
interface DomainRow {
  id: number;
  value: string;
  includeSub: boolean;
}

type Flash = { kind: 'success' | 'error'; text: string } | null;

const SOURCE_LABEL: Record<string, string> = {
  db: '後台設定',
  env: '環境變數',
  default: '未設定',
};

let rowSeq = 0;
function toRows(domains: string[]): DomainRow[] {
  return domains.map((d) => ({
    id: ++rowSeq,
    value: d.startsWith('*.') ? d.slice(2) : d,
    includeSub: d.startsWith('*.'),
  }));
}
function toValues(rows: DomainRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const v = r.value.trim().replace(/^\*\./, '');
    if (!v) continue; // 新增了一列但還沒填,存檔時直接忽略
    out.push(r.includeSub ? `*.${v}` : v);
  }
  return out;
}

export default function AdminSsoSettingsPage() {
  // 時間一律照組織設定的時區顯示,不吃看的人的裝置時區與語系
  const fmtTime = useOrgTimeFormat();
  const [status, setStatus] = useState<SsoStatus | null>(null);
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [autoProvision, setAutoProvision] = useState(false);
  const [syncManager, setSyncManager] = useState(false);
  // '' = 不指定。送出時轉成 null,讓後端把歸屬清掉
  const [defaultDepartmentId, setDefaultDepartmentId] = useState('');
  const [defaultManagerId, setDefaultManagerId] = useState('');
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [logs, setLogs] = useState<LoginLogRow[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/sso`, { credentials: 'include' });
      if (res.status === 401) {
        // 401 全站同一套處理(見 lib/api-error):導回登入頁並帶上 next
        redirectToLogin();
        return;
      }
      if (res.status === 403) {
        setError('你沒有權限管理單一登入設定(只有系統管理員可以)');
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`載入失敗(HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as SsoStatus;
      setStatus(data);
      setRows(toRows(data.allowedDomains));
      setAutoProvision(data.autoProvision);
      setSyncManager(Boolean(data.syncManager));
      setDefaultDepartmentId(data.defaultDepartmentId ?? '');
      setDefaultManagerId(data.defaultManagerId ?? '');
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/sso/logins?limit=50`, {
        credentials: 'include',
      });
      if (res.ok) {
        const d = (await res.json()) as { logins: LoginLogRow[] };
        setLogs(d.logins ?? []);
      }
    } catch {
      /* 登入紀錄載不到不影響設定本身,靜靜略過 */
    } finally {
      setLogsLoading(false);
    }
  }, []);

  /**
   * 預設歸屬兩個下拉的選項來源。
   * 載不到不影響設定頁本身:下拉會空著,並在旁邊寫出「載不到」,
   * 不是靜靜給一份空清單讓人以為公司裡沒有部門。
   */
  const loadOrg = useCallback(async () => {
    const base = getApiBase();
    const [dept, user] = await Promise.allSettled([
      fetch(`${base}/api/admin/departments`, { credentials: 'include' }),
      fetch(`${base}/api/admin/users`, { credentials: 'include' }),
    ]);
    if (dept.status === 'fulfilled' && dept.value.ok) {
      const body = (await dept.value.json()) as { departments?: DepartmentRow[] };
      setDepartments(body.departments ?? []);
    }
    if (user.status === 'fulfilled' && user.value.ok) {
      const body = (await user.value.json()) as { users?: UserRow[] };
      setUsers((body.users ?? []).filter((u) => u.status === 'active'));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadLogs();
    void loadOrg();
  }, [load, loadLogs, loadOrg]);

  // 確認對話框:Esc 關閉。監聽掛在 document 上而不是遮罩 div ——
  // 遮罩是非互動元素,焦點在對話框內的按鈕時,掛在遮罩上的 onKeyDown 收不到事件。
  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmOpen]);

  const cleanedDomains = useMemo(() => toValues(rows), [rows]);
  const willBeUnrestricted = cleanedDomains.length === 0;
  const willEnableAutoProvision = autoProvision && status?.autoProvision === false;
  const needsConfirm = willBeUnrestricted || willEnableAutoProvision;

  function updateRow(id: number, patch: Partial<DomainRow>) {
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((cur) => [...cur, { id: ++rowSeq, value: '', includeSub: false }]);
  }

  function removeRow(id: number) {
    setRows((cur) => cur.filter((r) => r.id !== id));
  }

  async function doSave() {
    setSaving(true);
    setFlash(null);
    setConfirmOpen(false);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/sso`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowedDomains: cleanedDomains,
          autoProvision,
          syncManager,
          defaultDepartmentId: defaultDepartmentId || null,
          defaultManagerId: defaultManagerId || null,
        }),
      });
      if (!res.ok) {
        // 訊息規則走 lib/api-error,不在這裡自己解析 body
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, `儲存失敗(HTTP ${res.status})`),
        });
        return;
      }
      const next = (await res.json()) as SsoStatus;
      setStatus(next);
      setRows(toRows(next.allowedDomains));
      setAutoProvision(next.autoProvision);
      setSyncManager(Boolean(next.syncManager));
      setDefaultDepartmentId(next.defaultDepartmentId ?? '');
      setDefaultManagerId(next.defaultManagerId ?? '');
      setFlash({ kind: 'success', text: '已儲存,下一次 Microsoft 登入立即套用(不用重啟服務)' });
    } catch (err) {
      setFlash({ kind: 'error', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  function onSaveClick() {
    if (needsConfirm) {
      setConfirmOpen(true);
      // 確認步驟預設停在「取消」上:危險選項不要放在焦點的第一順位
      window.setTimeout(() => confirmCancelRef.current?.focus(), 0);
      return;
    }
    void doSave();
  }

  async function onCheck() {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/sso/check`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.status === 429) {
        setCheckResult({
          ok: false,
          code: 'rate_limited',
          message: '檢查太頻繁,請等一分鐘再試(這支會實際對外連線,所以有次數限制)',
          checkedUrl: null,
        });
        return;
      }
      const data = (await res.json()) as CheckResult;
      setCheckResult(data);
    } catch (err) {
      setCheckResult({
        ok: false,
        code: 'client_error',
        message: `無法呼叫檢查端點:${(err as Error).message}`,
        checkedUrl: null,
      });
    } finally {
      setChecking(false);
    }
  }

  async function copyRedirectUri() {
    const value = status?.redirectUri;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      setCopied(false);
      setFlash({ kind: 'error', text: '瀏覽器不允許自動複製,請手動選取上面的網址複製' });
    }
  }

  if (loading) return <p className="text-muted-foreground">載入中...</p>;
  if (error)
    return (
      <p role="alert" className="flash flash-error">
        {error}
      </p>
    );
  if (!status) return null;

  return (
    <article className="space-y-4">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">
          <Link href="/admin" className="underline">
            後台
          </Link>{' '}
          /{' '}
          <Link href="/admin/settings" className="underline">
            系統設定
          </Link>{' '}
          / 單一登入
        </p>
        <h1>單一登入設定(Microsoft 365 / Entra ID)</h1>
        <p className="page-subtle max-w-[70ch]">
          讓同仁用公司的 Microsoft 帳號登入後台,不用再記一組系統專用密碼。
          <abbr tabIndex={0} title="Single Sign-On,單一登入:用同一組公司帳號登入多個系統">
            SSO
          </abbr>
          與原本的帳號密碼登入並存,不是取代。
        </p>
      </header>

      {flash ? (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`flash ${flash.kind === 'success' ? 'flash-success' : 'flash-error'}`}
        >
          {flash.text}
        </p>
      ) : null}

      {/* ── 目前狀態 ─────────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-status-h">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="sso-status-h" className="page-h2">
            目前狀態
          </h2>
          <span className={`badge ${status.enabled ? 'badge-success' : 'badge-warning'}`}>
            {status.enabled ? '已啟用' : '尚未設定完成'}
          </span>
        </div>

        {status.enabled ? (
          <p className="text-sm">
            四個必要設定值都齊了,登入頁會顯示「用公司 Microsoft 帳號登入」。
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">
              還缺下面 {status.missing.length} 個值。這幾個值目前只能由 IT
              填進部署平台的環境變數(填完服務會重啟),因為其中的用戶端密碼不適合存進資料庫。
            </p>
            <ul className="space-y-2">
              {status.missing.map((m) => (
                <li key={m.key} className="card-compact">
                  <p className="text-sm font-semibold">
                    <code>{m.key}</code> — {m.label}
                  </p>
                  <p className="page-subtle mt-1">{m.hint}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <dl className="text-sm">
          <div className="meta-row flex justify-between gap-4">
            <dt>
              目錄(租用戶)識別碼{' '}
              <abbr tabIndex={0} title="Tenant ID:貴公司在 Microsoft 雲端的唯一識別碼">
                Tenant ID
              </abbr>
            </dt>
            <dd className="font-mono">{status.tenantId ?? '未設定'}</dd>
          </div>
          <div className="meta-row flex justify-between gap-4">
            <dt>應用程式(用戶端)識別碼</dt>
            <dd className="font-mono">{status.clientId ?? '未設定'}</dd>
          </div>
          <div className="meta-row flex justify-between gap-4">
            <dt>用戶端密碼</dt>
            <dd>{status.hasClientSecret ? '已設定(內容不顯示)' : '未設定'}</dd>
          </div>
          <div className="meta-row flex justify-between gap-4">
            <dt>登入完成後導回</dt>
            <dd className="font-mono">
              {status.postLoginUrl ?? '未設定(改用 CORS_ORIGIN 第一個網址)'}
            </dd>
          </div>
        </dl>
      </section>

      {/* ── 重新導向 URI ──────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-redirect-h">
        <h2 id="sso-redirect-h" className="page-h2">
          要填進 Entra 的重新導向 URI
        </h2>
        <p className="page-subtle max-w-[70ch]">
          在 Entra 系統管理中心 → 應用程式註冊 → 驗證 → 平台「Web」的「重新導向 URI」填下面這個值。
          必須<strong>一字不差</strong>,結尾不要多斜線。這個值填錯是整套 SSO 最常見的失敗原因,
          症狀是登入最後一步出現 <code>AADSTS50011</code>。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="input font-mono break-all" style={{ width: 'auto', flex: '1 1 24rem' }}>
            {status.redirectUri ?? '(尚未設定 ENTRA_REDIRECT_URI)'}
          </code>
          <button
            type="button"
            onClick={() => void copyRedirectUri()}
            disabled={!status.redirectUri}
            className="btn min-h-[44px] px-4"
          >
            複製網址
          </button>
        </div>
        <p role="status" aria-live="polite" className="page-subtle">
          {copied ? '已複製到剪貼簿' : ''}
        </p>
      </section>

      {/* ── 檢查設定 ─────────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-check-h">
        <h2 id="sso-check-h" className="page-h2">
          檢查設定
        </h2>
        <p className="page-subtle max-w-[70ch]">
          按下去會實際連線到 Microsoft 的
          <abbr
            tabIndex={0}
            title="OpenID Connect Discovery:公開的設定描述檔,任何人都能讀,不需要密碼"
          >
            OpenID 探索端點
          </abbr>
          ,確認兩件事:租用戶識別碼填的是存在的租用戶、而且這台後端連得到 Microsoft。這個檢查
          <strong>不會</strong>送出用戶端密碼。
        </p>
        <button
          type="button"
          onClick={() => void onCheck()}
          disabled={checking}
          className="btn btn-primary min-h-[44px] px-5"
        >
          {checking ? '檢查中...' : '檢查設定'}
        </button>

        <div aria-live="polite">
          {checkResult ? (
            <div
              className={`flash ${checkResult.ok ? 'flash-success' : 'flash-error'} space-y-1`}
              role={checkResult.ok ? 'status' : 'alert'}
            >
              <p className="font-semibold">{checkResult.ok ? '檢查通過' : '檢查未通過'}</p>
              <p>{checkResult.message}</p>
              {checkResult.checkedUrl ? (
                <p className="break-all font-mono text-xs">檢查的網址:{checkResult.checkedUrl}</p>
              ) : null}
              {checkResult.issuer ? (
                <p className="break-all font-mono text-xs">issuer:{checkResult.issuer}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className="page-subtle max-w-[70ch]">
          檢查通過不代表全部設定都對:用戶端識別碼、用戶端密碼、重新導向 URI
          這三個要到實際有人按下登入時才驗得到。真的要確認,請自己登出後用 Microsoft 帳號登入一次,
          再回來看下面的登入紀錄。
        </p>
      </section>

      {/* ── 允許登入的網域 ─────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-domains-h">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="sso-domains-h" className="page-h2">
            允許登入的網域
          </h2>
          <span className="badge badge-muted">
            目前來源:{SOURCE_LABEL[status.allowedDomainsSource] ?? status.allowedDomainsSource}
          </span>
        </div>
        <p className="page-subtle max-w-[70ch]">
          只有這些網域的信箱可以用 Microsoft 登入。在這裡存檔會寫進資料庫並立刻生效,
          不需要改環境變數、不需要重啟服務。環境變數 <code>ENTRA_ALLOWED_DOMAINS</code>{' '}
          只在這裡從來沒設定過時才會被拿來用
          {status.envAllowedDomains.length > 0
            ? `(環境變數目前是:${status.envAllowedDomains.join('、')})`
            : '(環境變數目前是空的)'}
          。
        </p>

        {willBeUnrestricted ? (
          <p role="alert" className="flash flash-warning max-w-[70ch]">
            <strong>注意:清單是空的,等於不限網域。</strong> 任何屬於本公司 Microsoft
            租用戶的帳號都能通過網域檢查,能不能進來只剩「這個信箱在使用者管理裡存不存在」
            這一道關卡。如果同時把下面的自動建立帳號打開,等於公司目錄裡的每個人都能自己開一個看得到客戶聯絡資料與到訪紀錄的帳號。
          </p>
        ) : null}

        <ul className="space-y-2">
          {rows.map((row, idx) => {
            const inputId = `sso-domain-${row.id}`;
            const subId = `sso-domain-sub-${row.id}`;
            return (
              <li key={row.id} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[16rem] flex-1">
                  <label htmlFor={inputId} className="field-label">
                    網域 {idx + 1}
                  </label>
                  <input
                    id={inputId}
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="example.com"
                    aria-describedby={`${inputId}-help`}
                    value={row.value}
                    onChange={(e) => updateRow(row.id, { value: e.target.value })}
                    className="input min-h-[44px] font-mono"
                  />
                  <p id={`${inputId}-help`} className="page-subtle mt-1">
                    只填網域,不含 @。例:<code>example.com</code>
                  </p>
                </div>
                <label
                  htmlFor={subId}
                  className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-background px-3 text-sm"
                >
                  <input
                    id={subId}
                    type="checkbox"
                    checked={row.includeSub}
                    onChange={(e) => updateRow(row.id, { includeSub: e.target.checked })}
                    className="h-[18px] w-[18px] shrink-0"
                  />
                  <span>含子網域</span>
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  className="btn btn-danger min-h-[44px] px-4"
                >
                  刪除<span className="sr-only">網域 {row.value || idx + 1}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <button type="button" onClick={addRow} className="btn min-h-[44px] px-4">
          新增網域
        </button>

        <p className="page-subtle max-w-[70ch]">
          「含子網域」沒勾的話,允許 <code>example.com</code> 不會連帶允許{' '}
          <code>tw.example.com</code>。這是刻意的:子網域可能是子公司或測試租用戶,
          不該自動繼承進入本系統的權限。勾了才會放行,設定值會存成 <code>*.example.com</code>。
        </p>
      </section>

      {/* ── 自動建立帳號 ──────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-provision-h">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="sso-provision-h" className="page-h2">
            自動建立帳號
          </h2>
          <span className="badge badge-muted">
            目前來源:{SOURCE_LABEL[status.autoProvisionSource] ?? status.autoProvisionSource}
          </span>
        </div>
        <label
          htmlFor="sso-auto-provision"
          className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-background px-3 py-3 text-sm"
        >
          <input
            id="sso-auto-provision"
            type="checkbox"
            checked={autoProvision}
            aria-describedby="sso-auto-provision-help"
            onChange={(e) => setAutoProvision(e.target.checked)}
            className="mt-0.5 h-[18px] w-[18px] shrink-0"
          />
          <span className="font-semibold">AD 有這個人就自動開帳號(角色一律為「業務」)</span>
        </label>
        <p id="sso-auto-provision-help" className="page-subtle max-w-[70ch]">
          <strong>預設關閉,而且建議維持關閉。</strong>{' '}
          公司目錄裡的人不等於可以看客戶聯絡資料與到訪紀錄的人。
          誰能進這個後台應該是由人決定,不是由是不是公司員工決定。關閉時,
          同仁必須先由系統管理員在「使用者管理」建好帳號(email 填他的 Microsoft 信箱),才能用
          Microsoft 登入;比對不到會看到「還沒有本系統的使用權限」。
        </p>

        {/*
          預設歸屬。這一段不是選配的裝飾:訪查主管看得到誰,是由所屬主管與所屬部門
          兩欄算出來的(後端 scope/view-scope.ts)。自動建的帳號兩欄都空著的話,
          那個人能正常打卡建客戶,但他的主管在看板、戰情、日報、地圖上一筆都看不到,
          而且畫面上沒有任何提示。邀請連結那條路徑會繼承邀請人的部門,這裡是等價的東西。
        */}
        <fieldset className="space-y-4 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">自動建立帳號時的組織歸屬</legend>
          <p className="page-subtle max-w-[70ch]">
            訪查主管看得到誰,是由「所屬主管」與「所屬部門」兩欄決定的。這兩格留空的話,
            自動建出來的帳號對所有主管都是隱形的:他照樣能打卡建客戶,但主管在看板、戰情、
            日報與地圖上一筆都看不到。先在這裡指定,之後仍可在使用者管理逐一調整。
          </p>

          <label className="block" htmlFor="sso-default-department">
            <span className="mb-1 block text-sm font-medium">預設部門</span>
            <select
              id="sso-default-department"
              className="input min-h-[44px]"
              value={defaultDepartmentId}
              onChange={(e) => setDefaultDepartmentId(e.target.value)}
            >
              <option value="">不指定</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {departmentPathLabel(departments, d.id)}
                </option>
              ))}
            </select>
            {departments.length === 0 ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                目前沒有可以選的部門。部門在{' '}
                <Link href="/admin/settings?tab=departments" className="underline">
                  系統設定的組織部門
                </Link>{' '}
                維護
              </span>
            ) : null}
            {status.defaultDepartmentId && !status.defaultDepartmentName ? (
              <span className="mt-1 block text-xs text-destructive">
                目前存著的部門已經不存在(可能被刪掉了),請重新選一個或改成不指定
              </span>
            ) : null}
          </label>

          <label className="block" htmlFor="sso-default-manager">
            <span className="mb-1 block text-sm font-medium">預設主管</span>
            <select
              id="sso-default-manager"
              className="input min-h-[44px]"
              value={defaultManagerId}
              onChange={(e) => setDefaultManagerId(e.target.value)}
            >
              <option value="">不指定</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            {users.length === 0 ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                目前沒有可以指定的帳號,請先在使用者管理建立一個
              </span>
            ) : null}
            {status.defaultManagerId && !status.defaultManagerName ? (
              <span className="mt-1 block text-xs text-destructive">
                目前存著的主管已經不存在或已停用,請重新選一位或改成不指定
              </span>
            ) : null}
          </label>
        </fieldset>
      </section>

      {/* ── 組織資料同步 ──────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-graph-h">
        <h2 id="sso-graph-h" className="page-h2">
          從 Microsoft 365 帶入組織資料
        </h2>
        <p className="page-subtle max-w-[70ch]">
          每次用 Microsoft 登入時,系統會讀取該帳號在公司通訊錄上的職稱、部門、辦公室、
          公司電話與手機,寫回這個人的資料。組織異動後下一次登入就會自動更新。讀取失敗(Microsoft
          服務異常或權限被撤)不會影響登入,只是那一次不同步。這一段用的是預設就有的{' '}
          <code>User.Read</code> 權限,不需要系統管理員額外同意。角色永遠不會被 Microsoft
          那邊的職稱蓋掉,誰是系統管理員仍然只由這個後台決定。
        </p>
        <label
          htmlFor="sso-sync-manager"
          className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-background px-3 py-3 text-sm"
        >
          <input
            id="sso-sync-manager"
            type="checkbox"
            checked={syncManager}
            aria-describedby="sso-sync-manager-help"
            onChange={(e) => setSyncManager(e.target.checked)}
            className="mt-0.5 h-[18px] w-[18px] shrink-0"
          />
          <span className="font-semibold">一併同步「主管」(需要系統管理員同意額外權限)</span>
        </label>
        <p id="sso-sync-manager-help" className="page-subtle max-w-[70ch]">
          <strong>預設關閉。</strong> 讀主管要 <code>User.Read.All</code>,那是租用戶層級、
          可以讀全公司所有人資料的權限,必須由 Microsoft 365 的系統管理員在 「API
          權限」頁按「代表組織授與管理員同意」。沒有同意就打開也不會壞:
          登入照常,只是主管欄位一直是空的。
        </p>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onSaveClick}
          disabled={saving}
          className="btn btn-primary min-h-[44px] px-6"
        >
          {saving ? '儲存中...' : '儲存單一登入設定'}
        </button>
      </div>

      {/* ── 登入紀錄 ─────────────────────────────── */}
      <section className="card space-y-3" aria-labelledby="sso-logs-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sso-logs-h" className="page-h2">
            最近的 Microsoft 登入紀錄
          </h2>
          <button
            type="button"
            onClick={() => void loadLogs()}
            disabled={logsLoading}
            className="btn btn-sm min-h-[44px] px-4"
          >
            {logsLoading ? '載入中...' : '重新整理'}
          </button>
        </div>
        <p className="page-subtle max-w-[70ch]">
          成功與失敗都會留一筆。使用者回報「登不進去」時先看這裡的失敗原因,
          多半一眼就知道是網域沒加、還是帳號沒建。
        </p>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {logsLoading ? '載入中...' : '目前沒有任何 Microsoft 登入紀錄'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-compact">
              <caption className="sr-only">最近 50 筆 Microsoft 單一登入紀錄</caption>
              <thead>
                <tr>
                  <th scope="col">時間</th>
                  <th scope="col">結果</th>
                  <th scope="col">帳號</th>
                  <th scope="col">失敗原因</th>
                  <th scope="col">來源 IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap">{fmtTime(row.createdAt)}</td>
                    <td>
                      <span
                        className={`badge ${row.result === 'success' ? 'badge-success' : 'badge-danger'}`}
                      >
                        {row.result === 'success' ? '成功' : '拒絕'}
                      </span>
                    </td>
                    <td className="break-all font-mono text-xs">{row.email ?? '(取不到)'}</td>
                    <td>
                      {row.reasonLabel ?? (row.result === 'success' ? '' : (row.reason ?? ''))}
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs">{row.ip ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 儲存前的確認步驟(WCAG 3.3.4:有後果的變更要能先確認或修改)── */}
      {confirmOpen ? (
        <div className="modal-overlay">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sso-confirm-h"
            className="modal-panel max-w-xl space-y-3"
          >
            <h2 id="sso-confirm-h" className="page-h2">
              這次變更會放寬登入限制,請再確認一次
            </h2>
            <ul className="space-y-2 text-sm">
              {willBeUnrestricted ? (
                <li className="flash flash-warning">
                  允許網域清單留空就是<strong>不限網域</strong>。
                  只要帳號存在於本系統,任何通過公司租用戶驗證的信箱都能登入。
                </li>
              ) : null}
              {willEnableAutoProvision ? (
                <li className="flash flash-warning">
                  打開<strong>自動建立帳號</strong>之後,公司目錄裡沒被建過帳號的人,第一次用
                  Microsoft 登入就會自動取得「訪查人員」權限,看得到客戶的聯絡資料與到訪紀錄。
                </li>
              ) : null}
            </ul>
            <p className="page-subtle">確定要這樣存嗎?按「返回修改」不會有任何變更。</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                ref={confirmCancelRef}
                onClick={() => setConfirmOpen(false)}
                className="btn min-h-[44px] px-5"
              >
                返回修改
              </button>
              <button
                type="button"
                onClick={() => void doSave()}
                className="btn btn-danger min-h-[44px] px-5"
              >
                我了解,仍要儲存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
