import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { loadEnv } from '../common/env';
import type { JwtPayload } from './auth.service';
import {
  SessionUserService,
  issuedBeforePasswordChange,
  type SessionUserRow,
} from './session-user.service';

const env = loadEnv();

function fromCookie(req: Request): string | null {
  return req?.cookies?.mc_session ?? null;
}

/** 通過守衛之後掛在 req.user 上的東西:權杖的時間戳 + 資料庫現在的角色與狀態 */
export type AuthedUser = JwtPayload & { iat?: number; exp?: number };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly sessionUsers: SessionUserService) {
    super({
      jwtFromRequest: fromCookie,
      ignoreExpiration: false,
      secretOrKey: env.JWT_ACCESS_SECRET,
      // 明確鎖對稱演算法,擋掉日後若改用非對稱金鑰可能被 alg confusion 攻擊的路。
      // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      algorithms: ['HS256'],
    });
  }

  /**
   * 簽章對了只代表「這份權杖是我們發的」,不代表「這個人現在還能用」。
   *
   * 原本這裡是 `return payload`,角色、帳號狀態、帳號是否存在一律以權杖內容為準。
   * 那讓「停用帳號」這個管制手段實際上停不掉任何人:被停用、被降級、被重設密碼的
   * 那份 cookie 在效期內照樣通行,而滑動續期還會拿它原本的角色重簽一份新的,
   * 只要偶爾碰一下系統就永遠不會過期(離職者、被盜帳號、被降級的前管理者)。
   *
   * 所以每一個請求都回查一次 users(帶短時快取,見 session-user.service.ts):
   *   - 查不到          → 帳號被刪了,401
   *   - status 非 active → 被停用了,401
   *   - iat 早於密碼變更 → 改密碼 / 重設密碼之前發的權杖,401
   * 通過的話,role 與 mustChangePassword 一律以**資料庫**的值覆蓋權杖裡的值,
   * 降級的人下一個請求拿到的就是新角色,而不是他登入當下那一個。
   */
  async validate(payload: JwtPayload & { iat?: number; exp?: number }): Promise<AuthedUser> {
    const user: SessionUserRow | null = payload?.sub
      ? await this.sessionUsers.find(payload.sub)
      : null;
    if (!user) throw new UnauthorizedException('登入狀態已失效,請重新登入');
    if (user.status !== 'active') throw new UnauthorizedException('帳號已停用');
    if (issuedBeforePasswordChange(payload.iat, user.passwordChangedAt)) {
      throw new UnauthorizedException('密碼已變更,請重新登入');
    }

    return {
      ...payload,
      email: user.email,
      // 權杖裡的 role 只是簽發當下的快照,一律以資料庫為準
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
