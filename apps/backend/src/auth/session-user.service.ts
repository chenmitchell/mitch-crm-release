// ref:3687 mc/陳彥輔/米球®
/**
 * 「這個權杖現在還算不算數」的唯一判斷點。
 *
 * 原本 JwtStrategy.validate 只是 `return payload`,整個授權完全以權杖內容為準,
 * 從不回頭看資料庫。實際後果是管理者按下「停用」之後什麼都沒發生:那個人的 cookie
 * 照樣打得動每一支 API,而且滑動續期每四小時用「舊的角色」重簽一份新的八小時權杖,
 * 只要他偶爾碰一下系統,權限就永遠不會結束。降級、重設密碼同理。
 * 當時唯一能真的把人踢下線的辦法是換掉 JWT_ACCESS_SECRET,那會讓全公司一起登出。
 *
 * ── 為什麼選「每次請求回查資料庫」而不是只加一格 sessionsValidAfter ──
 * 兩種做法都能解掉停用。差別在維護成本與漏掉的風險:
 *   sessionsValidAfter 是「事件驅動」的,停用、降級、改密碼、改角色每一個寫入點
 *   都要記得去更新那一格。少寫一處不會有任何錯誤訊息,只會安靜地留下一條沒被撤銷的
 *   session,而那正是這次審查抓到的那一類問題。
 *   回查資料庫是「狀態驅動」的:status 與 role 現在的值就是真相,不管是誰、
 *   從哪一支端點改的,下一個請求就生效,日後新增改角色的路徑也不必回來加程式。
 * 所以主線走回查。
 *
 * 密碼是唯一一件回查看不出來的事 —— 舊權杖裡沒有任何欄位會因為換密碼而改變,
 * 所以另外加了 users.password_changed_at,拿權杖的 iat 去比。這一格只在
 * 「改密碼 / 重設密碼」兩個寫入點更新,兩處都在本 repo 內、都有測試釘住。
 *
 * ── 成本 ──
 * 照 AccessScopeService 的做法放一份短時的行程內快取(同一個 TTL 常數口徑)。
 * 一個後台頁面連打十幾支 API 只會查一次 users。停用 / 降級 / 改密碼這些寫入點會
 * 主動 invalidate(單一 instance 立刻生效);多 instance 部署時,沒收到 invalidate 的
 * 那幾台最多晚 TTL 這麼久,那是可以接受的上限,而不是「永遠不會結束」。
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { UserRole } from '@prisma/client';

/** 行程內快取的存活時間。與 AccessScopeService 的組織樹快取同一個口徑 */
export const SESSION_USER_CACHE_TTL_MS = 10_000;

/** 授權要用到的最小欄位。刻意不整列撈,少一個欄位就少一個外洩面 */
export interface SessionUserRow {
  id: string;
  email: string;
  role: UserRole;
  status: string;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
}

@Injectable()
export class SessionUserService {
  private readonly cache = new Map<string, { row: SessionUserRow | null; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** 停用 / 改角色 / 改密碼之後呼叫,讓下一個請求一定重查 */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** 測試與「全部重來」用 */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * 撈這個人現在的狀態。查不到就是查不到(回 null),不要回一個假的預設值 ——
   * 帳號被刪掉時應該 401,不是以權杖裡的角色繼續放行。
   */
  async find(userId: string, nowMs: number = Date.now()): Promise<SessionUserRow | null> {
    const hit = this.cache.get(userId);
    if (hit && nowMs - hit.at < SESSION_USER_CACHE_TTL_MS) return hit.row;

    const row = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        mustChangePassword: true,
        passwordChangedAt: true,
      },
    })) as SessionUserRow | null;

    // 查不到也要快取,否則拿著已刪帳號的權杖狂打就是每個請求一次 DB 查詢
    this.cache.set(userId, { row, at: nowMs });
    return row;
  }
}

/**
 * 權杖的簽發時間是不是早於密碼變更時間。
 *
 * iat 是 Unix 秒(整數),passwordChangedAt 是毫秒精度,同一秒內換密碼再簽的權杖
 * 會因為秒級截斷而看起來「比較早」。所以比對時給密碼變更時間往前一秒的寬容,
 * 寧可少擋一秒內的邊界,也不要讓剛換完密碼的人自己被踢出去。
 */
export function issuedBeforePasswordChange(
  iat: number | undefined,
  passwordChangedAt: Date | null | undefined,
): boolean {
  if (!passwordChangedAt) return false;
  if (typeof iat !== 'number') return true; // 讀不到 iat 就無法證明它比較新,從嚴
  return iat * 1000 < passwordChangedAt.getTime() - 1000;
}
// ref:3687 mc/陳彥輔/米球®
