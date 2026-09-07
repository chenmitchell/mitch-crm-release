// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 可見範圍(ViewScope)。
 *
 * 這支取代了原本散在各 controller 的 `isViewAll(role)` 布林。
 * 布林只表達得出「全部」與「只有自己」兩種,一旦要支援「主管看自己團隊」,
 * 每一支端點都得各自補一段 if,而漏掉的那一支不會有人發現 —— 它不會報錯,
 * 只是把別人的客戶一起顯示出來。
 *
 * 改成一個物件之後,範圍由一處算出來(AccessScopeService),各 service 只負責
 * 依它組 where。新增端點時型別會逼你傳 scope 進來,忘不掉。
 *
 * 權限口徑(規格):
 *   sales          看自己
 *   sales_manager  看自己團隊:managerId 指向自己的人(可遞迴),加上自己所屬部門子樹裡的人
 *   admin          看全部
 *   其餘角色       看自己(不進 CRM,由各 controller 的 assertCrm 先擋掉)
 */

export interface ViewScope {
  /** 呼叫者本人 */
  readonly userId: string;
  /** true = 不限負責人(系統管理員) */
  readonly viewAll: boolean;
  /**
   * viewAll=false 時可見的負責人 id 集合,一定含自己。
   * 一般業務就是 [自己];訪查主管是自己 + 團隊成員 + 部門子樹成員。
   */
  readonly ownerIds: readonly string[];
}

/** 只看自己 */
export function ownOnlyScope(userId: string): ViewScope {
  return { userId, viewAll: false, ownerIds: [userId] };
}

/** 看全部 */
export function allScope(userId: string): ViewScope {
  return { userId, viewAll: true, ownerIds: [] };
}

/** 看一組人(自己一定在內,重複會去掉) */
export function teamScope(userId: string, ownerIds: readonly string[]): ViewScope {
  return { userId, viewAll: false, ownerIds: [...new Set([userId, ...ownerIds])] };
}

/** 這個負責人在不在可見範圍內 */
export function canSeeOwner(scope: ViewScope, ownerId: string | null | undefined): boolean {
  if (scope.viewAll) return true;
  if (!ownerId) return false;
  return scope.ownerIds.includes(ownerId);
}

/**
 * 直接掛在 dev_customers 上的 where 片段。
 * viewAll 回空物件(不加條件),否則回 ownerId IN (...)。
 */
export function ownerFilter(scope: ViewScope): Record<string, unknown> {
  if (scope.viewAll) return {};
  return { ownerId: { in: [...scope.ownerIds] } };
}

/**
 * 透過關聯欄位(例如 dev_interactions.customer)限縮的 where 片段。
 * @param relation 關聯欄位名,預設 customer
 */
export function relatedOwnerFilter(
  scope: ViewScope,
  relation = 'customer',
): Record<string, unknown> {
  if (scope.viewAll) return {};
  return { [relation]: { ownerId: { in: [...scope.ownerIds] } } };
}

/**
 * 依 userId 欄位(不是 ownerId)限縮的 where 片段。日報是「誰寫的」不是「誰負責」。
 */
export function authorFilter(scope: ViewScope): Record<string, unknown> {
  if (scope.viewAll) return {};
  return { userId: { in: [...scope.ownerIds] } };
}

// ── 純計算:部門子樹與團隊展開 ──────────────────────────────

export interface DepartmentNode {
  readonly id: string;
  readonly parentId: string | null;
}

export interface UserNode {
  readonly id: string;
  readonly managerId: string | null;
  readonly departmentId: string | null;
}

/**
 * 從 rootIds 往下展開部門子樹(含 root 本身)。
 *
 * 有環也不會無限迴圈:已經走過的節點不再展開。部門是人維護的資料,
 * 「A 的上層是 B、B 的上層是 A」這種輸入遲早會出現,而它造成的當機
 * 會是整支 API 逾時,不是一個看得懂的錯誤。
 */
export function departmentSubtreeIds(
  departments: readonly DepartmentNode[],
  rootIds: readonly string[],
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const d of departments) {
    if (!d.parentId) continue;
    const list = childrenOf.get(d.parentId) ?? [];
    list.push(d.id);
    childrenOf.set(d.parentId, list);
  }

  const seen = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return [...seen];
}

/**
 * 從 rootId 往下展開「所屬主管」樹(不含 rootId 自己)。
 * 同樣有環保護,理由同上。
 */
export function reportingSubtreeIds(users: readonly UserNode[], rootId: string): string[] {
  const membersOf = new Map<string, string[]>();
  for (const u of users) {
    if (!u.managerId) continue;
    const list = membersOf.get(u.managerId) ?? [];
    list.push(u.id);
    membersOf.set(u.managerId, list);
  }

  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const member of membersOf.get(id) ?? []) {
      if (seen.has(member)) continue;
      seen.add(member);
      out.push(member);
      queue.push(member);
    }
  }
  return out;
}

export interface ResolveScopeInput {
  readonly userId: string;
  readonly role: string | null | undefined;
  readonly users: readonly UserNode[];
  readonly departments: readonly DepartmentNode[];
}

/**
 * 依角色算出可見範圍。純函式,不碰資料庫,測試直接餵三張表的內容。
 *
 * sales_manager 的範圍是「團隊 ∪ 部門子樹」而不是二選一:
 *   組織不見得兩套都填。只有 managerId 的公司靠團隊樹,只有部門的公司靠部門樹,
 *   兩套都填的公司(常見:部門是行政歸屬、managerId 是實際帶人的主管)兩邊都算。
 *   取聯集不會少看,而少看的後果是主管以為某位業務今天沒出門。
 */
export function resolveViewScope(input: ResolveScopeInput): ViewScope {
  const { userId, role, users, departments } = input;
  if (role === 'admin') return allScope(userId);
  if (role !== 'sales_manager') return ownOnlyScope(userId);

  const ids = new Set<string>([userId]);
  for (const id of reportingSubtreeIds(users, userId)) ids.add(id);

  const self = users.find((u) => u.id === userId);
  if (self?.departmentId) {
    const deptIds = new Set(departmentSubtreeIds(departments, [self.departmentId]));
    for (const u of users) {
      if (u.departmentId && deptIds.has(u.departmentId)) ids.add(u.id);
    }
  }

  return teamScope(userId, [...ids]);
}
