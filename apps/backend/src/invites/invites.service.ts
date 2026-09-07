/**
 * 業務邀請連結:主管產一次性連結給新業務,新業務自己開帳號設密碼。
 *
 * 安全前提(每一條都對應一個實際攻擊):
 *   - token 32 bytes 隨機(base64url,256 bit),DB 只存 sha256 —— 資料庫外洩也拿不到可用的連結
 *   - 30 分鐘到期 + 一次性(usedAt),用過即失效
 *   - 每人每小時最多 10 條,擋「大量產連結亂發」
 *   - 查詢無效 token 一律回 valid:false 而不是 404 —— 404/200 的差別本身就是探測訊號
 *   - accept 失敗訊息一律同一句,不透露 email 是否已存在(帳號枚舉)
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PASSWORD_MAX, PASSWORD_MIN } from '@mitchcrm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { getEnv } from '../common/env';
import type { AcceptInviteDto } from './dto/accept-invite.dto';
import { normalizeEmail } from '../common/email';

/** 邀請連結有效時間 */
const INVITE_TTL_MINUTES = 30;
/** 同一位主管一小時內最多產幾條 */
const INVITE_QUOTA_PER_HOUR = 10;
const QUOTA_WINDOW_MS = 60 * 60 * 1000;
/** 已使用的邀請要在列表上留多久。夠回答「上個月那個帳號是誰放進來的」,又不會無限長 */
const USED_INVITE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 密碼規則:全系統一份(packages/shared/src/password.ts),改密碼、安裝精靈與這裡同一組數字。
 * 上限的用途是擋 argon2 被當成 DoS 入口 —— 這支端點不需要登入就打得到。
 * 這兩個名字留著是為了既有引用,值一律來自共用常數,不要在這裡另寫一個。
 */
