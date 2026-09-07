/**
 * 使用者管理(建立、停用、改角色、改歸屬、重設密碼)。
 *
 * ── 這個檔為什麼值得小心 ────────────────────────────────────────
 * 這裡每一支都會改變「誰看得到誰的客戶」。可見範圍是由 role、managerId、
 * departmentId 三個欄位算出來的(見 ../scope/view-scope.ts),
 * 所以把一個人的角色從訪查主管改成訪查人員、或把 managerId 清掉,
 * 效果等同於把一批客戶從別人的清單上拿掉 —— 而畫面上不會有任何警告,
 * 被影響的是別人的頁面,不是操作者自己的。改這裡的邏輯前先讀 view-scope。
 *
 * ── 三條規則 ────────────────────────────────────────────────────
 * 1. **授權在 service 做,不在 controller。** 每一支開頭都 ensureCanManage(actor),
 *    而且訪查主管只管得到自己團隊裡的訪查人員(見 UserActor 的說明)。
 *    controller 只負責把 JWT 的身分原樣傳下來。
 * 2. **角色清單查 CRM_ROLES,不另抄一份。** 後台設得出一個角色、那個人卻進不了
 *    任何一頁,是兩份清單走散最典型的症狀。
 * 3. **密碼一律 Argon2id,臨時密碼用無偏的亂數。** generateTempPassword 用
 *    randomInt 而不是 randomBytes(1) % n,理由寫在那個函式上面。
 *    重設密碼會一併推進 passwordChangedAt,先前簽出去的權杖從下一個請求開始失效。
 */
import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { PASSWORD_MIN } from '@mitchcrm/shared';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, type M365DirectoryEntry } from '../settings/settings.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { AccessScopeService } from '../scope/access-scope.service';
import { SessionUserService } from '../auth/session-user.service';
import { LoginAttemptsService } from '../auth/login-attempts.service';
import { normalizeEmail } from '../common/email';
// 「看得到客戶管理的角色」跟 CRM controller 的守衛吃同一份清單(見 crm/crm-roles.ts)。
// 這裡用來判斷改角色會不會把客戶變成沒人看得到的孤兒 —— 兩份清單走散的話,
// 後台設得出一個角色,設完那個人卻進不了任何一頁。
import { CRM_ROLES } from '../crm/crm-roles';

/**
 * 產臨時密碼:大寫 + 小寫 + 數字 + 符號各至少 1 個,
 * 長度等於全系統共用的密碼下限 PASSWORD_MIN(packages/shared/src/password.ts)。
 * 排除掉容易看錯的字元(0/O、1/l、I)。
 *
 * 長度不要在這裡寫死。原本這裡是「4 個保證字元 + 迴圈 8 次」共 12 個字元,
 * 今天剛好等於 PASSWORD_MIN,但下限一調高就會發出低於下限的臨時密碼,
 * 而且發的當下不會有任何錯誤,要到收件人走改密碼那一步才被擋下來。
 */
export function generateTempPassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const num = '23456789';
  const sym = '!@#$%&*';
  const all = lower + upper + num + sym;
  // randomInt 是無偏的拒絕取樣;randomBytes(1) % length 會讓字元集開頭幾個字元機率偏高
  const pick = (s: string): string => s[randomInt(s.length)] ?? s[0]!;
  let pw = pick(lower) + pick(upper) + pick(num) + pick(sym);
  // 長度跟著全系統共用的下限走,不要寫死。四個保證字元已經佔掉 4 個位置,
  // 其餘補滿。寫死數字的話下限一調高,這裡就會發出低於下限的臨時密碼,
  // 而使用者要到改密碼那一步才會發現。
  for (let i = 0; i < Math.max(0, PASSWORD_MIN - 4); i++) pw += pick(all);
  // shuffle
  const arr = pw.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.join('');
}

