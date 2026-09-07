import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../common/env';
import { SettingsService } from '../settings/settings.service';
import { parseAllowedDomains } from './entra-domain';

/**
 * Entra SSO 的「有效設定」計算器
 *
 * ★ 優先序:資料庫 > 環境變數
 *   後台改完立刻生效,不用重開服務;既有只設過 env 的部署完全不受影響
 *   (DB 那一列不存在時所有欄位都 fallback 回 env)。
 *   env 的角色退化成 bootstrap:第一次上線時把值填進去,之後交給後台維護。
 *
 * ★ 哪些東西「不」放資料庫
 *   ENTRA_CLIENT_SECRET —— 只留在環境變數。理由:
 *     1. 這一列會被 admin 端點讀出來組回應,任何一次欄位漏過濾都會外洩密碼
 *     2. 密碼輪替本來就是 IT 在部署平台上改環境變數的事,不是後台功能
 *   租用戶 / 用戶端識別碼 / 重新導向 URI 同樣留在 env:它們要與 Entra 上的
 *   應用程式註冊一字不差,改這三個等於換一個應用程式,不是日常維運動作。
 *   後台負責的是「政策」(誰能登入),不是「憑證」。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

export type SettingSource = 'db' | 'env' | 'default';

export interface EntraEffectiveConfig {
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
  postLoginUrl: string | null;
  /** 已正規化的允許網域清單;空陣列 = 不限網域 */
  allowedDomains: string[];
  allowedDomainsSource: SettingSource;
  autoProvision: boolean;
  autoProvisionSource: SettingSource;
  /**
   * 登入時要不要一併同步「主管」。
   * 只有 DB 有值才會是 true;沒有對應的環境變數,因為這牽涉到要不要授出
   * User.Read.All(需要系統管理員同意的租用戶級權限),那種決定應該在後台留痕,
   * 不是塞在部署平台的變數裡讓人忘記。
   */
  syncManager: boolean;
  /**
   * 自動建立帳號時要套用的預設部門與預設主管。
   * 只有 DB 有值才會有內容,沒有對應的環境變數:這兩個值是資料表的主鍵,
   * 填在部署平台的變數裡沒人看得出填的是誰,而且部門被刪掉之後也沒有地方會提醒。
   * 兩者都 null = 不指定,自動建的帳號就會落在部門樹與團隊樹之外
   * (後台會標示出來,見使用者管理頁的「未歸屬」)。
   */
  defaultDepartmentId: string | null;
  defaultManagerId: string | null;
}

/** 少了哪個憑證值 —— 給後台逐條列出來,不要只說「未設定」 */
export interface MissingSetting {
  key: string;
  label: string;
  hint: string;
}

const CREDENTIAL_FIELDS: Array<{
  key: keyof Pick<EntraEffectiveConfig, 'tenantId' | 'clientId' | 'clientSecret' | 'redirectUri'>;
  env: string;
  label: string;
  hint: string;
}> = [
  {
    key: 'tenantId',
    env: 'ENTRA_TENANT_ID',
    label: '目錄(租用戶)識別碼',
    hint: 'Entra 系統管理中心 → 應用程式註冊 → 概觀,「目錄 (租用戶) 識別碼」',
  },
  {
    key: 'clientId',
    env: 'ENTRA_CLIENT_ID',
    label: '應用程式(用戶端)識別碼',
    hint: 'Entra 系統管理中心 → 應用程式註冊 → 概觀,「應用程式 (用戶端) 識別碼」',
  },
  {
    key: 'clientSecret',
    env: 'ENTRA_CLIENT_SECRET',
    label: '用戶端密碼',
    hint: '應用程式註冊 → 憑證及密碼 → 用戶端密碼。建立後只顯示一次,離開頁面就看不到',
  },
  {
    key: 'redirectUri',
    env: 'ENTRA_REDIRECT_URI',
    label: '重新導向 URI',
    hint: '必須與 Entra 應用程式註冊裡填的值一字不差,結尾不要多斜線',
  },
];

@Injectable()
export class EntraConfigService {
  private readonly logger = new Logger(EntraConfigService.name);

  constructor(private readonly settings: SettingsService) {}

  /** 取得合併後的有效設定(DB 優先,再 fallback env) */
  async getEffectiveConfig(): Promise<EntraEffectiveConfig> {
    const env = getEnv();
    let dbAllowedDomains: string[] | undefined;
    let dbAutoProvision: boolean | undefined;
    let dbSyncManager: boolean | undefined;
    let dbDefaultDepartmentId: string | null = null;
    let dbDefaultManagerId: string | null = null;

    try {
      const sso = await this.settings.getSsoSettings();
      if (Array.isArray(sso.entraAllowedDomains)) {
        dbAllowedDomains = parseAllowedDomains(sso.entraAllowedDomains);
      }
      if (typeof sso.entraAutoProvision === 'boolean') {
        dbAutoProvision = sso.entraAutoProvision;
      }
      if (typeof sso.entraSyncManager === 'boolean') {
        dbSyncManager = sso.entraSyncManager;
      }
      dbDefaultDepartmentId = sso.entraDefaultDepartmentId ?? null;
      dbDefaultManagerId = sso.entraDefaultManagerId ?? null;
    } catch (e) {
      // DB 讀不到時退回 env,不要讓設定表的問題把登入整條打掉。
      // 但這件事要留痕:退回 env 可能代表「後台剛加的網域沒生效」。
      this.logger.error(`[entra] 讀取 SSO 設定失敗,改用環境變數:${(e as Error).message}`);
    }

    const envAllowed = parseAllowedDomains(env.ENTRA_ALLOWED_DOMAINS);

    return {
      tenantId: env.ENTRA_TENANT_ID ?? null,
      clientId: env.ENTRA_CLIENT_ID ?? null,
      clientSecret: env.ENTRA_CLIENT_SECRET ?? null,
      redirectUri: env.ENTRA_REDIRECT_URI ?? null,
      postLoginUrl: env.ENTRA_POST_LOGIN_URL ?? null,
      allowedDomains: dbAllowedDomains ?? envAllowed,
      allowedDomainsSource: dbAllowedDomains ? 'db' : envAllowed.length > 0 ? 'env' : 'default',
      autoProvision: dbAutoProvision ?? env.ENTRA_AUTO_PROVISION,
      autoProvisionSource: typeof dbAutoProvision === 'boolean' ? 'db' : 'env',
      // 讀不到 DB 設定時一律 false:寧可少同步一個欄位,也不要在沒人按過同意的
      // 情況下去要 User.Read.All 而讓所有人的登入卡在同意畫面
      syncManager: dbSyncManager ?? false,
      defaultDepartmentId: dbDefaultDepartmentId,
      defaultManagerId: dbDefaultManagerId,
    };
  }

  /** 缺哪幾個憑證值(空陣列 = 齊了) */
  listMissing(config: EntraEffectiveConfig): MissingSetting[] {
    return CREDENTIAL_FIELDS.filter((f) => !config[f.key]).map((f) => ({
      key: f.env,
      label: f.label,
      hint: f.hint,
    }));
  }

  /** 四個憑證值都有才算已啟用(半套設定比沒設定糟,登入頁會出現一按就失敗的按鈕) */
  isConfigured(config: EntraEffectiveConfig): boolean {
    return this.listMissing(config).length === 0;
  }
}
