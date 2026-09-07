import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ENTRA_DENY_REASON_LABEL, type EntraDenyReason } from './entra-domain';

/**
 * SSO 登入紀錄
 *
 * 每一次 Microsoft 登入(成功與失敗)寫一筆 audit_logs。
 * IT 排錯時這個最有用 —— 使用者只會說「登不進去」,不會說是網域不符還是帳號不存在。
 *
 * 寫進 metadata 的東西刻意受限:
 *   會寫:結果、email、email 網域、失敗原因分類、當下的允許網域清單、
 *         身分取自哪一個 claim、claim 網域是否不一致
 *   不寫:client secret、authorization code、access/id token、code_verifier、nonce
 *         —— 這些一旦落地就等於把「可重放的憑證」寫進一張 admin 看得到的表。
 *
 * 不動 schema:用既有的 audit_logs(action / ip / user_agent / metadata / user_id)。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

export const ENTRA_AUDIT_ACTION_SUCCESS = 'auth.entra.login';
export const ENTRA_AUDIT_ACTION_DENIED = 'auth.entra.denied';

export interface EntraAuditContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface EntraAuditInput extends EntraAuditContext {
  result: 'success' | 'denied';
  /** 登入用的 email;取不到 claim 時為 null */
  email?: string | null;
  /** 失敗原因分類(成功時不填) */
  reason?: EntraDenyReason;
  /** 對到的本系統使用者 id(對不到就 null,audit_logs.user_id 有 FK) */
  userId?: string | null;
  /** 額外情境:身分取自哪個 claim、當下允許網域等 */
  detail?: Record<string, unknown>;
}

/**
 * findMany 回來的原始列型別。
 * 明寫出來的理由:map 的參數不寫型別時,型別檢查在「Prisma client 尚未 generate」
 * 的環境(CI / 容器內沒網路)會退化成 implicit any 而報 TS7006。
 */
interface RawEntraAuditRow {
  id: bigint | number | string;
  action: string;
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface EntraLoginLogRow {
  id: string;
  result: 'success' | 'denied';
  email: string | null;
  emailDomain: string | null;
  reason: string | null;
  reasonLabel: string | null;
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

@Injectable()
export class EntraAuditService {
  private readonly logger = new Logger(EntraAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 寫一筆登入紀錄。
   * 刻意吞掉自己的例外:記錄失敗不可以反過來把登入流程弄掛,
   * 也不可以在成功登入後才丟例外害使用者看到錯誤頁。
   */
  async record(input: EntraAuditInput): Promise<void> {
    const email = normalizeForLog(input.email);
    const emailDomain = email ? (email.split('@').pop() ?? null) : null;
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId ?? null,
          action:
            input.result === 'success' ? ENTRA_AUDIT_ACTION_SUCCESS : ENTRA_AUDIT_ACTION_DENIED,
          ip: input.ip ?? null,
          userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
          metadata: {
            result: input.result,
            email,
            emailDomain,
            reason: input.reason ?? null,
            reasonLabel: input.reason ? ENTRA_DENY_REASON_LABEL[input.reason] : null,
            ...(input.detail ?? {}),
          } as object,
        },
      });
    } catch (e) {
      this.logger.error(`[entra-audit] 寫入登入紀錄失敗:${(e as Error).message}`);
    }
  }

  /** 後台「單一登入設定」頁的最近登入紀錄 */
  async list(limit = 50): Promise<EntraLoginLogRow[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { in: [ENTRA_AUDIT_ACTION_SUCCESS, ENTRA_AUDIT_ACTION_DENIED] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        userId: true,
        ip: true,
        userAgent: true,
        metadata: true,
        createdAt: true,
      },
    });

    return rows.map((r: RawEntraAuditRow) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const { email, emailDomain, reason, reasonLabel } = meta;
      // detail = metadata 扣掉上面這幾個已經有專屬欄位的鍵
      const detail: Record<string, unknown> = { ...meta };
      for (const k of ['result', 'email', 'emailDomain', 'reason', 'reasonLabel']) {
        delete detail[k];
      }
      return {
        // audit_logs.id 是 BigInt,JSON.stringify 會直接丟例外,一定要轉字串
        id: String(r.id),
        result: r.action === ENTRA_AUDIT_ACTION_SUCCESS ? 'success' : 'denied',
        email: typeof email === 'string' ? email : null,
        emailDomain: typeof emailDomain === 'string' ? emailDomain : null,
        reason: typeof reason === 'string' ? reason : null,
        reasonLabel: typeof reasonLabel === 'string' ? reasonLabel : null,
        userId: r.userId,
        ip: r.ip,
        userAgent: r.userAgent,
        detail,
        createdAt: r.createdAt,
      } satisfies EntraLoginLogRow;
    });
  }
}

/** email 進 log 前的整理:小寫、去空白、長度上限(避免超長字串塞爆 JSONB) */
function normalizeForLog(email: string | null | undefined): string | null {
  if (!email) return null;
  const v = email.trim().toLowerCase();
  return v ? v.slice(0, 320) : null;
}
