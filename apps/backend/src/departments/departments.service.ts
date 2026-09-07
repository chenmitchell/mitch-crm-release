// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 組織部門。
 *
 * 為什麼要一張表而不是 users.department 那個字串欄位:
 *   字串欄位表達不出上下層,而權限口徑要的是「部門子樹」——「北區」的主管要看得到
 *   「北區 A 組」。字串比對做不到,也擋不住「北區」與「北 區」被當成兩個部門。
 *   舊的 department 字串欄位保留不動(M365 同步寫的是它),兩者並存不衝突。
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessScopeService } from '../scope/access-scope.service';
import { departmentSubtreeIds } from '../scope/view-scope';

export interface DepartmentView {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  /** 直接掛在這個部門底下的人數(不含子部門) */
  memberCount: number;
}

@Injectable()
export class DepartmentsService {
  private readonly logger = new Logger(DepartmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AccessScopeService,
  ) {}

  private assertAdmin(role: string | null | undefined): void {
    if (role !== 'admin') throw new ForbiddenException('只有系統管理員可以維護組織部門');
  }

  /**
   * 部門清單。
   *
   * 這一支原本只有 AuthGuard,service 這側連 role 都不收:任何一個登入者
   * (包含只看得到自己客戶的訪查人員)打一次就拿到整棵組織樹 —— 部門名稱、
   * 上下層關係與每一層的人數。前端沒有任何一個非管理員畫面會用到它
   * (使用者管理只在 me.role === 'admin' 時才取、單一登入設定頁與部門編輯器
   * 都是管理員專屬),所以那等於「前端藏起來、後端沒擋」。
   *
   * 組織樹是誰看得到誰的依據(見 ../scope/view-scope.ts),讀取權限跟著寫入
   * 一起收在系統管理員。內部要展開組織樹的路徑走 AccessScopeService,
   * 直接讀 users / departments 兩張表,不經過這一支。
   */
  async list(role: string | null | undefined): Promise<DepartmentView[]> {
    this.assertAdmin(role);
    const rows = await this.prisma.department.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        parentId: true,
        sortOrder: true,
        _count: { select: { members: true } },
      },
    });
    return rows.map(
      (r: {
        id: string;
        name: string;
        parentId: string | null;
        sortOrder: number;
        _count: { members: number };
      }) => ({
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        sortOrder: r.sortOrder,
        memberCount: r._count.members,
      }),
    );
  }

  async create(
    role: string | null | undefined,
    dto: { name: string; parentId?: string | null; sortOrder?: number },
  ): Promise<DepartmentView> {
    this.assertAdmin(role);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('部門名稱不可空白');
    if (dto.parentId) await this.mustExist(dto.parentId);
    const row = await this.prisma.department.create({
      data: { name, parentId: dto.parentId ?? null, sortOrder: dto.sortOrder ?? 0 },
    });
    this.scope.bustCache();
    this.logger.log(`[departments] 新增部門 ${name}`);
    return {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      memberCount: 0,
    };
  }

  /**
   * 更新部門。
   *
   * 換上層時要擋「把自己掛到自己的子部門底下」:那會做出一個孤島 ——
   * 那一整段子樹從根走不到,權限展開查不到它,而畫面上完全正常。
   */
  async update(
    role: string | null | undefined,
    id: string,
    dto: { name?: string; parentId?: string | null; sortOrder?: number },
  ): Promise<DepartmentView> {
    this.assertAdmin(role);
    await this.mustExist(id);

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) throw new BadRequestException('上層部門不能是自己');
      await this.mustExist(dto.parentId);
      const all = await this.prisma.department.findMany({ select: { id: true, parentId: true } });
      if (departmentSubtreeIds(all, [id]).includes(dto.parentId)) {
        throw new BadRequestException('上層部門不能是自己的子部門,那會讓這一段組織從根連不到');
      }
    }

    const row = await this.prisma.department.update({
      where: { id },
      data: {
        name: dto.name?.trim() || undefined,
        parentId: dto.parentId === undefined ? undefined : dto.parentId,
        sortOrder: dto.sortOrder ?? undefined,
      },
      select: {
        id: true,
        name: true,
        parentId: true,
        sortOrder: true,
        _count: { select: { members: true } },
      },
    });
    this.scope.bustCache();
    return {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      memberCount: row._count.members,
    };
  }

  /**
   * 刪除部門。底下還有人或還有子部門就擋下來。
   * 直接刪的話,成員的 departmentId 會被 SET NULL,那些人當場從主管的可見範圍消失,
   * 而且沒有任何訊息說明發生了什麼。
   */
  async remove(role: string | null | undefined, id: string): Promise<{ ok: true }> {
    this.assertAdmin(role);
    const dept = await this.mustExist(id);
    const [members, children] = await Promise.all([
      this.prisma.user.count({ where: { departmentId: id } }),
      this.prisma.department.count({ where: { parentId: id } }),
    ]);
    if (members > 0) {
      throw new BadRequestException(
        `「${dept.name}」底下還有 ${members} 位成員,請先把他們改到其他部門再刪除`,
      );
    }
    if (children > 0) {
      throw new BadRequestException(
        `「${dept.name}」底下還有 ${children} 個子部門,請先處理子部門再刪除`,
      );
    }
    await this.prisma.department.delete({ where: { id } });
    this.scope.bustCache();
    this.logger.log(`[departments] 刪除部門 ${dept.name}`);
    return { ok: true };
  }

  private async mustExist(id: string): Promise<{ id: string; name: string }> {
    const row = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!row) throw new NotFoundException('找不到此部門');
    return row;
  }
}
