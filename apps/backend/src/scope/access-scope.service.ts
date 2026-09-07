// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 把「這個人看得到誰的資料」算出來的唯一入口。
 *
 * 只有這一支會去讀 users / departments 兩張表的結構,其餘 service 一律拿
 * ViewScope 物件組 where。想改權限口徑就改這裡與 view-scope.ts 的純函式,
 * 不必回頭巡每一支端點。
 *
 * 快取:訪查主管的每一次請求都要展開一次組織樹,而組織樹一天改不到一次。
 * 這裡放 10 秒的行程內快取 —— 夠短,調完部門的人重整一下畫面就看得到;
 * 也夠長,一個後台頁面連打十幾支 API 只會查一次。
 * 多 instance 部署時各自有一份,差別最多就是十秒內看到的是舊組織,無害。
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  allScope,
  ownOnlyScope,
  resolveViewScope,
  type DepartmentNode,
  type UserNode,
  type ViewScope,
} from './view-scope';

const ORG_CACHE_TTL_MS = 10_000;

@Injectable()
export class AccessScopeService {
  private cached: { users: UserNode[]; departments: DepartmentNode[] } | null = null;
  private cachedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** 給測試與「組織剛改完要立刻生效」的路徑用 */
  bustCache(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  private async org(): Promise<{ users: UserNode[]; departments: DepartmentNode[] }> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < ORG_CACHE_TTL_MS) return this.cached;
    const [users, departments] = await Promise.all([
      this.prisma.user.findMany({ select: { id: true, managerId: true, departmentId: true } }),
      this.prisma.department.findMany({ select: { id: true, parentId: true } }),
    ]);
    this.cached = { users, departments };
    this.cachedAt = now;
    return this.cached;
  }

  /**
   * 算出這個人的可見範圍。
   *
   * admin 與非主管角色不查資料庫:前者永遠是全部,後者永遠只有自己,
   * 查了也不會改變結果,而 CRM 的每一支端點都會呼叫這裡。
   */
  async resolve(userId: string, role: string | null | undefined): Promise<ViewScope> {
    if (role === 'admin') return allScope(userId);
    if (role !== 'sales_manager') return ownOnlyScope(userId);
    const { users, departments } = await this.org();
    return resolveViewScope({ userId, role, users, departments });
  }
}
