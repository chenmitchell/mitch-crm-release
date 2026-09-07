'use client';

// 團隊管理(訪查主管 / 系統管理員):上方「邀請新成員」產一次性連結,下方自己團隊的成員清單。
// 連結只在產生當下拿得到一次(後端只存 sha256),所以畫面要能複製、能用 LINE 傳、並顯示剩餘分鐘。
// 成員操作沿用使用者管理那一頁的 API(GET/PATCH /api/admin/users),後端已按角色縮小範圍:
// 訪查主管只會拿到自己團隊的業務加自己,能停用 / 啟用 / 重設密碼的也只有那些人。
// 無障礙:狀態訊息 role="status" aria-live、錯誤 role="alert"、按鈕 ≥44px、狀態不只靠顏色(有文字)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage, redirectToLogin } from '@/lib/api-error';
import { roleLabel, type UserRole } from '@/lib/roles';
import { useOrgTimeFormat } from '@/lib/app-settings';

const LINE_MSG_URL = 'https://line.me/R/msg/text/?';

interface MemberRow {
  id: string;
  email: string;
  name: string;
  mobile?: string | null;
  phone?: string | null;
  role: UserRole;
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  managerId?: string | null;
  managerName?: string | null;
}

/**
 * 一條還沒被用掉的邀請。
 *
 * createdByName / mine 是給 admin 看的:admin 看得到全公司的邀請,
 * 少了發送者姓名那份清單只是一堆時間戳,答不出「這條是誰發的」——
 * 而那正是 admin 需要看到它的理由(主管離職前發出去的連結要撤得掉)。
 * 主管自己看的時候每一條都是自己發的,那一段就不顯示。
 */
interface InviteRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  createdById?: string | null;
  createdByName?: string | null;
  mine?: boolean;
}

/**
 * 已經被用掉的邀請。usedByUserId 一直有寫進資料庫,但以前沒有任何地方讀,
 * 稽核上答不出「這張邀請是被誰用掉的」。姓名與 email 由後端一起帶出來。
 */
interface UsedInviteRow {
  id: string;
  createdAt: string;
  usedAt: string | null;
  usedByUserId: string | null;
  usedByName: string | null;
  usedByEmail: string | null;
  createdById?: string | null;
  createdByName?: string | null;
  mine?: boolean;
}

type Flash = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null;

/** 還剩幾分鐘(不足一分鐘顯示「不到 1 分鐘」,已過顯示 0) */
function minutesLeft(expiresAt: string, nowMs: number): number {
  const diff = new Date(expiresAt).getTime() - nowMs;
  return diff <= 0 ? 0 : Math.ceil(diff / 60000);
}

