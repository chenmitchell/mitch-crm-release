import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { passwordLengthError } from '@mitchcrm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionUserService } from './session-user.service';
import { LoginAttemptsService } from './login-attempts.service';
import { normalizeEmail } from '../common/email';
import { UserRole, UserStatus } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // 拉平登入時序:帳號不存在/停用時也跑一次 argon2.verify(對這個假雜湊),
  // 讓「帳號存在但密碼錯」與「帳號不存在」耗時一致,擋掉用回應時間差列舉有效帳號。
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  private dummyHashPromise: Promise<string> | null = null;
  private dummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = argon2.hash(randomBytes(16).toString('hex'), {
        type: argon2.argon2id,
      });
    }
    return this.dummyHashPromise;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    // 改密碼之後要把這個人的授權快取清掉,下一個請求一定重查(見 session-user.service.ts)
    private readonly sessionUsers: SessionUserService,
    // 登入失敗鎖定。key 是「帳號 + 來源 IP」,見 login-attempts.service.ts
    private readonly attempts: LoginAttemptsService,
  ) {}

  /**
   * 密碼登入。
   *
   * ── 這一支的每一種失敗都必須長得一模一樣 ────────────────────────
   * 帳號不存在、帳號停用、鎖定中、密碼錯誤,四種情況一律:
   *   狀態碼 401、訊息「帳號或密碼錯誤」、而且都跑過**一次** argon2 驗證。
   * 少任何一項,對外就是一個帳號枚舉的判準。原本鎖定那一條分支同時破了三項
   * (提早 return、另一句訊息、不跑 argon2),六個請求就能問出「這個人在不在
   * 這套系統裡」,理由與實測數字見 login-attempts.service.ts 的檔頭。
   *
   * ip 是計數與鎖定的一部分,由 controller 從 req.ip 帶進來(main.ts 的
   * trust proxy 已經把它換算成真實客戶端位址)。拿不到就用空字串,
   * 那會讓所有來源共用同一個桶子 —— 比「不鎖」保守,是刻意的方向。
   */
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  async login(email: string, password: string, ip = '') {
    // 大小寫與夾帶的空白在進資料庫查詢之前就統一(見 common/email.ts)。
    // 沒有這一行的話,管理員建的 `Alice@Example.com` 用小寫登入永遠失敗,
    // 而訊息跟密碼打錯完全一樣,使用者查不出原因。
    const key = normalizeEmail(email);

    const user = await this.prisma.user.findUnique({ where: { email: key } });
    const locked = this.attempts.isLocked(key, ip);

    /**
     * 通用失敗路徑。三種情況共用:帳號不存在 / 帳號停用 / 這個 IP 對這個帳號鎖定中。
     * 一律跑一次 dummy argon2.verify 把時間拉平到「密碼錯誤」那條路徑的量級,
     * 再丟同一句話。鎖定中的失敗不再往上疊計數(否則鎖定會被無限延長)。
     */
    if (!user || user.status !== UserStatus.active || locked) {
      await argon2.verify(await this.dummyHash(), password).catch(() => undefined);
      // 帳號不存在時也要計數:否則「第幾次才會被鎖」本身又是一個枚舉判準
      if (!locked) this.attempts.registerFailure(key, ip);
      throw new UnauthorizedException('帳號或密碼錯誤');
    }

    const ok = await argon2.verify(user.passwordHash, password);
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    if (!ok) {
      this.attempts.registerFailure(key, ip);
      /**
       * users.failed_login_count 照舊累計,但它已經不是放行與否的依據 ——
       * 那一格現在的用途只有一個:讓管理員在使用者管理頁看得到
       * 「這個帳號最近被打了幾次」。放行由上面那個「帳號 + 來源 IP」的桶子決定,
       * 所以別人從別的 IP 亂打,鎖不到本人。
       * 寫入失敗不能反過來把登入流程弄掛:這只是一個統計數字。
       */
      await this.prisma.user
        .update({
          where: { id: user.id },
          data: { failedLoginCount: { increment: 1 } },
        })
        .catch((e: unknown) => {
          this.logger.warn(`[login] 更新登入失敗次數失敗:${(e as Error).message}`);
        });
      throw new UnauthorizedException('帳號或密碼錯誤');
    }

    // 登入成功:這個人的所有來源 IP 桶子一起清掉,舊的 locked_until 也一併歸零
    this.attempts.clearAccount(key);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
    const accessToken = await this.jwt.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const ok = await argon2.verify(user.passwordHash, currentPassword);
    if (!ok) throw new UnauthorizedException('目前密碼錯誤');

    // 長度規則全系統一份(見 packages/shared/src/password.ts)。
    // 以前這裡是 8、安裝精靈是 12,同一套系統對同一件事有兩種答案。
    const lengthMsg = passwordLengthError(newPassword);
    if (lengthMsg) {
      throw new BadRequestException(`新${lengthMsg}`);
    }
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    if (newPassword === currentPassword) {
      throw new BadRequestException('新密碼不能與目前密碼相同');
    }

    const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    // passwordChangedAt 一起寫:換密碼之前簽出去的權杖從下一個請求開始就不算數
    // (被盜的 cookie 靠「改密碼」就能撤掉,不必換掉全站共用的 JWT_ACCESS_SECRET)。
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });
    this.sessionUsers.invalidate(userId);
    // 換密碼的人自己不該被自己踢出去:舊 cookie 的 iat 已經比 passwordChangedAt 早了,
    // 所以這裡當場重簽一份給呼叫端寫回 cookie。沒有這一步的症狀是
    // 「改完密碼按下一頁就被丟回登入頁」,而使用者剛剛才輸入過兩次密碼。
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword: false,
    } satisfies JwtPayload);
    return { ok: true, accessToken };
  }

  /**
   * 後台「我是誰」用的當前使用者資料。
   * 從 DB 撈,不從 JWT 撈 —— JWT 裡沒有 name,而且姓名/職稱改了要即時反映,
   * 不能等使用者重新登入才更新。
   */
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    return {
      sub: user.id,
      email: user.email,
      name: user.name,
      title: user.title ?? null,
      department: user.department ?? null,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
