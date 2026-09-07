import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { getEnv, isEntraConfigured } from '../common/env';
import { normalizeEmail } from '../common/email';
import { UserRole, UserStatus } from '@prisma/client';
import type { JwtPayload } from './auth.service';
import { EntraConfigService } from './entra-config.service';
import { EntraAuditService, type EntraAuditContext } from './entra-audit.service';
import { GraphProfileService } from './graph-profile.service';
import { SettingsService, type M365DirectoryEntry } from '../settings/settings.service';
import { SessionUserService } from './session-user.service';
import {
  isDomainAllowed,
  pickLoginIdentity,
  hasDomainDisagreement,
  extractDomain,
  type EntraDenyReason,
} from './entra-domain';

/**
 * Microsoft Entra ID(舊名 Azure AD)單一登入
 *
 * 走 OAuth 2.0 授權碼流程 + PKCE,client 端是機密用戶端(有 client secret)。
 *
 * ★ 為什麼不自己驗 id_token 簽章
 *   id_token 是後端直接向 Microsoft 的 token endpoint 用 TLS 拿回來的(back-channel),
 *   不是從瀏覽器轉手過來的。OIDC Core §3.1.3.7 明講這種情況可以不驗簽章。
 *   自己驗簽要多一個 JWKS 快取 + 輪替處理,那是額外一整組會壞掉的東西。
 *   我們改成驗這四項:tid(租用戶)、aud(自己的 client id)、exp、nonce。
 *
 * ★ 帳號怎麼對上
 *   用 email / UPN 去 users 表找,不新增資料庫欄位(不用 migration)。
 *   email 理論上可以被改指到別人身上,所以正式上線後值得再加一個
 *   entra_object_id 欄位鎖住 oid —— 那是下一階段的事,寫在 docs/設定說明.md。
 *   取哪一個 claim 當身分、網域怎麼比,規則集中在 entra-domain.ts(有單元測試)。
 *
 * ★ 預設不自動開帳號
 *   預設 false。目錄裡的人不等於可以看客戶資料的人。
 *   這個開關與允許網域清單現在都可以在後台「單一登入設定」改(存 system_settings id=3),
 *   DB 有值就以 DB 為準,沒有才 fallback 到 ENTRA_AUTO_PROVISION / ENTRA_ALLOWED_DOMAINS。
 *
 * ★ 每次登入都留紀錄
 *   成功與失敗都寫 audit_logs(EntraAuditService),含結果、email、失敗原因分類、IP、UA。
 *   IT 排錯只靠使用者口述「登不進去」是查不出東西的。
 */

const AUTH_HOST = 'https://login.microsoftonline.com';
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

/**
 * 一定要的 scope。
 * User.Read 是應用程式註冊時預設就有的委派權限(使用者自己同意即可,
 * 不需要系統管理員),沒有它就打不了 Microsoft Graph 的 /me,
 * 也就拿不到職稱與部門 —— id_token 裡沒有那些欄位。
 */
const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];

/**
 * 讀主管才需要的 scope。**要系統管理員同意**,而且範圍是全租用戶所有人的資料。
 * 只有後台把「同步主管」打開時才加進去:沒同意就要這個 scope,
 * 使用者會卡在「需要系統管理員同意」的畫面,連登入都進不來。
 */
const MANAGER_SCOPE = 'User.Read.All';

/** users 表的欄位長度上限(schema:name VarChar(100),title / phone / mobile VarChar(40)) */
const USER_NAME_MAX = 100;
const USER_SHORT_MAX = 40;