export const INVITE_PASSWORD_MIN = PASSWORD_MIN;
export const INVITE_PASSWORD_MAX = PASSWORD_MAX;
/** accept 失敗時對外的唯一訊息:任何原因都講同一句,不讓人用回應差異試出 email 存不存在 */
const ACCEPT_GENERIC_ERROR = '無法完成註冊,請確認資料或向主管重新索取連結';
/** 有資格發邀請的角色;連結能不能用要現查發送者現在的角色,不是發送當下的 */
const INVITER_ROLES: readonly string[] = ['sales_manager', 'admin'];

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 對外連結的網址前綴。
   * 跟寄給客戶的填寫連結同一個來源(CORS_ORIGIN 的第一段,見 common/env.ts 的說明),
   * 不另外開一個環境變數 —— 兩個來源遲早會走散,而走散的症狀是「連結指向錯的站」。
   */
  private siteUrl(): string {
    return (getEnv().CORS_ORIGIN.split(',')[0] ?? '').trim().replace(/\/$/, '');
  }

  private assertManager(role: string | null | undefined) {
    if (role !== 'admin' && role !== 'sales_manager') {
      throw new ForbiddenException('僅訪查主管與系統管理員可以邀請新成員');
    }
  }

  /** 產一條新的邀請連結。token 只在這個回應出現一次,DB 只留 sha256 */
  async create(actorId: string, role: string | null | undefined) {
    this.assertManager(role);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MINUTES * 60 * 1000);
    // 額度檢查與建立放同一筆交易,而且先用 FOR UPDATE 鎖住這位主管的 users 列:
    // 原本的 count → create 是 check-then-act,同時送 20 個請求會全部讀到同一個 count,
    // 額度形同虛設。鎖住之後同一個人的請求會排隊,一次只有一個能算額度。
    const invite = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actorId}::uuid FOR UPDATE`;
      const since = new Date(Date.now() - QUOTA_WINDOW_MS);
      const recent = await tx.devInvite.count({
        where: { createdById: actorId, createdAt: { gte: since } },
      });
      if (recent >= INVITE_QUOTA_PER_HOUR) {
        throw new HttpException(
          `邀請連結一小時內最多 ${INVITE_QUOTA_PER_HOUR} 條,請稍後再試`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return tx.devInvite.create({
        data: {
          tokenHash: hashInviteToken(token),
          createdById: actorId,
          role: 'sales',
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
    });
    this.logger.log(`[invite-create] ${invite.id} by ${actorId}`);
    // token 不進 log
    return {
      id: invite.id,
      url: `${this.siteUrl()}/invite/${token}`,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * 自己開的邀請:還能用的那些,加上最近被用掉的那些。
   *
   * 為什麼要一併回已使用的:used_by_user_id 一直有在寫,但沒有任何地方讀,
   * 稽核上等於答不出「這張邀請是被誰用掉的」。發生爭議時
   * (某個帳號是怎麼進來的、誰放他進來的)只剩資料庫可以查,那不是後台該有的樣子。
   *
   * 兩份分開回,不是混成一份:上面那份是「還要傳給誰」的工作清單,
   * 下面那份是紀錄。混在一起的話撤銷鈕要對著已經用掉的那幾筆長出一個沒有意義的狀態。
   * 只回最近 30 天,列表不會隨著時間無限長。
   */
  async listMine(actorId: string, role: string | null | undefined) {
    this.assertManager(role);
    const since = new Date(Date.now() - USED_INVITE_WINDOW_MS);
    // admin 看全部,主管看自己開的(見 visibleWhere 的說明)
    const scope = this.visibleWhere(actorId, role);
    const [rows, used] = await Promise.all([
      this.prisma.devInvite.findMany({
        where: { ...scope, usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          createdById: true,
          createdBy: { select: { name: true } },
        },
      }),
      this.prisma.devInvite.findMany({
        where: { ...scope, usedAt: { gte: since } },
        orderBy: { usedAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          usedAt: true,
          usedByUserId: true,
          createdById: true,
          createdBy: { select: { name: true } },
        },
      }),
    ]);
    // 用掉的那幾筆補上帳號的姓名與 email:只回一個 uuid 的話,
    // 要回答「誰用掉的」還是得自己去查一次使用者清單
    const userIds = used
      .map((r: { usedByUserId: string | null }) => r.usedByUserId)
      .filter((id: string | null): id is string => Boolean(id));
    const accounts =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
    const byId = new Map(
      accounts.map((u: { id: string; name: string; email: string }) => [u.id, u]),
    );
    // 不回 tokenHash:那是猜 token 的離線比對材料,列表頁不需要。
    // createdByName 要回:admin 看得到全公司的邀請,少了發送者姓名那份清單
    // 只是一堆時間戳,答不出「這條是誰發的」——而那正是 admin 需要它的理由。
    return {
      invites: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        createdById: r.createdById,
        createdByName: r.createdBy?.name ?? null,
        mine: r.createdById === actorId,
      })),
      usedInvites: used.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        usedAt: r.usedAt,
        usedByUserId: r.usedByUserId,
        usedByName: r.usedByUserId ? (byId.get(r.usedByUserId)?.name ?? null) : null,
        usedByEmail: r.usedByUserId ? (byId.get(r.usedByUserId)?.email ?? null) : null,
        createdById: r.createdById,
        createdByName: r.createdBy?.name ?? null,
        mine: r.createdById === actorId,
      })),
    };
  }

  /**
   * 這個人在邀請清單上看得到哪幾條。
   *
   * admin 看全部,訪查主管看自己開的。
   *
   * 原本兩支都寫死 `createdById === actorId`,連 admin 也一樣,結果是
   * 「admin 是最高權限」這個直覺在這裡不成立:主管離職前發出去的連結,
   * admin 在後台既看不到也撤銷不了,而那條連結還能開一個新帳號出來
   * (要等 30 分鐘自己過期,或去停用那位主管的帳號來間接失效)。
   * 帳號安全的最後一道處置權不該只在發送者手上。
   */
  private visibleWhere(actorId: string, role: string | null | undefined) {
    return role === 'admin' ? {} : { createdById: actorId };
  }

  /**
   * 撤銷:把到期時間拉到現在(不刪 row,稽核看得到誰在什麼時候撤的)。
   *
   * admin 撤得掉任何人發出的連結,主管只撤得掉自己發的(見 visibleWhere)。
   * 找不到回 404 而不是 400:全系統其他同類端點(找不到某一筆資源)都是 404,
   * 只有這一支回 400,前端的錯誤處理與監控上的分類會因此把它歸錯類。
   * 「別人的邀請」與「id 不存在」仍然回同一句,不透露 id 有沒有被用過。
   *
   * 已經被用掉的邀請照樣撤得動,而且刻意不改成錯誤:usedAt 一填上去它就已經
   * 失效了(findUsable 帶 usedAt: null),再把 expiresAt 拉到現在是個沒有副作用的
   * no-op。為它多回一種錯誤,反而會讓「這條連結有沒有被用過」從回應上看得出來,
   * 而上面那一句正是為了不透露這件事。所以這裡不 select usedAt —— 撤銷用不到它。
   */
  async revoke(actorId: string, role: string | null | undefined, id: string) {
    this.assertManager(role);
    const invite = await this.prisma.devInvite.findUnique({
      where: { id },
      select: { id: true, createdById: true },
    });
    if (!invite || (role !== 'admin' && invite.createdById !== actorId)) {
      throw new NotFoundException('找不到這條邀請連結');
    }
    await this.prisma.devInvite.update({ where: { id }, data: { expiresAt: new Date() } });
    this.logger.log(`[invite-revoke] ${id} by ${actorId}`);
    return { ok: true };
  }

  /**
   * 公開查詢:連結還能不能用。
   * 無效一律回 { valid: false },不丟 404 —— 回應碼一致,猜 token 的人拿不到區分訊號。
   * 有效時只回邀請人姓名與到期時間,不回 email、id、角色以外的任何東西。
   */
  async check(token: string): Promise<{ valid: boolean; inviterName?: string; expiresAt?: Date }> {
    const invite = await this.findUsable(token);
    if (!invite) return { valid: false };
    return { valid: true, inviterName: invite.createdBy.name, expiresAt: invite.expiresAt };
  }

  private async findUsable(token: string) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) return null;
    const invite = await this.prisma.devInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true,
        createdById: true,
        usedAt: true,
        expiresAt: true,
        createdBy: { select: { name: true, status: true, role: true } },
      },
    });
    if (!invite) return null;
    if (invite.usedAt) return null;
    if (invite.expiresAt.getTime() <= Date.now()) return null;
    // 主管自己被停用了,他發出去的邀請也一併失效
    if (invite.createdBy.status !== 'active') return null;
    // 被降級(不再是訪查主管 / admin)也一樣失效:不然離職前發的連結,
    // 降級之後還能繼續開新帳號,而且新帳號的 managerId 會掛在一個已經沒有帶人的人身上
    if (!INVITER_ROLES.includes(invite.createdBy.role as string)) return null;
    return invite;
  }

  /**
   * 公開接受:建立 role=sales 帳號,managerId 與 departmentId 都跟著發連結的主管。
   * 交易內做「再查一次 token → email 不重複 → 建帳號 → 標記用掉」,
   * 而且標記用掉的 update 帶 usedAt: null 條件 —— 同一條連結被同時送兩次時,
   * 只有一邊的 updateMany 會影響到 1 筆,另一邊整個交易回滾,不會產生兩個帳號(重放)。
   */
  async accept(token: string, dto: AcceptInviteDto) {
    const password = dto.password ?? '';
    if (password.length < INVITE_PASSWORD_MIN || password.length > INVITE_PASSWORD_MAX) {
      throw new BadRequestException(ACCEPT_GENERIC_ERROR);
    }
    const email = normalizeEmail(dto.email);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException(ACCEPT_GENERIC_ERROR);

    const pre = await this.findUsable(token);
    if (!pre) throw new BadRequestException(ACCEPT_GENERIC_ERROR);

    // hash 放交易外:argon2 要幾百毫秒,擺在交易裡會白佔一條連線
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const tokenHash = hashInviteToken(token);
    const now = new Date();

    try {
      const userId = await this.prisma.$transaction(async (tx) => {
        const invite = await tx.devInvite.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            createdById: true,
            usedAt: true,
            expiresAt: true,
            // 發送者現況要在交易內再查一次:findUsable 到這裡之間主管可能剛被停用或降級,
            // 那一瞬間的請求原本會照樣開出帳號,而且 managerId 掛在一個已經不帶人的人身上
            // departmentId 一起查:新帳號要跟著邀請人放進同一個部門(見下面 create)
            createdBy: { select: { status: true, role: true, departmentId: true } },
          },
        });
        if (!invite || invite.usedAt || invite.expiresAt.getTime() <= Date.now()) {
          throw new BadRequestException(ACCEPT_GENERIC_ERROR);
        }
        if (
          invite.createdBy.status !== 'active' ||
          !INVITER_ROLES.includes(invite.createdBy.role as string)
        ) {
          throw new BadRequestException(ACCEPT_GENERIC_ERROR);
        }
        const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
        if (existing) throw new BadRequestException(ACCEPT_GENERIC_ERROR);

        const user = await tx.user.create({
          data: {
            email,
            name,
            mobile: dto.mobile?.trim() || null,
            role: 'sales',
            status: 'active',
            managerId: invite.createdById,
            // 部門跟著邀請人走。只寫 managerId 的話,受邀者不屬於任何部門,
            // 部門樹上看不到他,以部門為範圍的統計與可見範圍判斷也會少算一個人。
            // 邀請人自己沒有部門就維持 null,由管理員後續在使用者管理指定。
            departmentId: invite.createdBy.departmentId,
            passwordHash,
            // 密碼是他自己設的,不必再逼他改一次
            mustChangePassword: false,
          },
          select: { id: true },
        });

        const marked = await tx.devInvite.updateMany({
          where: { id: invite.id, usedAt: null },
          data: { usedAt: now, usedByUserId: user.id },
        });
        // 影響 0 筆 = 另一個併發請求先用掉了,整個交易回滾
        if (marked.count !== 1) throw new BadRequestException(ACCEPT_GENERIC_ERROR);
        return user.id;
      });
      this.logger.log(`[invite-accept] user ${userId}`);
      // 不自動登入:建立帳號與取得 session 是兩件事,讓他走正式登入流程
      return { ok: true };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // email unique 撞車之類的 DB 錯誤也回同一句,不讓錯誤內容變成枚舉管道
      this.logger.warn(`[invite-accept] 失敗:${(e as Error).message}`);
      throw new BadRequestException(ACCEPT_GENERIC_ERROR);
    }
  }
}
