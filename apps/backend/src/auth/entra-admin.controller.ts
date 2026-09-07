import {
  Body,
  Controller,
  ForbiddenException,
  BadRequestException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { getEnv } from '../common/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { EntraConfigService } from './entra-config.service';
import { EntraAuditService } from './entra-audit.service';
import { normalizeDomain, isValidDomainPattern, parseAllowedDomains } from './entra-domain';

/**
 * 後台「單一登入設定」的 admin API
 *
 *   GET   /api/admin/sso          → 目前狀態(缺哪幾個值、允許網域、自動建帳號、重新導向 URI)
 *   PATCH /api/admin/sso          → 改允許網域清單 / 自動建帳號開關(寫 system_settings id=3)
 *   POST  /api/admin/sso/check    → 打 Entra 的 OpenID discovery 驗證租用戶存在且可達
 *   GET   /api/admin/sso/logins   → 最近的 SSO 登入紀錄(成功與失敗)
 *
 * ★ client secret 絕對不出現在任何一支回應裡
 *   狀態只回 hasClientSecret: true/false。check 也只打 discovery 這支公開端點,
 *   不做 token 交換,所以整條路徑上完全不需要密碼。
 *
 * 全部 admin only。sales 打得到 JWT 守衛但會被下面的角色檢查擋掉。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

const AUTH_HOST = 'https://login.microsoftonline.com';
/** discovery 逾時。IT 按下按鈕在等,不能讓他等 30 秒才知道 DNS 不通 */
const DISCOVERY_TIMEOUT_MS = 8000;
/** 允許網域數量上限:防止有人貼一整份名單進來把 JSONB 撐爆 */
const MAX_DOMAINS = 50;

interface UpdateSsoBody {
  allowedDomains?: unknown;
  autoProvision?: unknown;
  syncManager?: unknown;
  /** 自動建帳號時的預設部門 / 預設主管。'' 或 null = 不指定 */
  defaultDepartmentId?: unknown;
  defaultManagerId?: unknown;
}

/**
 * 前端送過來的 id 正規化成 string | null | undefined。
 * '' 與 null 都是「不指定」,undefined 是「這次沒有要改這一欄」——
 * 三者混在一起的話,存一次別的設定就會把歸屬清掉。
 */
function normalizeIdInput(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${label}必須是字串或 null`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('admin/sso')
@UseGuards(AuthGuard('jwt'))
export class EntraAdminController {
  private readonly logger = new Logger(EntraAdminController.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly config: EntraConfigService,
    private readonly audit: EntraAuditService,
    private readonly prisma: PrismaService,
  ) {}

  private assertAdmin(req: Request & { user: { role: string } }): void {
    if (req.user.role !== 'admin') {
      throw new ForbiddenException('只有系統管理員可以管理單一登入設定');
    }
  }

  @Get()
  async status(@Req() req: Request & { user: { role: string } }) {
    this.assertAdmin(req);
    return this.buildStatus();
  }

  @Patch()
  async update(
    @Req() req: Request & { user: { role: string; sub: string } },
    @Body() body: UpdateSsoBody,
  ) {
    this.assertAdmin(req);

    const patch: {
      entraAllowedDomains?: string[];
      entraAutoProvision?: boolean;
      entraSyncManager?: boolean;
      entraDefaultDepartmentId?: string | null;
      entraDefaultManagerId?: string | null;
    } = {};

    if (body.allowedDomains !== undefined) {
      if (!Array.isArray(body.allowedDomains)) {
        throw new BadRequestException('允許網域必須是陣列');
      }
      if (body.allowedDomains.length > MAX_DOMAINS) {
        throw new BadRequestException(`允許網域最多 ${MAX_DOMAINS} 筆`);
      }
      // 逐筆檢查並回報是「哪一筆」錯,不要只說「格式錯誤」讓 IT 自己找
      const invalid: string[] = [];
      for (const raw of body.allowedDomains) {
        if (typeof raw !== 'string') {
          invalid.push(String(raw));
          continue;
        }
        if (raw.trim() === '') continue; // 空白列直接忽略(UI 上新增一列還沒填就存檔)
        if (!isValidDomainPattern(raw)) invalid.push(raw.trim().slice(0, 64));
      }
      if (invalid.length > 0) {
        throw new BadRequestException(
          `這幾筆不是合法的網域:${invalid.join('、')}(正確寫法例:example.com.tw,含子網域寫 *.example.com.tw)`,
        );
      }
      patch.entraAllowedDomains = parseAllowedDomains(
        (body.allowedDomains as string[]).map((d) => normalizeDomain(d)),
      );
    }

    if (body.autoProvision !== undefined) {
      if (typeof body.autoProvision !== 'boolean') {
        throw new BadRequestException('自動建立帳號必須是 true / false');
      }
      patch.entraAutoProvision = body.autoProvision;
    }

    if (body.syncManager !== undefined) {
      if (typeof body.syncManager !== 'boolean') {
        throw new BadRequestException('同步主管必須是 true / false');
      }
      // 這個開關會讓登入時多要一個 User.Read.All(需要系統管理員同意的租用戶級權限)。
      // 沒同意也可以打開,只是 Graph 會回 403、主管欄位留空,登入不受影響。
      patch.entraSyncManager = body.syncManager;
    }

    /**
     * 自動建帳號時的預設歸屬。存檔這一刻就檢查存不存在:
     * 存進去之後才發現部門是打錯的,症狀是「新同仁登入了但主管看不到他」,
     * 而那要等到有人反映才會發現,中間那幾天的拜訪紀錄一樣是隱形的。
     */
    if (body.defaultDepartmentId !== undefined) {
      const id = normalizeIdInput(body.defaultDepartmentId, '預設部門');
      if (id !== null) {
        const dept = await this.prisma.department.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!dept) throw new BadRequestException('找不到這個部門,請重新選一個');
      }
      patch.entraDefaultDepartmentId = id;
    }

    if (body.defaultManagerId !== undefined) {
      const id = normalizeIdInput(body.defaultManagerId, '預設主管');
      if (id !== null) {
        const manager = await this.prisma.user.findUnique({
          where: { id },
          select: { id: true, status: true },
        });
        if (!manager) throw new BadRequestException('找不到這個使用者,請重新選一位');
        if (manager.status !== 'active') {
          throw new BadRequestException('這個帳號已停用,不能當成自動建帳號的預設主管');
        }
      }
      patch.entraDefaultManagerId = id;
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('沒有可更新的欄位');
    }

    await this.settings.updateSsoSettings(true, req.user.sub, patch);
    return this.buildStatus();
  }

  /**
   * 「檢查設定」:實際去打 Entra 的 OpenID discovery。
   *
   * 驗的是「這個租用戶識別碼存在、而且這台後端連得到 Microsoft」——
   * 這兩件事錯的時候,使用者看到的症狀跟「密碼填錯」長得一模一樣,
   * 但處理方式完全不同,所以值得一顆按鈕分辨出來。
   *
   * 這裡不送 client secret、不做 token 交換,所以就算被誤觸也不會外洩任何東西。
   * 用嚴格 rate limit:這支會對外發請求,不能變成打 Microsoft 的跳板。
   */
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('check')
  @HttpCode(HttpStatus.OK)
  async check(@Req() req: Request & { user: { role: string } }) {
    this.assertAdmin(req);
    const cfg = await this.config.getEffectiveConfig();
    const missing = this.config.listMissing(cfg);

    if (!cfg.tenantId) {
      return {
        ok: false,
        code: 'no_tenant',
        message: '還沒有填目錄(租用戶)識別碼 ENTRA_TENANT_ID,無法檢查',
        checkedUrl: null,
        missing,
      };
    }

    const checkedUrl = `${AUTH_HOST}/${encodeURIComponent(cfg.tenantId)}/v2.0/.well-known/openid-configuration`;

    try {
      const res = await fetch(checkedUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        const raw = (await res.text()).slice(0, 500);
        const aadCode = raw.match(/AADSTS\d+/)?.[0] ?? null;
        return {
          ok: false,
          code: res.status === 400 || res.status === 404 ? 'tenant_not_found' : 'http_error',
          message:
            res.status === 400 || res.status === 404
              ? `Microsoft 查不到這個租用戶(HTTP ${res.status})。請確認目錄(租用戶)識別碼是否貼錯或多了空白${aadCode ? `,錯誤碼 ${aadCode}` : ''}`
              : `Microsoft 回應 HTTP ${res.status}`,
          checkedUrl,
          missing,
        };
      }

      const doc = (await res.json()) as {
        issuer?: string;
        authorization_endpoint?: string;
        token_endpoint?: string;
      };
      // issuer 長成 https://login.microsoftonline.com/{tenantGuid}/v2.0
      const issuerTenant = doc.issuer?.match(/([0-9a-f-]{36})/i)?.[1] ?? null;
      const tenantMatches =
        issuerTenant == null || issuerTenant.toLowerCase() === cfg.tenantId.toLowerCase();

      return {
        ok: true,
        code: 'ok',
        message: tenantMatches
          ? '租用戶存在,而且這台後端連得到 Microsoft。剩下的用戶端識別碼 / 密碼 / 重新導向 URI 要在實際登入時才驗得到'
          : '租用戶可連線,但 Microsoft 回的 issuer 與填入的識別碼不同(可能填的是網域別名而非 GUID),仍可運作',
        checkedUrl,
        issuer: doc.issuer ?? null,
        authorizationEndpoint: doc.authorization_endpoint ?? null,
        tokenEndpoint: doc.token_endpoint ?? null,
        tenantMatches,
        missing,
      };
    } catch (e) {
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      this.logger.warn(`[entra] discovery 檢查失敗:${err.name}: ${err.message}`);
      return {
        ok: false,
        code: timedOut ? 'timeout' : 'network_error',
        message: timedOut
          ? `連線逾時(${DISCOVERY_TIMEOUT_MS / 1000} 秒)。這台後端可能連不到 login.microsoftonline.com,請檢查對外網路或防火牆`
          : `連線失敗:${err.message}。多半是 DNS 或對外連線被擋`,
        checkedUrl,
        missing,
      };
    }
  }

  @Get('logins')
  async logins(
    @Req() req: Request & { user: { role: string } },
    @Query('limit') limitStr?: string,
  ) {
    this.assertAdmin(req);
    const limit = Math.min(Math.max(parseInt(limitStr ?? '50', 10) || 50, 1), 200);
    return { logins: await this.audit.list(limit) };
  }

  /** 狀態物件:GET 與 PATCH 共用,前端只要處理一種形狀 */
  private async buildStatus() {
    const env = getEnv();
    const cfg = await this.config.getEffectiveConfig();
    const missing = this.config.listMissing(cfg);

    return {
      // 四個憑證值齊了才算啟用
      enabled: missing.length === 0,
      missing,
      // 憑證類:只回「有沒有」與非機密的識別碼,密碼永遠只回布林值
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      hasClientSecret: Boolean(cfg.clientSecret),
      redirectUri: cfg.redirectUri,
      postLoginUrl: cfg.postLoginUrl,
      // 政策類:可在後台改
      allowedDomains: cfg.allowedDomains,
      allowedDomainsSource: cfg.allowedDomainsSource,
      autoProvision: cfg.autoProvision,
      autoProvisionSource: cfg.autoProvisionSource,
      // 登入時要不要一併同步主管(要 User.Read.All,需要系統管理員同意)
      syncManager: cfg.syncManager,
      // 自動建帳號時的預設歸屬。名稱一併回,前端不必為了畫一行字再打兩支 API,
      // 而且指到的東西被刪掉時這裡會是 null,畫面上就寫得出「原本設定的部門已不存在」
      defaultDepartmentId: cfg.defaultDepartmentId,
      defaultDepartmentName: await this.departmentName(cfg.defaultDepartmentId),
      defaultManagerId: cfg.defaultManagerId,
      defaultManagerName: await this.activeUserName(cfg.defaultManagerId),
      // 讓 UI 說得出「現在用的是 DB 還是 env 的值」
      envAllowedDomains: parseAllowedDomains(env.ENTRA_ALLOWED_DOMAINS),
      envAutoProvision: env.ENTRA_AUTO_PROVISION,
      // 登入頁的按鈕與回呼路徑,IT 要拿去對 Entra 上的設定
      startPath: '/api/auth/entra/start',
      callbackPath: '/api/auth/entra/callback',
    };
  }

  /** 部門名稱。查不到(被刪掉了)回 null,呼叫端會顯示「原本設定的部門已不存在」 */
  private async departmentName(id: string | null): Promise<string | null> {
    if (!id) return null;
    try {
      const row = await this.prisma.department.findUnique({
        where: { id },
        select: { name: true },
      });
      return row?.name ?? null;
    } catch {
      return null;
    }
  }

  /** 使用者姓名。停用或刪掉的一律回 null,理由同上 */
  private async activeUserName(id: string | null): Promise<string | null> {
    if (!id) return null;
    try {
      const row = await this.prisma.user.findUnique({
        where: { id },
        select: { name: true, status: true },
      });
      return row && row.status === 'active' ? row.name : null;
    } catch {
      return null;
    }
  }
}