export interface EntraStartResult {
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

interface EntraIdTokenClaims {
  aud?: string;
  tid?: string;
  exp?: number;
  nonce?: string;
  oid?: string;
  email?: string;
  preferred_username?: string;
  upn?: string;
  name?: string;
}

/**
 * 帶著失敗原因分類的登入錯誤。
 * 訊息仍然是給使用者看的中文,reason 是給 audit_logs 與後台清單用的機器碼。
 */
export class EntraLoginError extends UnauthorizedException {
  constructor(
    message: string,
    readonly reason: EntraDenyReason,
  ) {
    super(message);
  }
}

@Injectable()
export class EntraService {
  private readonly logger = new Logger(EntraService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: EntraConfigService,
    private readonly audit: EntraAuditService,
    private readonly graph: GraphProfileService,
    private readonly settings: SettingsService,
    private readonly sessionUsers: SessionUserService,
  ) {}

  isEnabled(): boolean {
    return isEntraConfigured();
  }

  /**
   * 產生導向 Microsoft 的網址,同時吐出要寫進 cookie 的 state / verifier / nonce。
   *
   * 變成 async 是因為 scope 現在跟後台設定有關:「同步主管」開了才要 User.Read.All。
   * 授權要的 scope 與換 token 時送的 scope 必須一致,所以兩邊都走 buildScope()。
   */
  async buildAuthorizeUrl(): Promise<EntraStartResult> {
    const env = getEnv();
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('Microsoft 登入尚未設定');
    }
    const cfg = await this.config.getEffectiveConfig();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const params = new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID as string,
      response_type: 'code',
      redirect_uri: env.ENTRA_REDIRECT_URI as string,
      response_mode: 'query',
      scope: buildScope(cfg.syncManager),
      // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      authorizeUrl: `${AUTH_HOST}/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`,
      state,
      codeVerifier,
      nonce,
    };
  }

  /**
   * 拿 code 換 token、驗 claims、對到 users 表,回傳可以簽進 cookie 的 session。
   * ctx 只用來寫登入紀錄(IP / UA),不影響任何判斷。
   */
  async completeLogin(
    code: string,
    codeVerifier: string,
    expectedNonce: string,
    ctx: EntraAuditContext = {},
  ) {
    const env = getEnv();
    if (!this.isEnabled()) {
      await this.audit.record({ ...ctx, result: 'denied', reason: 'not_configured' });
      throw new ServiceUnavailableException('Microsoft 登入尚未設定');
    }

    const cfg = await this.config.getEffectiveConfig();

    const body = new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID as string,
      client_secret: env.ENTRA_CLIENT_SECRET as string,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.ENTRA_REDIRECT_URI as string,
      code_verifier: codeVerifier,
      scope: buildScope(cfg.syncManager),
    });

    const res = await fetch(`${AUTH_HOST}/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      // Microsoft 回的錯誤內文可能含 client_secret 相關訊息,只留錯誤碼進 log
      const detail = (await res.text()).slice(0, 300);
      const aadCode = detail.match(/AADSTS\d+/)?.[0] ?? null;
      this.logger.error(`[entra] token exchange failed status=${res.status} detail=${detail}`);
      // 只把 AADSTS 錯誤碼寫進紀錄,原始回應內文不落地(可能含機敏資訊)
      await this.audit.record({
        ...ctx,
        result: 'denied',
        reason: 'token_exchange_failed',
        detail: { httpStatus: res.status, aadCode },
      });
      throw new EntraLoginError(
        'Microsoft 登入失敗,請再試一次或改用密碼登入',
        'token_exchange_failed',
      );
    }

    const tokenSet = (await res.json()) as { id_token?: string; access_token?: string };
    if (!tokenSet.id_token) {
      await this.audit.record({ ...ctx, result: 'denied', reason: 'no_id_token' });
      throw new EntraLoginError('Microsoft 未回傳 id_token', 'no_id_token');
    }

    let claims: EntraIdTokenClaims;
    try {
      claims = decodeJwtPayload<EntraIdTokenClaims>(tokenSet.id_token);
    } catch (e) {
      await this.audit.record({ ...ctx, result: 'denied', reason: 'malformed_id_token' });
      throw e;
    }

    // 身分先取出來,後面每一種失敗都要能記下「是誰登不進去」
    const identity = pickLoginIdentity(claims);
    const email = identity.loginEmail;
    const baseDetail: Record<string, unknown> = {
      claimSource: identity.source,
      allowedDomains: cfg.allowedDomains,
      allowedDomainsSource: cfg.allowedDomainsSource,
      ...(hasDomainDisagreement(identity.claimDomains)
        ? { claimDomains: identity.claimDomains, claimDomainMismatch: true }
        : {}),
    };

    const deny = async (
      reason: EntraDenyReason,
      message: string,
      extra?: Record<string, unknown>,
    ) => {
      await this.audit.record({
        ...ctx,
        result: 'denied',
        reason,
        email,
        detail: { ...baseDetail, ...(extra ?? {}) },
      });
      return new EntraLoginError(message, reason);
    };

    if (claims.tid !== env.ENTRA_TENANT_ID) {
      this.logger.warn(`[entra] tenant 不符 got=${claims.tid ?? '(none)'}`);
      throw await deny('tenant_mismatch', '這個帳號不屬於公司的 Microsoft 租用戶', {
        gotTenant: claims.tid ?? null,
      });
    }
    if (claims.aud !== env.ENTRA_CLIENT_ID) {
      throw await deny('audience_mismatch', 'id_token 的 aud 不符');
    }
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
      throw await deny('token_expired', 'Microsoft 回傳的憑證已過期,請重新登入');
    }
    if (claims.nonce !== expectedNonce) {
      throw await deny('nonce_mismatch', '登入流程驗證失敗(nonce 不符),請重新開始');
    }

    if (!email) {
      throw await deny('no_email_claim', 'Microsoft 帳號沒有可用的 email');
    }

    /**
     * 來賓帳號一律擋。tid 檢查擋不掉他們 —— 外部人員被邀請進本租用戶後,
     * id_token 的 tid 就是本租用戶。詳見 entra-domain.ts 規則二。
     */
    if (identity.isGuest) {
      this.logger.warn('[entra] 來賓帳號(#EXT#)嘗試登入,已拒絕');
      throw await deny('guest_account', '來賓帳號不能登入本系統,請用公司的 Microsoft 帳號');
    }

    /**
     * 網域比對。清單為空 = 不限網域(仍要求帳號存在或開了自動建帳號),
     * 這件事後台會用警告標示,不會靜靜放行。
     */
    if (!isDomainAllowed(email, cfg.allowedDomains)) {
      this.logger.warn(`[entra] 網域不在允許清單 domain=${extractDomain(email)}`);
      throw await deny('domain_not_allowed', '這個網域的帳號不能登入本系統');
    }

    const user = await this.findOrProvision(
      email,
      claims.name ?? email,
      cfg.autoProvision,
      { departmentId: cfg.defaultDepartmentId, managerId: cfg.defaultManagerId },
      () =>
        deny(
          'user_not_found',
          '你的 Microsoft 帳號還沒有本系統的使用權限,請先請系統管理員建立帳號',
        ),
    );

    if (user.status !== UserStatus.active) {
      throw await deny('user_disabled', '帳號已停用,請聯絡系統管理員', { userId: user.id });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // 記下這個人在 M365 的信箱,方便日後對帳
        m365Email: user.m365Email ?? email,
        /**
         * SSO 登入成功就把「必須改本機密碼」關掉。
         *
         * 為什麼一定要寫這一格,而不是只在權杖裡寫 false:
         * 底下簽出去的 payload 與回傳的 user 都寫 mustChangePassword: false
         * (「走 SSO 就不必再逼他改本機密碼」),但 MustChangePasswordGuard 與
         * /api/auth/me 讀的都是**資料庫**現在的值,不是權杖裡的快照 —— 而那是刻意的,
         * 否則改完密碼的人要重新登入才不會被擋。
         * 而 UsersService.create() 對管理員手動建立的每一個帳號都寫
         * mustChangePassword: true,ENTRA_AUTO_PROVISION 預設又是 false
         * (查無帳號時的訊息就是「請先請系統管理員建立帳號」),
         * 所以**預設的 SSO 上線流程產出的每一個帳號,DB 這一格都是 true**。
         * 不清的話,這個人 Microsoft 登入成功之後:
         *   全站業務 API 403「請先變更密碼」,admin/layout 把他導到改密碼頁,
         *   而那一頁要求填「目前密碼」—— 他走的是 SSO,從來沒拿到過本機密碼。
         * 唯一的出口需要一個他沒有的東西,等於進不去也出不來。
         *
         * 代價寫清楚:管理員建帳號時配發的臨時密碼,在這之後不會再被強制換掉
         * (它仍然可以走 /api/auth/login)。要徹底關掉那條路的做法是「這個帳號
         * 只能走 SSO」,那是另一個功能(自動建帳號那一段就是這樣做的:隨機密碼),
         * 不在這道修正的範圍內。
         */
        mustChangePassword: false,
      },
    });
    /**
     * 授權用的那份 10 秒快取要立刻失效。
     * 不清的話,剛才被 403 擋下來的那次請求已經把 mustChangePassword: true 讀進快取,
     * 使用者走完 SSO 回來的前幾秒仍然會被擋 —— 症狀是「登入成功了還是叫我改密碼」。
     */
    this.sessionUsers.invalidate(user.id);

    /**
     * 組織資料同步。放在這裡(登入已經確定成功之後)是刻意的:
     * 不管它成功還是失敗,上面那行 lastLoginAt 都已經寫進去了,
     * 這個人已經是「登入成功」的狀態,後面只是錦上添花。
     */
    const orgSync = await this.syncOrganizationProfile(
      user.id,
      tokenSet.access_token ?? null,
      cfg.syncManager,
    );

    await this.audit.record({
      ...ctx,
      result: 'success',
      email,
      userId: user.id,
      detail: {
        ...baseDetail,
        role: user.role,
        unrestrictedDomain: cfg.allowedDomains.length === 0,
        // 這次有沒有同步到組織資料。只記結果分類,不記任何欄位值,
        // 更不記 access token(audit_logs 是 admin 看得到的表)
        m365Sync: orgSync,
      },
    });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      // 走 SSO 就不必再逼他改本機密碼
      mustChangePassword: false,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: false,
      },
    };
  }

  /**
   * 把 Microsoft Graph 上的組織資料同步進本系統。
   *
   * ★ 這支永遠不丟例外,回傳值只是給 audit 記錄用的分類
   *   'ok'       同步成功
   *   'degraded' Graph 打不通 / 沒權限 / 逾時 → 登入照樣成功,資料維持上一次的值
   *   'no_token' Microsoft 這次沒回 access_token(理論上不會,但不能假設)
   *   'error'    寫回資料庫時出錯 → 一樣不影響登入
   *
   * ★ 哪些欄位會被 Entra 蓋掉、哪些不會
   *   會蓋:name / title / phone / mobile —— 這些的真相來源是公司通訊錄,
   *        組織異動後應該自動跟上,這正是「把 M365 組織資料帶進來」的目的。
   *        但只有 Graph 真的有值才蓋:Graph 沒填的欄位不會把既有值清成空的。
   *   不蓋:role / status —— 權限是系統管理員在後台的決定,與 AD 上的職稱無關。
   *        「目錄上是經理」不等於「可以看別人負責的客戶」。
   *   users 表沒有的(部門 / 辦公室 / 員工編號 / 主管)存 system_settings id=4:
   *   那幾格只拿來顯示,可見範圍走的是 users.manager_id 與 users.department_id
   *   兩個真欄位,所以不值得為它們在 users 表加欄位。理由與代價寫在
   *   users/users.service.ts 讀這一包的那一段。
   */
  private async syncOrganizationProfile(
    userId: string,
    accessToken: string | null,
    syncManager: boolean,
  ): Promise<'ok' | 'degraded' | 'no_token' | 'error'> {
    if (!accessToken) {
      this.logger.warn('[entra] token 回應沒有 access_token,這次不同步組織資料');
      return 'no_token';
    }

    try {
      const profile = await this.graph.fetchMe(accessToken);
      if (!profile) {
        // Graph 掛了不是登入失敗。留一個時間戳,後台看得出「這筆是舊資料」
        await this.settings.upsertM365DirectoryEntry(userId, {
          lastFailedAt: new Date().toISOString(),
        });
        return 'degraded';
      }

      const manager = syncManager ? await this.graph.fetchManager(accessToken) : null;

      // users 表:只寫 Graph 真的有值的欄位,而且截到欄位長度上限。
      // 不截的話,一個超過 40 字的職稱會讓 update 直接丟例外 —— 那就變成
      // 「AD 上改了職稱之後這個人再也登不進來」,是最糟的一種耦合。
      const userPatch: Record<string, string> = {};
      if (profile.displayName) userPatch.name = profile.displayName.slice(0, USER_NAME_MAX);
      if (profile.jobTitle) userPatch.title = profile.jobTitle.slice(0, USER_SHORT_MAX);
      if (profile.businessPhone) userPatch.phone = profile.businessPhone.slice(0, USER_SHORT_MAX);
      if (profile.mobilePhone) userPatch.mobile = profile.mobilePhone.slice(0, USER_SHORT_MAX);
      if (Object.keys(userPatch).length > 0) {
        await this.prisma.user.update({ where: { id: userId }, data: userPatch });
      }

      const entry: M365DirectoryEntry = {
        jobTitle: profile.jobTitle,
        department: profile.department,
        officeLocation: profile.officeLocation,
        mobilePhone: profile.mobilePhone,
        businessPhone: profile.businessPhone,
        employeeId: profile.employeeId,
        syncedAt: new Date().toISOString(),
      };
      if (manager) {
        entry.managerName = manager.displayName;
        entry.managerEmail = manager.mail;
      }
      await this.settings.upsertM365DirectoryEntry(userId, entry);
      return 'ok';
    } catch (e) {
      // 寫 DB 失敗也不能反過來把已經成功的登入弄掛
      this.logger.error(`[entra] 組織資料同步失敗(登入不受影響):${(e as Error).message}`);
      return 'error';
    }
  }

  /**
   * email 先比 users.email,再比 users.m365Email;都沒有才看要不要自動開帳號。
   * autoProvision 由呼叫端算好帶進來(DB 設定優先於 env),
   * onNotFound 讓呼叫端決定怎麼記錄與丟出錯誤,這裡不重複寫 audit 邏輯。
   *
   * ★ 第三次查詢(忽略大小寫)是必要的,不是保險。
   *   claims 的 email 一律被 pickLoginIdentity 轉成小寫,而 users.email 是
   *   **區分大小寫**的唯一索引。使用者管理以前沒有正規化,所以既有資料庫裡可能
   *   躺著 `Alice@Example.com` 這種列。只比前兩次的話那一列永遠對不上,
   *   而 autoProvision 開著時的後果不是「登入失敗」,是**再開一個全新的 active 帳號**:
   *   管理員把 `Alice@Example.com` 停用之後,她走 Microsoft 登入仍然拿得到可用帳號,
   *   「停用」這個管制在這條路徑上就失效了。
   *   新資料由 common/email.ts 的正規化擋住,舊資料靠這一次查詢接住。
   */
  private async findOrProvision(
    rawEmail: string,
    displayName: string,
    autoProvision: boolean,
    defaults: { departmentId: string | null; managerId: string | null },
    onNotFound: () => Promise<Error>,
  ) {
    const email = normalizeEmail(rawEmail);
    const existing =
      (await this.prisma.user.findUnique({ where: { email } })) ??
      (await this.prisma.user.findFirst({ where: { m365Email: email } })) ??
      (await this.prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: email, mode: 'insensitive' } },
            { m365Email: { equals: email, mode: 'insensitive' } },
          ],
        },
      }));
    if (existing) return existing;

    if (!autoProvision) {
      this.logger.warn(`[entra] 查無此帳號 email=${email}(未開自動建帳號)`);
      throw await onNotFound();
    }

    // 自動開的帳號一律 sales + 隨機密碼(等於停用密碼登入,只能走 SSO)
    const randomPassword = randomBytes(32).toString('base64url');
    const argon2 = await import('argon2');
    // 組織歸屬:兩欄都空著的帳號對所有主管都是隱形的(理由見 SsoSettingsData 的說明),
    // 所以套用後台設定的預設值。指到的部門或主管已經被刪掉時當成沒設定 ——
    // 寫一個對不到的外鍵會讓整個登入失敗,那比少一個部門糟得多。
    const orgDefaults = await this.resolveProvisionDefaults(defaults);
    return this.prisma.user.create({
      data: {
        email,
        m365Email: email,
        name: displayName,
        passwordHash: await argon2.hash(randomPassword, { type: argon2.argon2id }),
        role: UserRole.sales,
        status: UserStatus.active,
        mustChangePassword: false,
        departmentId: orgDefaults.departmentId,
        managerId: orgDefaults.managerId,
      },
    });
  }

  /**
   * 把後台設定的預設部門 / 預設主管換成「現在真的存在」的值。
   *
   * 為什麼要重查:這兩個值是後台某一天存下來的主鍵,部門可以被刪、主管可以被停用或刪掉,
   * 而 system_settings 裡那一格不會跟著清空。不查就直接寫進 user.create 的話,
   * 症狀是「某一天開始所有人的 Microsoft 登入都失敗」,而錯誤訊息只會說外鍵違反。
   * 查不到就當成沒設定,並留一行警告給管理員循線回後台改。
   */
  private async resolveProvisionDefaults(defaults: {
    departmentId: string | null;
    managerId: string | null;
  }): Promise<{ departmentId: string | null; managerId: string | null }> {
    let departmentId: string | null = null;
    let managerId: string | null = null;
    try {
      if (defaults.departmentId) {
        const dept = await this.prisma.department.findUnique({
          where: { id: defaults.departmentId },
          select: { id: true },
        });
        if (dept) departmentId = dept.id;
        else this.logger.warn('[entra] SSO 設定的預設部門已不存在,這次自動建帳號不指定部門');
      }
      if (defaults.managerId) {
        const manager = await this.prisma.user.findUnique({
          where: { id: defaults.managerId },
          select: { id: true, status: true },
        });
        if (manager && manager.status === UserStatus.active) managerId = manager.id;
        else
          this.logger.warn('[entra] SSO 設定的預設主管已不存在或已停用,這次自動建帳號不指定主管');
      }
    } catch (e) {
      // 讀不到就當成沒設定:少一個歸屬還救得回來(後台改一下),登不進去救不回來
      this.logger.error(`[entra] 讀取自動建帳號的預設歸屬失敗:${(e as Error).message}`);
      return { departmentId: null, managerId: null };
    }
    return { departmentId, managerId };
  }
}

/**
 * 這次登入要向 Microsoft 要哪些 scope。
 * 授權(authorize)與換 token 兩邊必須送一樣的值,所以只留這一個來源。
 */
function buildScope(syncManager: boolean): string {
  return syncManager ? [...BASE_SCOPES, MANAGER_SCOPE].join(' ') : BASE_SCOPES.join(' ');
}

/**
 * 只解 payload,不驗簽章 —— 理由見檔頭。
 * 這個函式刻意不 export,免得別的地方拿去解「從瀏覽器來的」token。
 */
function decodeJwtPayload<T>(token: string): T {
  const part = token.split('.')[1];
  if (!part) throw new BadRequestException('id_token 格式錯誤');
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    throw new BadRequestException('id_token 無法解析');
  }
}