export default function AdminTeamPage() {
  // 時間一律照組織設定的時區顯示,不吃看的人的裝置時區與語系
  const fmtTime = useOrgTimeFormat();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [usedInvites, setUsedInvites] = useState<UsedInviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 剛產出來的連結。只有這一刻拿得到明碼 token,離開畫面就沒了
  const [newInvite, setNewInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [tempPwdModal, setTempPwdModal] = useState<{ email: string; pwd: string } | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const linkRef = useRef<HTMLInputElement | null>(null);
  // 臨時密碼視窗:開啟時把焦點移進去、Esc 關閉、焦點鎖在視窗內、關閉後還給原本的按鈕
  const pwdPanelRef = useRef<HTMLDivElement | null>(null);
  const pwdCopyRef = useRef<HTMLButtonElement | null>(null);
  const pwdOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  // 倒數用的時鐘。每 30 秒跳一次就夠(顯示單位是分鐘)
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!tempPwdModal) return;
    // 開啟時焦點移到「複製密碼」;關閉後還回原本按下「重設密碼」的那個按鈕
    const opener = pwdOpenerRef.current;
    pwdCopyRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTempPwdModal(null);
        return;
      }
      if (e.key !== 'Tab') return;
      // 焦點鎖:視窗只有幾個可聚焦元素,Tab 到底就繞回第一個(反向亦然)
      const panel = pwdPanelRef.current;
      if (!panel) return;
      const items = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [tempPwdModal]);

  const load = useCallback(async () => {
    try {
      const [uRes, iRes] = await Promise.all([
        fetch(`${getApiBase()}/api/admin/users`, { credentials: 'include' }),
        fetch(`${getApiBase()}/api/admin/crm-invites`, { credentials: 'include' }),
      ]);
      if (uRes.status === 401) {
        // 401 全站同一套處理(見 lib/api-error):導回登入頁並帶上 next
        redirectToLogin();
        return;
      }
      if (uRes.status === 403) {
        setError('你沒有權限管理團隊(僅訪查主管與系統管理員)');
        setLoading(false);
        return;
      }
      if (!uRes.ok) {
        setError(await apiErrorMessage(uRes, `載入團隊成員失敗(${uRes.status})`));
        setLoading(false);
        return;
      }
      const uData = (await uRes.json()) as { users?: MemberRow[] };
      setMembers(uData.users ?? []);
      if (iRes.ok) {
        const iData = (await iRes.json()) as {
          invites?: InviteRow[];
          usedInvites?: UsedInviteRow[];
        };
        setInvites(iData.invites ?? []);
        setUsedInvites(iData.usedInvites ?? []);
      }
      setLoading(false);
    } catch {
      // 跟同檔其他分支一致給通用訊息:fetch / JSON 解析的原始錯誤字串對使用者沒有意義,
      // 也可能帶出後端網址之類的內部資訊
      setError('載入團隊資料失敗,請稍後再試');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreateInvite() {
    setCreating(true);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/crm-invites`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, '產生邀請連結失敗,請稍後再試'),
        });
        return;
      }
      const data = (await res.json()) as { url?: string; expiresAt?: string };
      if (!data.url || !data.expiresAt) {
        setFlash({ kind: 'error', text: '產生邀請連結失敗,請稍後再試' });
        return;
      }
      setNewInvite({ url: data.url, expiresAt: data.expiresAt });
      setNowMs(Date.now());
      setFlash({ kind: 'success', text: '邀請連結已產生,請在有效時間內傳給對方' });
      void load();
    } catch {
      // 網路斷線 / fetch 直接丟例外:沒有這段的話畫面只會停在「產生中...」,使用者不知道發生什麼事
      setFlash({ kind: 'error', text: '連線失敗,請確認網路後再試一次' });
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    if (!confirm('確定要撤銷這條邀請連結?撤銷後對方就打不開了')) return;
    setBusyId(id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/crm-invites/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        setFlash({ kind: 'error', text: await apiErrorMessage(res, '撤銷失敗,請稍後再試') });
        return;
      }
      setFlash({ kind: 'success', text: '已撤銷這條邀請連結' });
      setNewInvite(null);
      void load();
    } catch {
      setFlash({ kind: 'error', text: '連線失敗,請確認網路後再試一次' });
    } finally {
      setBusyId(null);
    }
  }

  async function onCopyLink() {
    if (!newInvite) return;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(newInvite.url);
      setFlash({ kind: 'success', text: '已複製邀請連結' });
    } catch {
      linkRef.current?.select();
      setFlash({ kind: 'error', text: '複製失敗,請手動選取上面的連結複製' });
    }
  }

  async function onShare() {
    if (!newInvite) return;
    const text = `邀請你加入訪查團隊,請在 30 分鐘內用這個連結建立帳號:${newInvite.url}`;
    if (canShare) {
      try {
        await navigator.share({ title: '訪查人員帳號邀請', text });
        setFlash({ kind: 'success', text: '已開啟分享面板' });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    window.open(`${LINE_MSG_URL}${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  }

  async function onResetPassword(m: MemberRow, opener?: HTMLElement | null) {
    if (!confirm(`確定要重設「${m.name}」的密碼?舊密碼會失效,系統會產一組新的臨時密碼`)) return;
    pwdOpenerRef.current = opener ?? null;
    setBusyId(m.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${m.id}/reset-password`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setFlash({ kind: 'error', text: await apiErrorMessage(res, '重設密碼失敗,請稍後再試') });
        return;
      }
      const data = (await res.json()) as { tempPassword?: string };
      setTempPwdModal({ email: m.email, pwd: data.tempPassword ?? '?' });
    } catch {
      setFlash({ kind: 'error', text: '連線失敗,請確認網路後再試一次' });
    } finally {
      setBusyId(null);
    }
  }

  async function onToggleStatus(m: MemberRow) {
    const action = m.status === 'active' ? 'disable' : 'enable';
    const verb = action === 'disable' ? '停用' : '啟用';
    if (!confirm(`確定要${verb}「${m.name}」?`)) return;
    setBusyId(m.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${m.id}/${action}`, {
        method: 'PATCH',
        credentials: 'include',
      });
      if (!res.ok) {
        setFlash({ kind: 'error', text: await apiErrorMessage(res, `${verb}失敗,請稍後再試`) });
        return;
      }
      setFlash({ kind: 'success', text: `已${verb} ${m.name}` });
      void load();
    } catch {
      setFlash({ kind: 'error', text: '連線失敗,請確認網路後再試一次' });
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p className="text-muted-foreground">載入中...</p>;
  if (error) {
    return (
      <article className="space-y-3">
        <p role="alert" className="flash flash-error">
          {error}
        </p>
        <Link href="/admin" className="underline">
          返回後台
        </Link>
      </article>
    );
  }

  const inviteMinutes = newInvite ? minutesLeft(newInvite.expiresAt, nowMs) : 0;

  return (
    <article className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            <Link href="/admin" className="underline">
              後台
            </Link>{' '}
            / 團隊管理
          </p>
          <h1>團隊成員</h1>
          <p className="text-sm text-muted-foreground">
            邀請新成員加入你的團隊,並管理成員帳號。目前共 {members.length} 人
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateInvite}
          disabled={creating}
          aria-busy={creating || undefined}
          className="btn btn-primary min-h-[44px]"
        >
          {creating ? '產生中...' : '邀請新成員'}
        </button>
      </header>

      {flash ? (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`flash ${flash.kind === 'success' ? 'flash-success' : 'flash-error'}`}
        >
          {flash.kind === 'error' ? `操作失敗:${flash.text}` : flash.text}
        </p>
      ) : null}

      {newInvite ? (
        <section className="card space-y-3" aria-label="剛產生的邀請連結">
          <h2 className="page-h2">邀請連結已產生</h2>
          <p className="text-sm text-muted-foreground">
            這個連結只會顯示這一次,關掉就看不到了。對方打開後自己設密碼,建好的帳號會直接掛在你底下。
          </p>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">邀請連結</span>
            <input
              ref={linkRef}
              type="text"
              readOnly
              value={newInvite.url}
              className="input font-mono text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p role="status" aria-live="polite" className="text-sm text-foreground">
            {inviteMinutes > 0
              ? `有效時間剩下約 ${inviteMinutes} 分鐘`
              : '這個連結已經過期,請重新產生'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onCopyLink} className="btn btn-primary min-h-[44px]">
              複製連結
            </button>
            <button type="button" onClick={onShare} className="btn min-h-[44px]">
              用 LINE 傳送<span className="sr-only">(開新視窗)</span>
            </button>
            <button type="button" onClick={() => setNewInvite(null)} className="btn min-h-[44px]">
              我已傳出,收起
            </button>
          </div>
        </section>
      ) : null}

      <section aria-label="尚未使用的邀請連結" className="card space-y-2">
        <h2 className="page-h2">尚未使用的邀請({invites.length})</h2>
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            目前沒有還在有效期內、未被使用的邀請連結。
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {invites.map((iv) => (
              <li key={iv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm">
                  {fmtTime(iv.createdAt)} 產生,剩下約 {minutesLeft(iv.expiresAt, nowMs)} 分鐘
                  {iv.mine === false && iv.createdByName ? `,由 ${iv.createdByName} 發出` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => onRevoke(iv.id)}
                  disabled={busyId === iv.id}
                  className="btn btn-sm btn-danger min-h-[44px]"
                >
                  撤銷
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          連結有效 30 分鐘、只能用一次,同一個人一小時最多產 10
          條。連結內容不會留在系統裡,產生後請立刻傳出。
          系統管理員看得到並撤銷得了所有人發出的連結;訪查主管只看得到自己發的。
        </p>
      </section>

      {/*
        已使用的邀請。存在的理由是稽核:發生爭議時(某個帳號是怎麼進來的),
        後台要答得出「這張邀請被誰用掉」,而不是只剩資料庫可以查。
      */}
      <section aria-label="最近被使用的邀請連結" className="card space-y-2">
        <h2 className="page-h2">最近 30 天被使用的邀請({usedInvites.length})</h2>
        {usedInvites.length === 0 ? (
          <p className="text-sm text-muted-foreground">最近 30 天沒有邀請連結被使用。</p>
        ) : (
          <ul className="divide-y divide-border">
            {usedInvites.map((iv) => (
              <li key={iv.id} className="py-2 text-sm">
                <div>
                  {iv.usedAt ? fmtTime(iv.usedAt) : '時間不詳'} 由 {iv.usedByName ?? '(帳號已刪除)'}
                  {iv.usedByEmail ? ` (${iv.usedByEmail})` : ''} 使用
                </div>
                <div className="text-xs text-muted-foreground">
                  這條連結產生於 {fmtTime(iv.createdAt)}
                  {iv.mine === false && iv.createdByName ? `,由 ${iv.createdByName} 發出` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="團隊成員"
        className="overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">姓名 / Email</th>
              <th className="hidden px-4 py-3 md:table-cell">手機</th>
              <th className="px-4 py-3">狀態</th>
              <th className="hidden px-4 py-3 lg:table-cell">最後登入</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => (
              <tr key={m.id} className="transition-colors hover:bg-muted/50">
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {m.name} <span className="badge badge-muted">{roleLabel(m.role)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{m.email}</div>
                  {m.managerName ? (
                    <div className="text-[10px] text-muted-foreground">主管 {m.managerName}</div>
                  ) : null}
                  {m.mustChangePassword ? (
                    <div className="badge badge-warning mt-1">尚未改過密碼</div>
                  ) : null}
                </td>
                <td className="hidden px-4 py-3 md:table-cell text-muted-foreground">
                  {m.mobile ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`badge ${m.status === 'active' ? 'badge-success' : 'badge-danger'}`}
                  >
                    {m.status === 'active' ? '啟用中' : '已停用'}
                  </span>
                </td>
                <td className="hidden px-4 py-3 lg:table-cell text-xs text-muted-foreground">
                  {m.lastLoginAt ? fmtTime(m.lastLoginAt) : '從未登入'}
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={(e) => onResetPassword(m, e.currentTarget)}
                    disabled={busyId === m.id}
                    className="btn btn-xs min-h-[44px]"
                  >
                    重設密碼
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleStatus(m)}
                    disabled={busyId === m.id}
                    className={`btn btn-xs min-h-[44px] ${m.status === 'active' ? 'btn-danger' : 'btn-success'}`}
                  >
                    {m.status === 'active' ? '停用' : '啟用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {tempPwdModal ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="team-temp-pwd-title"
          className="modal-overlay"
        >
          <button
            type="button"
            aria-label="關閉視窗"
            onClick={() => setTempPwdModal(null)}
            className="absolute inset-0 cursor-default bg-transparent"
          />
          <div ref={pwdPanelRef} role="document" className="modal-panel max-w-md">
            <h2 id="team-temp-pwd-title" className="page-h2 mb-3">
              臨時密碼產生完成
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              請複製給「<strong className="text-foreground">{tempPwdModal.email}</strong>」
              此密碼只會顯示一次,關閉視窗後就看不到了
            </p>
            <div className="mb-4 rounded-md border border-border-strong bg-muted p-3 font-mono text-base break-all">
              {tempPwdModal.pwd}
            </div>
            <div className="flex gap-2">
              <button
                ref={pwdCopyRef}
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(tempPwdModal.pwd);
                  setFlash({ kind: 'success', text: '已複製臨時密碼' });
                }}
                className="btn btn-primary btn-sm min-h-[44px] flex-1"
              >
                複製密碼
              </button>
              <button
                type="button"
                onClick={() => setTempPwdModal(null)}
                className="btn btn-sm min-h-[44px]"
              >
                我已複製,關閉
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
