// ref:3687 mc/陳彥輔/米球®
/**
 * 稽核紀錄的「誰在哪裡做的」欄位。
 *
 * audit_logs 有 ip 與 user_agent 兩欄,而且 SSO 登入那一支(entra-audit.service)
 * 一直都有填。刪除與匯出反而沒填 —— 那兩支正好是事後最需要回答
 * 「那份名單是誰在哪裡帶走的」「那批客戶是從哪一台機器刪掉的」的地方,
 * 只有 user_id 的話,帳號被借用或憑證外流時完全查不出第二條線索。
 *
 * 取值方式與 entra.controller 同一套:req.ip(有設 trust proxy 時是真實來源)
 * 取不到就退回 socket 的遠端位址。user_agent 欄位是 varchar(500),超過就截斷,
 * 不要讓一個過長的標頭把整筆稽核寫失敗。
 */
import type { Request } from 'express';

/** audit_logs 的 user_agent 是 varchar(500) */
export const USER_AGENT_MAX = 500;

export interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** 從請求取出稽核用的來源資訊。兩格都可能是 null(內部呼叫、測試) */
export function requestAuditContext(req: Request): AuditContext {
  return {
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: req.get?.('user-agent') ?? null,
  };
}

/** 寫進 audit_logs 之前的正規化:空字串當成沒有,user_agent 截到欄位長度 */
export function auditContextColumns(ctx: AuditContext | undefined): {
  ip: string | null;
  userAgent: string | null;
} {
  const ip = (ctx?.ip ?? '').trim();
  const ua = ctx?.userAgent ?? '';
  return {
    ip: ip.length ? ip : null,
    userAgent: ua.length ? ua.slice(0, USER_AGENT_MAX) : null,
  };
}
