'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { roleLabel, USER_ROLE_OPTIONS, type UserRole } from '@/lib/roles';
import { useOrgTimeFormat } from '@/lib/app-settings';
import { useMe } from '@/lib/me-context';
import { apiErrorMessage, redirectToLogin } from '@/lib/api-error';
// 對話框的焦點管理全站共用同一份(見 components/a11y/modal-dialog.tsx):
// 開啟時焦點進視窗、Tab 鎖在視窗內、Escape 關得掉、背景 inert、關閉後焦點還給觸發鈕。
// 這一頁兩個視窗原本只有 aria-modal="true",一項都沒做。
import { ModalDialog, useDialogOpener } from '@/components/a11y/modal-dialog';

/**
 * 從 Microsoft 365 同步回來的組織資料。
 * 這幾個欄位不在 users 表裡(那要改 schema),存在系統設定的 M365 目錄快取,
 * 由後端在使用者清單一併帶出來。沒同步過就是 null。
 */
interface M365Info {
  department?: string | null;
  officeLocation?: string | null;
  employeeId?: string | null;
  managerName?: string | null;
  syncedAt?: string | null;
  lastFailedAt?: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  m365?: M365Info | null;
  phone?: string | null;
  mobile?: string | null;
  title?: string | null;
  extension?: string | null;
  role: UserRole;
  /** 所屬主管與所屬部門:訪查主管的可見範圍就是靠這兩欄算的(後端 scope/view-scope.ts) */
  managerId?: string | null;
  managerName?: string | null;
  departmentId?: string | null;
  departmentName?: string | null;
  status: 'active' | 'disabled';
  /** 名下還有幾位客戶(不含被查重合併掉的);後端沒回就當作不知道 */
  customerCount?: number;
  /**
   * 底下還有幾位團隊成員(managerId 指向這個人)。
   * 停用一位還有成員的主管,成員的所屬主管會指向一個停用的帳號,那個團隊就沒有主管了
   * (可見範圍是靠 managerId 展開的),而且不會有任何錯誤。所以這個數字要看得見。
   */
  memberCount?: number;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * 停用前的影響評估(GET /api/admin/users/:id/disable-impact)。
 * message 由後端寫好整句,前端不自己拼字 —— 兩邊各拼一份的話,
 * 直接打 API 的人跟走畫面的人會看到不一樣的說法。
 */
interface DisableImpact {
  customerCount: number;
  memberCount: number;
  blocked: boolean;
  blockReason: string | null;
  message: string;
}

type Flash = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null;

/** 轉派下拉的來源(GET /api/admin/crm/sales-users)。只有訪查人員與訪查主管會在裡面 */
interface SalesUser {
  id: string;
  name: string;
}

/** 組織部門(GET /api/admin/departments) */
interface DepartmentRow {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * 部門下拉的顯示名稱:上層部門用「上層 / 子部門」串起來。
 * 只有名稱的話,兩個不同上層底下同名的「業務一課」在下拉裡分不出來。
 * 有環也不會無限迴圈(走過的節點就停),理由同後端 departmentSubtreeIds。
 */
function departmentPathLabel(rows: readonly DepartmentRow[], id: string): string {
  const byId = new Map(rows.map((d) => [d.id, d]));
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

export default function AdminUsersPage() {
  // 時間一律照組織設定的時區顯示,不吃看的人的裝置時區與語系
  const fmtTime = useOrgTimeFormat();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);

  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  // 建立新使用者表單
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('sales');
  const [newTitle, setNewTitle] = useState('');
  const [newDepartment, setNewDepartment] = useState('');
  const [newMobile, setNewMobile] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newExtension, setNewExtension] = useState('');
  const [creating, setCreating] = useState(false);

