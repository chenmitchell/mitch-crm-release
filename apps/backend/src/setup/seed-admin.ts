// ref:3687 mc/陳彥輔/米球®
/**
 * 啟動時自動建立第一個管理員。
 *
 * 為什麼要有這一支:有些部署平台沒有「跑一次性 job」這種東西 —— 服務就是服務,
 * 起來之後只有一個長駐程序,沒有地方讓人下一句 seed 指令。那種平台上,
 * 空資料庫的自架者拿到的是一個「登入頁打得開、但沒有任何帳號可以登入」的系統,
 * 而且畫面上完全看不出原因。
 *
 * 邊界(這支沒有任何人在旁邊看,所以邊界要嚴):
 *   1. **只在 users 表一個人都沒有的時候動作**。有任何一位使用者就整段跳過,
 *      連查密碼都不查 —— 這支永遠不可能覆寫既有帳號或改密碼。
 *   2. SEED_ADMIN_EMAIL 與 SEED_ADMIN_PASSWORD **兩個都有值**才建立。
 *      沒設就什麼都不做,讓人走 /setup 安裝精靈(那條路徑的密碼是本人當場輸入的,
 *      比環境變數裡的密碼安全)。
 *   3. 建好之後標記 mustChangePassword:環境變數裡的密碼會留在平台的設定畫面、
 *      部署紀錄與 log 裡,不能當成長期密碼用。啟動 log 也會再喊一次。
 *   4. 任何失敗都只記錄不中斷啟動:資料庫還沒就緒時把整個服務擋下來,
 *      只會把「還沒有帳號」變成「服務起不來」,後者更難查。
 */
import { Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PASSWORD_MIN } from '@mitchcrm/shared';
import { normalizeEmail } from '../common/email';

/** 這支只需要 users 表的三個動作,不綁死 PrismaService 的完整型別,測試好接 */
export interface SeedAdminDb {
  user: {
    count(args?: unknown): Promise<number>;
    create(args: { data: Record<string, unknown>; select?: unknown }): Promise<{ id: string }>;
  };
}

export interface SeedAdminEnv {
  SEED_ADMIN_EMAIL?: string;
  SEED_ADMIN_PASSWORD?: string;
}

export type SeedAdminOutcome =
  'created' | 'skipped_existing_users' | 'skipped_no_password' | 'failed';

/**
 * SEED_ADMIN_PASSWORD 的長度下限。跟安裝精靈、邀請註冊、改密碼同一組規則
 * (packages/shared/src/password.ts):這一支建的是權限最大的第一個帳號,
 * 沒有理由比後面建立的帳號寬鬆。
 */
export const SEED_ADMIN_PASSWORD_MIN = PASSWORD_MIN;

/** 建好之後要在 log 上講的那一句。抽出來是為了測試釘得住訊息本身 */
export function seedAdminCreatedMessage(email: string): string {
  return (
    `[seed-admin] 已建立初始管理員 ${email}。` +
    '這組密碼來自環境變數,會留在部署平台的設定畫面與紀錄裡,請立刻登入後修改密碼。' +
    '(已標記為「下次登入必須改密碼」)'
  );
}

/**
 * 需要的話建立第一個管理員。回傳這次做了什麼,呼叫端不必解讀例外。
 */
export async function ensureSeedAdmin(
  db: SeedAdminDb,
  env: SeedAdminEnv,
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('SeedAdmin'),
): Promise<SeedAdminOutcome> {
  const email = normalizeEmail(env.SEED_ADMIN_EMAIL);
  const password = env.SEED_ADMIN_PASSWORD ?? '';

  try {
    // 先看有沒有人。有人就整段跳過,連環境變數都不必判斷 ——
    // 這一段的存在前提就是「資料庫是空的」。
    const existing = await db.user.count();
    if (existing > 0) return 'skipped_existing_users';

    if (!email || !password) {
      logger.log(
        '[seed-admin] 資料庫裡還沒有任何使用者,而且沒有設 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD,' +
          '所以不自動建立帳號。請用瀏覽器打開前端的 /setup 走安裝精靈。',
      );
      return 'skipped_no_password';
    }
    if (password.length < SEED_ADMIN_PASSWORD_MIN) {
      logger.warn(
        `[seed-admin] SEED_ADMIN_PASSWORD 太短(至少 ${SEED_ADMIN_PASSWORD_MIN} 個字元),這次不建立帳號。`,
      );
      return 'failed';
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await db.user.create({
      data: {
        email,
        name: email.split('@')[0] || '系統管理員',
        passwordHash,
        role: 'admin',
        status: 'active',
        // 環境變數裡的密碼不是本人選的,也留在平台紀錄裡,所以強制改
        mustChangePassword: true,
      },
      select: { id: true },
    });
    logger.log(seedAdminCreatedMessage(email));
    return 'created';
  } catch (err) {
    // 訊息只記型別,不把資料庫回傳的細節寫進 log
    const kind = err instanceof Error ? err.name : 'UnknownError';
    logger.warn(`[seed-admin] 初始管理員沒有建立成功(${kind}),請改走 /setup 安裝精靈`);
    return 'failed';
  }
}