/**
 * 呼叫者身分。controller 從 JWT 取出後整個傳下來,service 自己決定範圍:
 *   admin          不受限
 *   sales_manager  只能管「自己團隊(managerId = 自己)且 role = sales」的帳號;
 *                  建立時強制 role = sales、managerId = 自己;不能改 role、不能設 managerId
 *   其他角色       一律 403
 */
export interface UserActor {
  sub: string;
  role: UserRole | string;
}

function isAdmin(actor: UserActor): boolean {
  return actor.role === 'admin';
}
function isManager(actor: UserActor): boolean {
  return actor.role === 'sales_manager';
}
function ensureCanManage(actor: UserActor) {
  if (!isAdmin(actor) && !isManager(actor)) {
    throw new ForbiddenException('只有系統管理員與訪查主管可以管理使用者');
  }
}

/** 列表與更新回傳時附上的主管與部門欄位 */
const MANAGER_SELECT = {
  managerId: true,
  manager: { select: { name: true } },
  departmentId: true,
  departmentRef: { select: { name: true } },
} as const;

function withManagerName<
  T extends {
    managerId?: string | null;
    manager?: { name: string } | null;
    departmentId?: string | null;
    departmentRef?: { name: string } | null;
  },
>(
  u: T,
): Omit<T, 'manager' | 'departmentRef'> & {
  managerName: string | null;
  departmentName: string | null;
} {
  const { manager, departmentRef, ...rest } = u;
  return {
    ...rest,
    managerName: manager?.name ?? null,
    departmentName: departmentRef?.name ?? null,
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  /**
   * AccessScopeService 用 @Optional:既有單元測試直接 new UsersService(prisma, settings),
   * 沒帶就只是少一次快取清除,那份快取本來就只留 10 秒。
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Optional() private readonly scope?: AccessScopeService,
    // 停用 / 改角色 / 重設密碼之後要清掉授權快取,讓下一個請求立刻重查
    // (見 auth/session-user.service.ts)。@Optional 是為了讓既有的單元測試
    // 不必為了一個快取而全部改建構子。
    @Optional() private readonly sessionUsers?: SessionUserService,
    // 解鎖與重設密碼要一併清掉「帳號 + 來源 IP」的失敗計數
    // (見 auth/login-attempts.service.ts)。@Optional 理由同上。
    @Optional() private readonly loginAttempts?: LoginAttemptsService,
  ) {}

  /**
   * 訪查主管可以動的目標:role = sales 且 managerId = 自己。
   * 不在範圍內一律回 404(跟不存在同一個訊息),不透露「有這個人但不歸你管」。
   */
  private async findManageable(actor: UserActor, userId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('找不到此使用者');
    if (isManager(actor) && (target.role !== 'sales' || target.managerId !== actor.sub)) {
      throw new NotFoundException('找不到此使用者');
    }
    return target;
  }

  async list(actor: UserActor) {
    ensureCanManage(actor);
    const users = await this.prisma.user.findMany({
      // 訪查主管:自己團隊的業務 + 自己
      where: isAdmin(actor)
        ? undefined
        : { OR: [{ id: actor.sub }, { role: 'sales', managerId: actor.sub }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        mobile: true,
        title: true,
        extension: true,
        role: true,
        status: true,
        mustChangePassword: true,
        failedLoginCount: true,
        lockedUntil: true,
        lastLoginAt: true,
        createdAt: true,
        department: true,
        ...MANAGER_SELECT,
      },
    });

    /**
     * 從 Microsoft 365 同步回來的組織資料(部門 / 辦公室 / 員工編號 / 主管)。
     *
     * 為什麼不是 users 表的欄位:這幾格是「外部目錄怎麼寫」的快取,不是這套系統的
     * 真相來源,而且純粹拿來顯示 —— 可見範圍是由 users.manager_id 與
     * users.department_id 兩個真欄位決定的,不吃這一包。為了一份會被外部覆寫的
     * 顯示資料在 users 表長四五個欄位,遷移與回填的成本高於效益,所以整包存
     * system_settings id=4。詳見 settings.service.ts 的 M365_DIRECTORY_ROW_ID。
     *
     * 這個取捨有代價:整包 JSON 的寫入是 read-modify-write,併發登入會互相覆蓋,
     * 所以那一支寫入必須拿 advisory lock(見 settings/settings-lock.ts)。
     * 哪天這些欄位要進 users 表,那把鎖就可以跟著拿掉。
     *
     * 新增欄位不影響既有回應:m365 是多出來的一個屬性,原本每一個欄位都還在原位。
     * 讀不到設定表也不能讓使用者清單整頁壞掉,所以失敗就當成「沒同步過」。
     */
    let directory: Record<string, M365DirectoryEntry> = {};
    try {
      directory = (await this.settings.getM365Directory()).users ?? {};
    } catch (e) {
      this.logger.warn(`[list-users] 讀取 M365 組織資料失敗,改為不顯示:${(e as Error).message}`);
    }

    /**
     * 名下還有幾位客戶(不含被查重合併掉的那些)。
     *
     * 停用一個帳號不會把他的客戶帶走:那些客戶還留在他名下,還會逾期,
     * 而畫面上原本只問一句「確定要停用某某?」。有這個數字,使用者按下去之前
     * 就看得到「還有 12 位客戶要移交」。一次 groupBy 撈完,不是逐人查。
     * 撈不到就整欄不帶(undefined),使用者管理不該因為一個附加數字而壞掉。
     */
    let customerCount: Record<string, number> = {};
    try {
      const grouped = await this.prisma.devCustomer.groupBy({
        by: ['ownerId'],
        // 已刪除與已合併的客戶不算在「名下幾筆」:那個數字是用來判斷能不能停用帳號的
        where: {
          ownerId: { in: users.map((u: { id: string }) => u.id) },
          mergedIntoId: null,
          deletedAt: null,
        },
        _count: { _all: true },
      });
      customerCount = Object.fromEntries(
        (grouped as Array<{ ownerId: string; _count: { _all: number } }>).map((g) => [
          g.ownerId,
          g._count._all,
        ]),
      );
    } catch (e) {
      this.logger.warn(`[list-users] 計算名下客戶數失敗,改為不顯示:${(e as Error).message}`);
    }

    /**
     * 底下還有幾位團隊成員(managerId 指向這個人的帳號)。
     *
     * 跟名下客戶數同一個理由:停用不會把團隊帶走。停用一位還有成員的主管,
     * 那些成員的 managerId 會繼續指向一個停用的帳號,沒有任何錯誤,
     * 只是那個團隊安靜地沒有主管了 —— 可見範圍是靠 managerId 展開的
     * (見 ../scope/view-scope.ts),沒有主管就沒有人看得到他們的客戶。
     * 一次 groupBy 撈完;撈不到就整欄不帶,使用者管理不該因為附加數字而壞掉。
     */
    let memberCount: Record<string, number> = {};
    try {
      const grouped = await this.prisma.user.groupBy({
        by: ['managerId'],
        where: { managerId: { in: users.map((u: { id: string }) => u.id) } },
        _count: { _all: true },
      });
      memberCount = Object.fromEntries(
        (grouped as Array<{ managerId: string | null; _count: { _all: number } }>)
          .filter((g) => g.managerId !== null)
          .map((g) => [g.managerId as string, g._count._all]),
      );
    } catch (e) {
      this.logger.warn(`[list-users] 計算團隊成員數失敗,改為不顯示:${(e as Error).message}`);
    }

    // map 的參數明寫型別:Prisma client 尚未 generate 的環境(CI / 容器內沒網路)
    // 型別檢查會退化成 implicit any 而報 TS7006,見 entra-audit.service 的同一段說明
    return {
      users: users.map(
        (u: {
          id: string;
          managerId: string | null;
          manager: { name: string } | null;
          departmentId: string | null;
          departmentRef: { name: string } | null;
        }) => ({
          ...withManagerName(u),
          m365: directory[u.id] ?? null,
          customerCount: customerCount[u.id] ?? 0,
          memberCount: memberCount[u.id] ?? 0,
        }),
      ),
    };
  }

  async create(actor: UserActor, dto: CreateUserDto) {
    ensureCanManage(actor);
    // DTO 已經正規化過一次,這裡再一次是為了「繞過 DTO 的呼叫端」(單元測試、
    // 日後新增的內部呼叫)。email 的大小寫一旦漏掉,就是同一個人兩個帳號,
    // 而且 SSO 對帳只認小寫的那一個 —— 理由見 common/email.ts
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    // 不回傳輸入的 email:訪查主管可以拿這支端點逐一試出全公司有哪些帳號,
    // 訊息帶著輸入值等於把枚舉結果直接印回去
    if (existing) throw new ConflictException('此 email 已被使用,請確認後再建立');

    // 訪查主管建的一律是自己團隊的業務,傳什麼 role / managerId 都不採用
    const role: UserRole = isAdmin(actor) ? dto.role : 'sales';
    const managerId = isAdmin(actor) ? await this.resolveManagerId(dto.managerId) : actor.sub;

    const tempPassword = generateTempPassword();
    const hash = await argon2.hash(tempPassword, { type: argon2.argon2id });

    const u = await this.prisma.user.create({
      // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      data: {
        email,
        name: dto.name,
        role,
        phone: dto.phone,
        mobile: dto.mobile,
        title: dto.title,
        extension: dto.extension,
        department: dto.department,
        departmentId: isAdmin(actor) ? await this.resolveDepartmentId(dto.departmentId) : null,
        managerId: managerId ?? null,
        passwordHash: hash,
        mustChangePassword: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        mobile: true,
        title: true,
        extension: true,
        department: true,
        role: true,
        createdAt: true,
        ...MANAGER_SELECT,
      },
    });
    this.scope?.bustCache();
    this.logger.log(`[create-user] ${u.email} (${u.role}) by ${actor.sub}`);
    return {
      user: withManagerName(u),
      tempPassword,
      message: '請複製臨時密碼給該使用者,此密碼只會顯示一次。對方第一次登入會被強制改密碼',
    };
  }

  async resetPassword(actor: UserActor, userId: string) {
    ensureCanManage(actor);
    const target = await this.findManageable(actor, userId);

    const tempPassword = generateTempPassword();
    const hash = await argon2.hash(tempPassword, { type: argon2.argon2id });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        // 重設密碼的用途之一就是「這個帳號可能被盜了」。寫下時間,
        // 讓這一刻之前簽出去的權杖全部作廢(見 auth/session-user.service.ts)。
        passwordChangedAt: new Date(),
      },
    });
    this.sessionUsers?.invalidate(userId);
    // 重設密碼也把登入失敗計數清乾淨:管理員發了新的臨時密碼,
    // 這個人不應該還卡在上一輪打錯留下的鎖定裡
    this.loginAttempts?.clearAccount(normalizeEmail(target.email));
    this.logger.log(`[reset-password] ${target.email} by ${actor.sub}`);
    return {
      tempPassword,
      message: '請複製臨時密碼給該使用者,此密碼只會顯示一次',
    };
  }

  /**
   * 手動解鎖。
   *
   * ── 為什麼需要這一支 ────────────────────────────────────────────
   * 登入失敗鎖定原本只鎖帳號、而且沒有任何解鎖的路徑:被鎖的人只能等 30 分鐘,
   * 管理員唯一能做的是「重設密碼」—— 那會連帶把他現在用得好好的密碼換掉,
   * 是一個比問題本身更重的動作。鎖定改成「帳號 + 來源 IP」之後外人鎖不到別人,
   * 但本人自己打錯太多次仍然會把自己鎖住,那時需要一個只做解鎖、不動密碼的操作。
   *
   * 做兩件事:清掉這個帳號在**所有**來源 IP 的失敗計數與鎖定,
   * 以及把 users 上那兩格(failed_login_count / locked_until)歸零 ——
   * 後者現在只是給管理員看的紀錄,但留著一個過期的紅字沒有意義。
   *
   * 授權範圍與其他操作一致:訪查主管只解得開自己團隊裡的訪查人員。
   */
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  async unlock(actor: UserActor, userId: string) {
    ensureCanManage(actor);
    const target = await this.findManageable(actor, userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    this.loginAttempts?.clearAccount(normalizeEmail(target.email));
    this.logger.log(`[unlock] ${target.email} by ${actor.sub}`);
    return { ok: true, message: '已解除登入鎖定' };
  }

  /**
   * 停用一個帳號會連帶影響什麼:名下還有幾位客戶、底下還有幾位團隊成員,
   * 以及這一次停用會不會被硬擋(最後一位啟用中的系統管理員)。
   *
   * ── 為什麼要有這一支 ────────────────────────────────────────────
   * 這套系統沒有「刪除使用者」,停用就是離職流程本身。而 setStatus 原本只有
   * 一道防線(不能停用自己),旁邊的 resolveRoleChange 卻有四道 —— 同一批
   * 後果從改角色那條路走會被擋下,從停用這條路走一句話都沒有:
   *   停用一位還有團隊成員的主管 → 那些成員的 managerId 指向一個停用的帳號,
   *     那個團隊安靜地沒有主管,他們的客戶從所有主管的可見範圍消失。
   *   停用一位名下還有客戶的訪查人員 → 客戶還在、還會逾期,只是沒有人在看。
   *
   * 決定是「不硬擋,但先講清楚」:離職是既成事實,擋住只會讓管理員無路可走
   * (帳號要停,而客戶又只能由管理員改派)。所以這一支把數字先算出來給前端,
   * 停用完成的回應也帶著同一包,讓「停用之後他們不會自動改派」這句話一定被說出口。
   * 唯一硬擋的是最後一位系統管理員,理由與 resolveRoleChange 第 2 條完全相同:
   * 擋不住的話系統會沒有任何人能管帳號,而且救不回來(沒有刪除,也沒有第二條路)。
   */
  async disableImpact(actor: UserActor, userId: string) {
    ensureCanManage(actor);
    const target = await this.findManageable(actor, userId);
    return this.buildDisableImpact(target);
  }

  /** 算 disableImpact 的內容;setStatus 停用時也走這一支,兩邊的數字與說法保證一致 */
  private async buildDisableImpact(target: {
    id: string;
    name: string;
    role: UserRole | string;
    status: string;
  }) {
    const [customerCount, memberCount, otherActiveAdmins] = await Promise.all([
      this.prisma.devCustomer.count({
        where: { ownerId: target.id, mergedIntoId: null, deletedAt: null },
      }),
      this.prisma.user.count({ where: { managerId: target.id } }),
      this.prisma.user.count({
        where: { role: 'admin', status: 'active', id: { not: target.id } },
      }),
    ]);
    // 已經是停用中的帳號不必再擋一次:那時候 otherActiveAdmins 少算的是一個
    // 本來就沒在算的人,擋下去只會讓管理員連「重新停用」都做不了
    const blocked =
      target.role === 'admin' && target.status === 'active' && otherActiveAdmins === 0;
    const blockReason = blocked
      ? '這是系統裡最後一位啟用中的系統管理員,停用之後沒有人能管理帳號。請先把另一個人升成系統管理員再停用這一個'
      : null;
    // 有幾樣就講幾樣:名下沒有客戶的人不該被告知「客戶仍算在他名下」,
    // 那句話對他是錯的,而錯的說明會讓對的那一句一起被略過
    const parts: string[] = [];
    const consequences: string[] = [];
    const todos: string[] = [];
    if (customerCount > 0) {
      parts.push(`名下還有 ${customerCount} 位客戶`);
      consequences.push('客戶仍算在他名下(統計會標「已停用」),沒有人在看');
      todos.push('客戶到客戶卡按「轉派承辦人員」改派');
    }
    if (memberCount > 0) {
      parts.push(`底下還有 ${memberCount} 位團隊成員`);
      consequences.push(
        '成員的所屬主管仍指向這個停用的帳號,那個團隊等於沒有主管,他們的客戶會從主管的可見範圍消失',
      );
      todos.push('成員到使用者管理按「編輯」改所屬主管');
    }
    const message = parts.length
      ? `${target.name}${parts.join(',')}。停用不會自動改派:${consequences.join(';')}。` +
        `請逐一改派:${todos.join(';')}。`
      : `${target.name}名下沒有客戶,底下也沒有團隊成員,停用不會留下需要改派的資料。`;
    return {
      userId: target.id,
      name: target.name,
      customerCount,
      memberCount,
      blocked,
      blockReason,
      message,
    };
  }

  async setStatus(actor: UserActor, userId: string, status: 'active' | 'disabled') {
    ensureCanManage(actor);
    if (userId === actor.sub) {
      throw new BadRequestException('不能停用自己的帳號');
    }
    const target = await this.findManageable(actor, userId);

    // 停用才算影響:啟用不會讓任何東西失去依靠
    const impact = status === 'disabled' ? await this.buildDisableImpact(target) : null;
    if (impact?.blocked) throw new BadRequestException(impact.blockReason ?? '不能停用這個帳號');

    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, email: true, status: true },
    });
    // 停用要立刻生效:授權是每個請求回查 users 的,清掉快取就是「下一個請求 401」
    this.sessionUsers?.invalidate(userId);
    // 停用一位主管等於改變了誰看得到誰(那個團隊的可見範圍會缺一塊),
    // 可見範圍的快取要跟著清,否則最多還有 10 秒是照舊算的
    this.scope?.bustCache();
    this.logger.log(
      `[set-status] ${u.email} → ${status} by ${actor.sub}` +
        (impact ? `(客戶 ${impact.customerCount} / 成員 ${impact.memberCount},未自動改派)` : ''),
    );
    return { user: u, impact, message: impact?.message ?? null };
  }

  /**
   * 檢查並決定這次要不要換角色。
   *
   * 換角色不是改一個欄位而已,它會讓別處的資料失去依靠,所以這裡把三種會造成孤兒的情況擋掉,
   * 並回傳需要一併處理的副作用:
   *
   * 1. 不能改自己的角色 —— 管理員把自己降級就再也進不了使用者管理,只能改資料庫。
   * 2. 不能把最後一個啟用中的管理員降級 —— 系統會沒有人能管帳號。
   * 3. 底下還有團隊成員的訪查主管不能降級 —— 那些成員的所屬主管會指向一個非主管,
   *    resolveManagerId 的規則當場自相矛盾。要降級請先把成員改派給別的主管。
   * 4. 名下還有客戶的人不能改成看不到 CRM 的角色 —— 客戶會變成沒有人看得到的資料。
   *    要改請先用客戶卡的「轉派承辦人員」把客戶交出去。
   *
   * 另外:升成訪查主管時,他自己的所屬主管要清掉(主管不隸屬於另一個主管的團隊)。
   */
  private async resolveRoleChange(
    actor: UserActor,
    userId: string,
    next: UpdateUserDto['role'],
  ): Promise<{ next: UpdateUserDto['role']; clearOwnManager: boolean }> {
    if (next === undefined) return { next: undefined, clearOwnManager: false };
    if (!isAdmin(actor)) throw new ForbiddenException('只有系統管理員可以變更角色');
    if (userId === actor.sub) throw new BadRequestException('不能變更自己的角色');

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true },
    });
    if (!target) throw new NotFoundException('找不到此使用者');
    if (target.role === next) return { next: undefined, clearOwnManager: false };

    if (target.role === 'admin') {
      const admins = await this.prisma.user.count({
        where: { role: 'admin', status: 'active' },
      });
      if (admins <= 1) throw new BadRequestException('系統至少要保留一位啟用中的系統管理員');
    }

    if (target.role === 'sales_manager' && next !== 'sales_manager') {
      const members = await this.prisma.user.count({ where: { managerId: userId } });
      if (members > 0) {
        throw new BadRequestException(
          `此主管底下還有 ${members} 位團隊成員,請先把成員改派給其他主管再變更角色`,
        );
      }
    }

    if (next !== undefined && !CRM_ROLES.includes(next)) {
      const owned = await this.prisma.devCustomer.count({
        where: { ownerId: userId, mergedIntoId: null, deletedAt: null },
      });
      if (owned > 0) {
        throw new BadRequestException(
          `此使用者名下還有 ${owned} 筆客戶,新角色看不到客戶管理,請先轉派客戶再變更角色`,
        );
      }
    }

    return { next, clearOwnManager: next === 'sales_manager' };
  }

  async update(actor: UserActor, userId: string, dto: UpdateUserDto) {
    ensureCanManage(actor);
    await this.findManageable(actor, userId);

    // managerId 只有 admin 能設;訪查主管送了就擋掉,不能把別人的業務搬進自己團隊
    if (dto.managerId !== undefined && !isAdmin(actor)) {
      throw new ForbiddenException('只有系統管理員可以指定所屬主管');
    }
    if (dto.managerId !== undefined && dto.managerId === userId) {
      throw new BadRequestException('所屬主管不能是自己');
    }
    // 部門決定訪查主管看得到誰,所以跟 managerId 一樣只有 admin 能設
    if (dto.departmentId !== undefined && !isAdmin(actor)) {
      throw new ForbiddenException('只有系統管理員可以指定所屬部門');
    }
    const departmentId =
      dto.departmentId === undefined ? undefined : await this.resolveDepartmentId(dto.departmentId);
    const managerId =
      dto.managerId === undefined ? undefined : await this.resolveManagerId(dto.managerId);

    const role = await this.resolveRoleChange(actor, userId, dto.role);

    const u = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name ?? undefined,
        phone: dto.phone ?? undefined,
        mobile: dto.mobile ?? undefined,
        title: dto.title ?? undefined,
        extension: dto.extension ?? undefined,
        managerId: role.clearOwnManager ? null : managerId,
        departmentId,
        role: role.next,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        mobile: true,
        title: true,
        extension: true,
        role: true,
        ...MANAGER_SELECT,
      },
    });
    // 部門或主管一改,誰看得到誰就變了,清掉可見範圍的快取讓下一個請求立刻讀到新組織
    this.scope?.bustCache();
    // 角色一改,授權要跟著改:清掉這個人的授權快取,下一個請求就拿到新角色
    this.sessionUsers?.invalidate(userId);
    this.logger.log(`[update-user] ${u.email} by ${actor.sub}`);
    return { user: withManagerName(u) };
  }

  /**
   * admin 指定所屬主管時的檢查:null = 清掉;有值就必須是存在且啟用中的訪查主管或系統管理員。
   * 回傳可直接寫進 managerId 的值。
   */
  /**
   * 檢查部門存不存在。null / undefined = 清掉歸屬。
   * 不存在就擋下來:寫進一個不存在的部門 id 會讓那個人從所有主管的可見範圍消失,
   * 而畫面上只是部門欄位空著,看不出來發生了什麼。
   */
  private async resolveDepartmentId(
    departmentId: string | null | undefined,
  ): Promise<string | null> {
    if (departmentId == null) return null;
    const d = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true },
    });
    if (!d) throw new BadRequestException('找不到此部門');
    return d.id;
  }

  private async resolveManagerId(managerId: string | null | undefined): Promise<string | null> {
    if (managerId == null) return null;
    const m = await this.prisma.user.findUnique({
      where: { id: managerId },
      select: { id: true, role: true, status: true },
    });
    if (!m || m.status !== 'active' || (m.role !== 'sales_manager' && m.role !== 'admin')) {
      throw new BadRequestException('所屬主管必須是啟用中的訪查主管或系統管理員');
    }
    return m.id;
  }
}