  // 編輯使用者(姓名 + 業務窗口聯絡資料)
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editMobile, setEditMobile] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editExtension, setEditExtension] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('sales');
  // 所屬主管 / 所屬部門。'' 代表「不指定」,送出時轉成 null 讓後端清掉歸屬
  const [editManagerId, setEditManagerId] = useState('');
  const [editDepartmentId, setEditDepartmentId] = useState('');
  const [editing, setEditing] = useState(false);

  // 兩個下拉的資料來源。拿不到就讓下拉只剩「不指定」,不要讓整頁壞掉
  const [salesUsers, setSalesUsers] = useState<SalesUser[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);

  // 目前登入者:角色決定看不看得到「登入角色」欄位,email 用來擋改自己的角色。
  // 後端本來就會擋,這裡是不要讓人看到一個按下去一定失敗的欄位。
  // 值來自共用的登入者 context(見 lib/me-context),這一頁不再自己打 /api/auth/me。
  const { me: rawMe } = useMe();
  const me =
    rawMe?.email && rawMe.role ? { email: rawMe.email, role: rawMe.role as UserRole } : null;

  // 顯示一次性密碼的彈出層
  const [tempPwdModal, setTempPwdModal] = useState<{ email: string; password: string } | null>(
    null,
  );

  // 兩個視窗各記自己的觸發鈕,關閉後焦點還回去(不是還到 body)
  const editOpener = useDialogOpener();
  const pwdOpener = useDialogOpener();

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users`, { credentials: 'include' });
      if (res.status === 401) {
        // 401 全站同一套處理(見 lib/api-error):導回登入頁並帶上 next
        redirectToLogin();
        return;
      }
      if (res.status === 403) {
        setError('你沒有權限管理使用者(只有系統管理員可以)');
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError('載入失敗,請確認網路連線後重新整理');
        setLoading(false);
        return;
      }
      const data = await res.json();
      setUsers(data.users ?? []);
      setLoading(false);
    } catch {
      // 原始的 JS 例外(Failed to fetch 之類)不畫在畫面上,
      setError('載入失敗,請確認網路連線後重新整理');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    void loadUsers();
  }, [loadUsers]);

  /**
   * 所屬主管與所屬部門的下拉來源。
   * 這兩欄只有系統管理員送得動(後端 users.service 會擋),所以也只有系統管理員要載。
   */
  useEffect(() => {
    if (me?.role !== 'admin') return;
    let cancelled = false;
    void (async () => {
      const base = getApiBase();
      const [su, dept] = await Promise.allSettled([
        fetch(`${base}/api/admin/crm/sales-users`, { credentials: 'include' }),
        fetch(`${base}/api/admin/departments`, { credentials: 'include' }),
      ]);
      if (su.status === 'fulfilled' && su.value.ok) {
        const body = (await su.value.json()) as { rows?: SalesUser[] };
        if (!cancelled) setSalesUsers(body.rows ?? []);
      }
      if (dept.status === 'fulfilled' && dept.value.ok) {
        const body = (await dept.value.json()) as { departments?: DepartmentRow[] };
        if (!cancelled) setDepartments(body.departments ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me?.role]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.trim() || !newName.trim()) {
      setFlash({ kind: 'error', text: 'Email 跟姓名都要填' });
      return;
    }
    setCreating(true);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          name: newName.trim(),
          role: newRole,
          title: newTitle.trim() || undefined,
          department: newDepartment.trim() || undefined,
          mobile: newMobile.trim() || undefined,
          phone: newPhone.trim() || undefined,
          extension: newExtension.trim() || undefined,
        }),
      });
      if (!res.ok) {
        // 錯誤訊息一律走 lib/api-error 的規則(4xx 且含中文才原樣顯示),
        // 不在這一頁自己寫一份解析:自己寫的那一份會把 5xx 的英文錯誤貼給使用者看
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, `操作失敗(HTTP ${res.status})`),
        });
        setCreating(false);
        return;
      }
      const data = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const tempPassword = typeof data?.tempPassword === 'string' ? data.tempPassword : '?';
      setTempPwdModal({ email: newEmail.trim(), password: tempPassword });
      setFlash({ kind: 'success', text: `已建立 ${newName}(${roleLabel(newRole)})` });
      setShowCreate(false);
      setNewEmail('');
      setNewName('');
      setNewRole('sales');
      setNewTitle('');
      setNewExtension('');
      setNewMobile('');
      setNewPhone('');
      void loadUsers();
    } finally {
      setCreating(false);
    }
  }

  async function onResetPassword(u: UserRow, opener?: HTMLElement | null) {
    if (!confirm(`確定要重設「${u.name}」的密碼?舊密碼會失效,系統會產一組新的臨時密碼`)) return;
    // 觸發鈕在請求期間會變成 aria-disabled,關閉視窗後焦點要還給它,所以現在先記住
    pwdOpener.remember(opener ?? null);
    setBusyId(u.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${u.id}/reset-password`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        // 錯誤訊息一律走 lib/api-error 的規則(4xx 且含中文才原樣顯示),
        // 不在這一頁自己寫一份解析:自己寫的那一份會把 5xx 的英文錯誤貼給使用者看
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, `操作失敗(HTTP ${res.status})`),
        });
        return;
      }
      const data = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const tempPassword = typeof data?.tempPassword === 'string' ? data.tempPassword : '?';
      setTempPwdModal({ email: u.email, password: tempPassword });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 解除登入鎖定。與重設密碼同一類操作,差別在不動他的密碼 ——
   * 以前唯一的「幫他解鎖」辦法就是重設密碼,那會連帶把他用得好好的密碼換掉。
   * 鎖定本身現在是「帳號 + 來源 IP」的(後端 auth/login-attempts.service.ts),
   * 所以這一顆按下去會清掉這個帳號在所有來源的失敗計數。
   */
  async function onUnlock(u: UserRow) {
    if (!confirm(`確定要解除「${u.name}」的登入鎖定?密碼不會變動`)) return;
    setBusyId(u.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${u.id}/unlock`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, `操作失敗(HTTP ${res.status})`),
        });
        return;
      }
      setFlash({ kind: 'success', text: `已解除「${u.name}」的登入鎖定` });
      await loadUsers();
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(u: UserRow, opener?: HTMLElement | null) {
    editOpener.remember(opener ?? null);
    setEditUser(u);
    setEditRole(u.role);
    setEditName(u.name);
    setEditTitle(u.title ?? '');
    setEditMobile(u.mobile ?? '');
    setEditPhone(u.phone ?? '');
    setEditExtension(u.extension ?? '');
    setEditManagerId(u.managerId ?? '');
    setEditDepartmentId(u.departmentId ?? '');
  }

  // 只有系統管理員能改角色,而且不能改自己的(後端也擋,這裡是不要顯示按了必失敗的欄位)
  const canEditRole = me?.role === 'admin' && !!editUser && editUser.email !== me.email;
  // 組織歸屬:系統管理員可以改任何人的(含自己的部門),不像角色那樣要排除自己
  const canEditOrg = me?.role === 'admin';

  async function onSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser) return;
    setEditing(true);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${editUser.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName.trim() || undefined,
          title: editTitle.trim(),
          mobile: editMobile.trim(),
          phone: editPhone.trim(),
          extension: editExtension.trim(),
          // 角色沒變就不送,避免不必要的權限檢查與稽核紀錄
          role: canEditRole && editRole !== editUser.role ? editRole : undefined,
          // 組織歸屬同理。'' 是「不指定」,要送 null 才清得掉,送 undefined 等於不改。
          // 這兩欄決定訪查主管看得到誰,漏送的話升成主管之後看板永遠是空的。
          managerId:
            canEditOrg && editManagerId !== (editUser.managerId ?? '')
              ? editManagerId || null
              : undefined,
          departmentId:
            canEditOrg && editDepartmentId !== (editUser.departmentId ?? '')
              ? editDepartmentId || null
              : undefined,
        }),
      });
      if (!res.ok) {
        // 錯誤訊息一律走 lib/api-error 的規則(4xx 且含中文才原樣顯示),
        // 不在這一頁自己寫一份解析:自己寫的那一份會把 5xx 的英文錯誤貼給使用者看
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, `操作失敗(HTTP ${res.status})`),
        });
        return;
      }
      setFlash({ kind: 'success', text: `已更新 ${editName.trim()}` });
      setEditUser(null);
      void loadUsers();
    } finally {
      setEditing(false);
    }
  }

  /**
   * 停用前的影響評估。讀不到就回 null,呼叫端會退回清單上的數字。
   * 這一支只讀不寫,失敗不該讓停用本身做不下去。
   */
  async function fetchDisableImpact(userId: string): Promise<DisableImpact | null> {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${userId}/disable-impact`, {
        credentials: 'include',
      });
      if (!res.ok) return null;
      return (await res.json()) as DisableImpact;
    } catch {
      return null;
    }
  }

  async function onToggleStatus(u: UserRow) {
    const action = u.status === 'active' ? 'disable' : 'enable';
    const verb = action === 'disable' ? '停用' : '啟用';
    /*
     * 這套系統沒有刪除使用者,停用就是離職流程本身。而停用不會把任何東西帶走:
     * 客戶還留在他名下、還會逾期(戰情圖表把該列標成「已停用」繼續算),
     * 團隊成員的所屬主管還指向這個停用的帳號,那個團隊安靜地沒有主管。
     * 所以按下去之前要先講清楚有多少東西需要人工改派。
     *
     * 數字改成按下去當下向後端問(GET :id/disable-impact),不是只用清單載入時
     * 那一份:清單可能已經放了一段時間,而「他名下還有幾位客戶」正是那段時間裡
     * 最會變的東西。問不到就退回清單上的數字,不要因為一個附加說明而讓停用做不了。
     */
    let note = '';
    if (action === 'disable') {
      const impact = await fetchDisableImpact(u.id);
      if (impact?.message) {
        note = `\n\n${impact.message}`;
      } else {
        const owned = typeof u.customerCount === 'number' ? u.customerCount : 0;
        const members = typeof u.memberCount === 'number' ? u.memberCount : 0;
        const parts: string[] = [];
        if (owned > 0) parts.push(`名下還有 ${owned} 位客戶`);
        if (members > 0) parts.push(`底下還有 ${members} 位團隊成員`);
        if (parts.length) {
          note = `\n\n他${parts.join(',')}。停用不會自動改派,請記得逐一改派負責人與所屬主管。`;
        }
      }
    }
    if (!confirm(`確定要${verb}「${u.name}」?${note}`)) return;
    setBusyId(u.id);
    setFlash(null);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/users/${u.id}/${action}`, {
        method: 'PATCH',
        credentials: 'include',
      });
      if (!res.ok) {
        // 錯誤訊息一律走 lib/api-error 的規則(4xx 且含中文才原樣顯示),
        // 不在這一頁自己寫一份解析:自己寫的那一份會把 5xx 的英文錯誤貼給使用者看
        setFlash({
          kind: 'error',
          text: await apiErrorMessage(res, `操作失敗(HTTP ${res.status})`),
        });
        return;
      }
      setFlash({ kind: 'success', text: `已${verb} ${u.name}` });
      void loadUsers();
    } finally {
      setBusyId(null);
    }
  }

  function copyTempPwd() {
    if (!tempPwdModal) return;
    void navigator.clipboard.writeText(tempPwdModal.password);
    setFlash({ kind: 'success', text: '已複製臨時密碼' });
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

  return (
    <article className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            <Link href="/admin" className="underline">
              後台
            </Link>{' '}
            / 使用者管理
          </p>
          <h1>使用者管理</h1>
          <p className="text-sm text-muted-foreground">
            管理可登入後台的訪查人員與系統管理員帳號。目前共 {users.length} 個使用者
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCreate(!showCreate);
            setFlash(null);
          }}
          className="btn btn-primary"
        >
          {showCreate ? '取消' : '+ 新增使用者'}
        </button>
      </header>

      {flash ? (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          className={`flash ${flash.kind === 'success' ? 'flash-success' : 'flash-error'}`}
        >
          {flash.text}
        </p>
      ) : null}

      {showCreate ? (
        <section className="card">
          <h2 className="page-h2 mb-4">新增使用者</h2>
          <form onSubmit={onCreate} className="grid gap-4 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Email</span>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                required
                disabled={creating}
                className="input"
                placeholder="someone@example.com"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">姓名</span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                maxLength={100}
                disabled={creating}
                className="input"
                placeholder="王小明"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">角色</span>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as UserRole)}
                disabled={creating}
                className="input"
              >
                {USER_ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}({o.hint})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">職稱(選填)</span>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                maxLength={40}
                disabled={creating}
                placeholder="例:區域主管"
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">部門文字(選填,顯示於浮水印)</span>
              <span className="mb-1 block text-xs text-muted-foreground">
                這一格只是顯示用的自由文字,不影響權限。決定主管看得到誰的是下面編輯視窗裡的
                「所屬部門」,那一格選的是組織部門主檔裡的一筆。
              </span>
              <input
                type="text"
                value={newDepartment}
                onChange={(e) => setNewDepartment(e.target.value)}
                maxLength={100}
                disabled={creating}
                placeholder="例:北區訪查部"
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">
                手機(選填,會顯示為對外聯絡方式)
              </span>
              <input
                type="tel"
                value={newMobile}
                onChange={(e) => setNewMobile(e.target.value)}
                maxLength={40}
                disabled={creating}
                placeholder="0928-xxx-xxx"
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">公司電話(選填)</span>
              <input
                type="tel"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                maxLength={40}
                disabled={creating}
                placeholder="02-1234-5678"
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">分機(選填)</span>
              <input
                type="text"
                value={newExtension}
                onChange={(e) => setNewExtension(e.target.value)}
                maxLength={20}
                disabled={creating}
                placeholder="123"
                className="input"
              />
            </label>
            <div className="md:col-span-3 flex gap-2">
              <button type="submit" disabled={creating} className="btn btn-primary btn-sm">
                {creating ? '建立中...' : '建立帳號'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="btn btn-sm"
              >
                取消
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section
        aria-label="使用者列表"
        className="overflow-x-auto rounded-lg border border-border bg-surface"
      >
        <table className="min-w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">姓名 / Email</th>
              <th className="px-4 py-3">角色</th>
              <th className="hidden px-4 py-3 md:table-cell">狀態</th>
              <th className="hidden px-4 py-3 lg:table-cell">最後登入</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u) => (
              <tr key={u.id} className="transition-colors hover:bg-muted/50">
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {u.name}
                    {u.title ? ` · ${u.title}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                  {u.mobile || u.phone ? (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {u.mobile ? `手機 ${u.mobile}` : ''}
                      {u.mobile && u.phone ? ' · ' : ''}
                      {u.phone ? `電話 ${u.phone}${u.extension ? ` 分機 ${u.extension}` : ''}` : ''}
                    </div>
                  ) : null}
                  {u.m365 && (u.m365.department || u.m365.officeLocation || u.m365.managerName) ? (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      M365:
                      {u.m365.department ? ` ${u.m365.department}` : ''}
                      {u.m365.officeLocation ? ` · ${u.m365.officeLocation}` : ''}
                      {u.m365.managerName ? ` · 主管 ${u.m365.managerName}` : ''}
                    </div>
                  ) : null}
                  {u.managerName || u.departmentName ? (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {u.departmentName ? `部門 ${u.departmentName}` : ''}
                      {u.departmentName && u.managerName ? ' · ' : ''}
                      {u.managerName ? `主管 ${u.managerName}` : ''}
                    </div>
                  ) : (
                    // 兩欄都空 = 這個帳號對所有主管都是隱形的(後端 scope/view-scope.ts
                    // 就是靠這兩欄展開可見範圍)。用 Microsoft 自動建的帳號最容易落在這裡。
                    // 寫成一句話而不是只給一個顏色:顏色不是唯一的資訊來源。
                    <div className="badge badge-warning mt-1">
                      未歸屬:沒有部門也沒有主管,主管看不到這個人的客戶與拜訪
                    </div>
                  )}
                  {u.mustChangePassword ? (
                    <div className="badge badge-warning mt-1">首次登入未改密碼</div>
                  ) : null}
                  {/*
                    停用的帳號名下還留著東西 = 那些客戶沒有人在看、那個團隊沒有主管。
                    停用本身刻意不擋(離職是既成事實),所以未完成的交接只剩這裡看得出來。
                    寫成一整句而不是只給一個顏色:狀態不能只靠顏色,而且要說得出去哪裡改。
                  */}
                  {u.status === 'disabled' &&
                  ((u.customerCount ?? 0) > 0 || (u.memberCount ?? 0) > 0) ? (
                    <div className="badge badge-danger mt-1">
                      已停用但尚未交接:
                      {(u.customerCount ?? 0) > 0 ? `名下還有 ${u.customerCount} 位客戶` : ''}
                      {(u.customerCount ?? 0) > 0 && (u.memberCount ?? 0) > 0 ? '、' : ''}
                      {(u.memberCount ?? 0) > 0 ? `底下還有 ${u.memberCount} 位團隊成員` : ''}
                      。客戶到客戶卡按「轉派承辦人員」改派;成員按這一列的「編輯」改所屬主管
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <span className={`badge ${u.role === 'admin' ? 'badge-primary' : 'badge-muted'}`}>
                    {roleLabel(u.role)}
                  </span>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">
                  <span
                    className={`badge ${u.status === 'active' ? 'badge-success' : 'badge-danger'}`}
                  >
                    {u.status === 'active' ? '啟用中' : '已停用'}
                  </span>
                  {u.lockedUntil && new Date(u.lockedUntil) > new Date() ? (
                    <div className="mt-1 text-[10px] text-destructive">
                      鎖定至 {fmtTime(u.lockedUntil)}
                    </div>
                  ) : null}
                  {u.failedLoginCount > 0 ? (
                    // 這個數字是「這個帳號最近被打了幾次」,不是「還差幾次會被鎖」:
                    // 鎖定是按「帳號 + 來源 IP」算的(後端 auth/login-attempts.service.ts),
                    // 所以別人從別的 IP 亂打鎖不到本人,但這裡看得出來有人在打。
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      登入失敗 {u.failedLoginCount} 次
                    </div>
                  ) : null}
                </td>
                <td className="hidden px-4 py-3 lg:table-cell text-xs text-muted-foreground">
                  {u.lastLoginAt ? fmtTime(u.lastLoginAt) : '從未登入'}
                </td>
                {/* 送出中不用 disabled(焦點會掉到 body,鍵盤使用者跟丟),
                    改 aria-disabled + aria-busy 並在 handler 早退 ——
                    與看板、打卡頁同一條規則。這一列的「重設密碼」更要照做:
                    它按下去會開一個視窗,關閉時焦點必須還得回這顆鈕。 */}
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={(e) => {
                      if (busyId === u.id) return;
                      openEdit(u, e.currentTarget);
                    }}
                    aria-disabled={busyId === u.id}
                    aria-busy={busyId === u.id}
                    className="btn btn-xs"
                  >
                    編輯
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      if (busyId === u.id) return;
                      void onResetPassword(u, e.currentTarget);
                    }}
                    aria-disabled={busyId === u.id}
                    aria-busy={busyId === u.id}
                    className="btn btn-xs"
                  >
                    重設密碼
                  </button>
                  {/* 只有真的被鎖住或累積過失敗次數時才出現,平常不佔版面 */}
                  {(u.lockedUntil && new Date(u.lockedUntil) > new Date()) ||
                  u.failedLoginCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (busyId === u.id) return;
                        void onUnlock(u);
                      }}
                      aria-disabled={busyId === u.id}
                      aria-busy={busyId === u.id}
                      className="btn btn-xs"
                    >
                      解除鎖定
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (busyId === u.id) return;
                      void onToggleStatus(u);
                    }}
                    aria-disabled={busyId === u.id}
                    aria-busy={busyId === u.id}
                    className={`btn btn-xs ${u.status === 'active' ? 'btn-danger' : 'btn-success'}`}
                  >
                    {u.status === 'active' ? '停用' : '啟用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editUser ? (
        <ModalDialog
          labelledBy="edit-user-title"
          onClose={() => setEditUser(null)}
          opener={editOpener}
          onSubmit={onSaveEdit}
          panelClassName="max-w-lg space-y-4"
        >
          <h2 id="edit-user-title" className="page-h2">
            編輯使用者:{editUser.email}
          </h2>
          <p className="text-xs text-muted-foreground">
            姓名 / 職稱 / 聯絡資料(會顯示為客戶看得到的承辦窗口)
          </p>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">姓名</span>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
              maxLength={100}
              disabled={editing}
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">職稱</span>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              maxLength={40}
              disabled={editing}
              placeholder="例:區域主管"
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">手機</span>
            <input
              type="tel"
              value={editMobile}
              onChange={(e) => setEditMobile(e.target.value)}
              maxLength={40}
              disabled={editing}
              placeholder="0928-xxx-xxx"
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">公司電話</span>
            <input
              type="tel"
              value={editPhone}
              onChange={(e) => setEditPhone(e.target.value)}
              maxLength={40}
              disabled={editing}
              placeholder="02-1234-5678"
              className="input"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">分機</span>
            <input
              type="text"
              value={editExtension}
              onChange={(e) => setEditExtension(e.target.value)}
              maxLength={20}
              disabled={editing}
              placeholder="123"
              className="input"
            />
          </label>

          {canEditRole ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">登入角色</span>
              <select
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as UserRole)}
                disabled={editing}
                className="input"
              >
                {USER_ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                改成看不到客戶管理的角色前,要先把這個人名下的客戶轉派出去。
                底下還有團隊成員的主管也要先改派成員才能降級。
              </span>
            </label>
          ) : null}

          {canEditOrg ? (
            <fieldset className="space-y-4 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">組織歸屬</legend>
              <p className="text-xs text-muted-foreground">
                訪查主管看得到誰,就是由這兩欄決定的:所屬主管指向他的人,加上他所屬部門
                子樹裡的人。把人升成主管之後,記得回來把成員指到他底下,不然他的看板是空的。
              </p>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">所屬主管</span>
                <select
                  value={editManagerId}
                  onChange={(e) => setEditManagerId(e.target.value)}
                  disabled={editing}
                  className="input"
                >
                  <option value="">不指定</option>
                  {salesUsers
                    .filter((u) => u.id !== editUser.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
                {salesUsers.length === 0 ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    目前沒有可以指定的主管,請先建立訪查人員或訪查主管帳號
                  </span>
                ) : null}
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">所屬部門</span>
                <select
                  value={editDepartmentId}
                  onChange={(e) => setEditDepartmentId(e.target.value)}
                  disabled={editing}
                  className="input"
                >
                  <option value="">不指定</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {departmentPathLabel(departments, d.id)}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-muted-foreground">
                  部門在{' '}
                  <Link href="/admin/settings?tab=departments" className="underline">
                    系統設定的組織部門
                  </Link>{' '}
                  維護。這一格才有權限意義;建立帳號時填的「部門文字」只顯示在浮水印上
                </span>
              </label>
            </fieldset>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setEditUser(null)}
              disabled={editing}
              className="btn btn-sm"
            >
              取消
            </button>
            <button type="submit" disabled={editing} className="btn btn-primary btn-sm">
              {editing ? '儲存中...' : '儲存'}
            </button>
          </div>
        </ModalDialog>
      ) : null}

      {tempPwdModal ? (
        // 這個視窗裡是只會顯示一次的密碼。焦點沒鎖住的話,使用者一個 Tab 就走到頁尾,
        // 而視窗一關密碼就沒了 —— 這一個視窗特別不能少焦點管理。
        <ModalDialog
          labelledBy="temp-pwd-title"
          onClose={() => setTempPwdModal(null)}
          opener={pwdOpener}
          panelClassName="max-w-md"
        >
          <h2 id="temp-pwd-title" className="page-h2 mb-3">
            臨時密碼產生完成
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">
            請複製給「<strong className="text-foreground">{tempPwdModal.email}</strong>」
            此密碼**只會顯示一次** 關閉視窗後就無法再看到
          </p>
          <div className="mb-4 rounded-md border border-border-strong bg-muted p-3 font-mono text-base break-all">
            {tempPwdModal.password}
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            對方第一次用這個密碼登入後,系統會強制要求改成新密碼
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={copyTempPwd} className="btn btn-primary btn-sm flex-1">
              複製密碼
            </button>
            <button type="button" onClick={() => setTempPwdModal(null)} className="btn btn-sm">
              我已複製,關閉
            </button>
          </div>
        </ModalDialog>
      ) : null}
    </article>
  );
}
