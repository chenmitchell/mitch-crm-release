// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 首次啟動精靈。
 *
 * 解決的問題:自架的人拿到的是一個空資料庫。原本要先在終端機跑 seed 腳本、
 * 把管理員 email 與密碼塞進環境變數,才登得進去 —— 那一步是整個安裝流程裡
 * 最容易卡住的地方,而卡住的樣子是「登入頁打不開任何帳號」,看不出原因。
 *
 * 安全邊界(這支沒有登入守衛,所以邊界要寫清楚):
 *   1. 「已初始化」的判準是 users 表有沒有人。有任何一位使用者,這兩支端點就
 *      一律拒絕 —— 不是回錯誤訊息就好,是連讀狀態都只回布林值,不透露
 *      組織名稱、管理員 email 之類的東西。
 *   2. 「檢查有沒有人」與「建立第一個管理員」在同一筆交易裡,而且交易開頭先取
 *      pg_advisory_xact_lock(SETUP_LOCK_KEY),第二個併發請求會等在鎖上,
 *      等進得去的時候 user.count 已經不是 0,直接被判定成已初始化。
 *      email 的唯一鍵只在兩邊送同一個 email 時擋得住,兩個不同 email 同時送
 *      會建出兩個管理員,所以它不是防線,只是額外的一層。
 *   3. 密碼一樣走 argon2id,一樣要求 12 碼以上 —— 第一個帳號是權限最大的那一個,
 *      沒有理由比後面建立的帳號寬鬆。
 *
 * 每一段都可以省略(精靈每一步都能跳過)。省略 = 那一段完全不寫,
 * 用啟動時就 seed 好的出廠值。**admin 那一段省略的話系統仍然是「未初始化」**,
 * 精靈可以再走一次 —— 沒有帳號就沒有人登得進來,那不是裝好的狀態。
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PASSWORD_MIN, resolveTimeZone } from '@mitchcrm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AppSettingsService } from '../app-settings/app-settings.service';
import type { AppSettingsPatch } from '../app-settings/app-settings.view';
import { normalizeEmail } from '../common/email';

export const ALREADY_INITIALIZED_MESSAGE =
  '系統已經初始化過,無法重複執行。請直接登入,或由系統管理員在後台調整設定';

/**
 * 沒有建管理員時,設定的 updatedBy 記成這個固定 uuid。
 * 用全零而不是留空,是為了讓稽核上看得出「這是安裝精靈寫的,不是某個人寫的」。
 */
const SETUP_ACTOR = '00000000-0000-0000-0000-000000000000';

/**
 * 安裝精靈的 advisory lock 常數。整個資料庫共用一把,交易結束自動釋放(xact 版)。
 * 值是任意選的固定 bigint,只要全系統只有這一支用它就好。
 */
export const SETUP_LOCK_KEY = 3687_0001;

/**
 * 第一個管理員的密碼長度下限。全系統同一組規則(packages/shared/src/password.ts):
 * 改密碼、邀請註冊、這裡與 seed-admin 都是同一個數字,不要在這裡另寫一個。
 */
export const SETUP_PASSWORD_MIN = PASSWORD_MIN;

/** 精靈的步驟代碼。與前端 /setup 的步驟一一對應 */
export const SETUP_STEP_KEYS = [
  'organization',
  'admin',
  'locale',
  'departments',
  'stages',
  'photoChecklist',
  'map',
  'appearance',
  'lookup',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export interface SetupStatus {
  /** 已經有使用者 = 初始化完成。前端據此決定要不要顯示精靈 */
  initialized: boolean;
  /** 各步驟設定過沒。只有布林值,不含任何設定內容 */
  steps: Record<SetupStepKey, boolean>;
}

export interface SetupOrganizationInput {
  name?: string;
  displayName?: string;
  productName?: string;
  logoText?: string;
}

export interface SetupAdminInput {
  email: string;
  name?: string;
  password: string;
}

export interface SetupDepartmentInput {
  name: string;
  managerName?: string;
  managerEmail?: string;
}

export interface SetupInput {
  organization?: SetupOrganizationInput;
  admin?: SetupAdminInput;
  locale?: { timezone?: string; locale?: string };
  departments?: SetupDepartmentInput[];
  stages?: Array<{
    key: string;
    label: string;
    color?: string;
    board?: boolean;
    form?: boolean;
    terminal?: boolean;
  }>;
  photoChecklist?: Array<{
    key: string;
    label: string;
    required?: boolean;
    placeTypes?: string[];
  }>;
  map?: {
    defaultLat?: number;
    defaultLng?: number;
    defaultZoom?: number;
    geocodeProvider?: 'nominatim' | 'none';
    /** 逗號分隔的兩碼國碼,空字串 = 不限制國家 */
    geocodeCountryCodes?: string;
  };
  appearance?: {
    themeScheme?: 'A' | 'B';
    themeSidebar?: 'dark' | 'light';
    themeDefaultMode?: 'light' | 'dark' | 'system';
    areaColors?: Record<string, string>;
  };
  /** 外部查詢帶入。整段省略 = 不啟用,那一格就是純手動填 */
  lookup?: {
    enabled?: boolean;
    label?: string;
    urlTemplate?: string;
    fieldMap?: Record<string, string>;
    pattern?: string;
  };
}

/**
 * 交易 client。用 PrismaService 的子集而不是 Prisma.TransactionClient:
 * 那個型別要 prisma generate 完才有,CI 沒 generate 時型別檢查會整支紅。
 */
export type SetupTx = Pick<PrismaService, 'user' | 'department' | '$executeRaw'>;

export interface SetupResult {
  ok: true;
  /** 有建管理員才有值 */
  userId: string | null;
  /** 這一次實際寫進去的步驟 */
  applied: SetupStepKey[];
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly appSettings: AppSettingsService,
  ) {}

  /** 已經有任何使用者就算初始化完成(含被停用的:那也代表有人裝過了) */
  private async isInitialized(): Promise<boolean> {
    const count = await this.prisma.user.count();
    return count > 0;
  }

  async status(): Promise<SetupStatus> {
    const initialized = await this.isInitialized();
    return { initialized, steps: await this.readSteps(initialized) };
  }

  /**
   * 各步驟填過沒。
   *
   * 判準一律是「這一格有沒有被寫過」,而不是「值等不等於出廠值」——
   * 有人把組織名稱刻意設成跟預設值一樣,那也是他設過了。
   * 所以讀的是 system_settings 那一列的原始 JSON(沒有併上 FACTORY_DEFAULTS)。
   */
  private async readSteps(initialized: boolean): Promise<Record<SetupStepKey, boolean>> {
    const empty = Object.fromEntries(SETUP_STEP_KEYS.map((k) => [k, false])) as Record<
      SetupStepKey,
      boolean
    >;
    if (!initialized) return empty;

    let raw: Record<string, unknown> = {};
    let departments = 0;
    try {
      const row = await this.prisma.systemSettings.findUnique({ where: { id: 1 } });
      raw = (row?.data as Record<string, unknown> | undefined) ?? {};
      departments = await this.prisma.department.count();
    } catch {
      // 讀不到就當成「還沒填」,不要讓狀態端點因為一張表沒建好就整支掛掉
      return { ...empty, admin: true };
    }

    const has = (...keys: string[]): boolean =>
      keys.some((k) => raw[k] !== undefined && raw[k] !== '');

    return {
      organization: has('companyName', 'organizationDisplayName', 'productName', 'logoText'),
      admin: true,
      locale: has('timezone', 'locale'),
      departments: departments > 0,
      stages: has('stagesConfiguredAt'),
      photoChecklist: has('photoChecklist'),
      map: has(
        'mapDefaultLat',
        'mapDefaultLng',
        'mapDefaultZoom',
        'geocodeProvider',
        'geocodeCountryCodes',
      ),
      appearance: has('themeScheme', 'themeSidebar', 'themeDefaultMode', 'areaColors'),
      lookup: has('lookupEnabled', 'lookupLabel', 'lookupUrlTemplate', 'lookupPattern'),
    };
  }

  /**
   * 執行初始化。已初始化就拒絕,而且什麼都不寫。
   *
   * 寫入順序:先建管理員,再寫設定。反過來的話,建帳號失敗(唯一鍵衝突)時
   * 設定已經被改掉了,而使用者看到的是一句「系統已經初始化過」。
   */
  async run(input: SetupInput): Promise<SetupResult> {
    // timeout 放寬:交易裡含一次 argon2 雜湊(刻意慢),預設的 5 秒在慢一點的機器上會不夠。
    //
    // 設定寫入刻意留在交易**外**。原本是在交易裡呼叫 appSettings.updateAppSettings
    // 與 settings.update,那兩支用的是 this.prisma,會另外借一條連線 ——
    // Prisma 的連線池在單 vCPU 預設只有 3 條,三個併發的初始化就會互相卡到 pool timeout,
    // 而且 updateAppSettings 自己也開一筆交易並取另一把 advisory lock,巢在裡面沒有好處。
    // 移到交易外之後,順序變成「先確定管理員與部門建好並 commit,再寫設定」,
    // 建帳號失敗時設定完全沒被動過,比原本更安全。
    const { result, patch, stagesConfigured } = await this.prisma.$transaction(
      async (tx) => this.runLocked(tx, input),
      { timeout: 30_000, maxWait: 20_000 },
    );

    const actor = result.userId ?? SETUP_ACTOR;
    if (Object.keys(patch).length > 0) {
      // role 直接給 admin:這條路徑的前提就是「系統裡還沒有任何人」,
      // 沒有可以檢查角色的登入者。守門的是交易裡那道「已初始化就拒絕」。
      await this.appSettings.updateAppSettings('admin', actor, patch);
    }
    // 階段有沒有設過,光看 dev_stages 分不出來(啟動時就 seed 過了),
    // 所以另外記一格時間戳給 status 用。
    if (stagesConfigured) {
      await this.settings.update(true, actor, { stagesConfiguredAt: new Date().toISOString() });
    }
    return result;
  }

  /**
   * 交易內的實際流程。開頭先取 advisory lock,再查 user.count。
   *
   * 鎖 + 同一筆交易缺一不可:只有交易沒有鎖的話,兩個併發交易各自讀到 count = 0
   * (READ COMMITTED 下對方還沒 commit),兩邊都會建管理員。
   */
  private async runLocked(
    tx: SetupTx,
    input: SetupInput,
  ): Promise<{ result: SetupResult; patch: AppSettingsPatch; stagesConfigured: boolean }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY}::bigint)`;
    if ((await tx.user.count()) > 0) throw new ConflictException(ALREADY_INITIALIZED_MESSAGE);

    const applied: SetupStepKey[] = [];
    let userId: string | null = null;

    if (input.admin) {
      userId = await this.createAdmin(tx, input.admin);
      applied.push('admin');
    }

    const patch: AppSettingsPatch = {};
    if (input.organization) {
      const org = input.organization;
      if (org.name !== undefined) patch.organizationName = org.name;
      if (org.displayName !== undefined) patch.organizationDisplayName = org.displayName;
      if (org.productName !== undefined) patch.productName = org.productName;
      if (org.logoText !== undefined) patch.logoText = org.logoText;
      applied.push('organization');
    }
    if (input.locale) {
      // 認不得的 IANA 時區不寫進去(退回出廠預設):安裝時打錯一個字,
      // 之後所有「今天是哪一天」都會安靜地用另一套規則
      if (input.locale.timezone !== undefined) {
        patch.timezone = resolveTimeZone(input.locale.timezone);
      }
      if (input.locale.locale !== undefined) patch.locale = input.locale.locale;
      applied.push('locale');
    }
    if (input.stages) {
      patch.stages = input.stages.map((s) => ({
        key: s.key,
        label: s.label,
        color: s.color as never,
        board: s.board,
        form: s.form,
        terminal: s.terminal,
      }));
      applied.push('stages');
    }
    if (input.photoChecklist) {
      patch.photoChecklist = input.photoChecklist.map((p) => ({
        key: p.key,
        label: p.label,
        required: p.required,
        placeTypes: p.placeTypes,
      }));
      applied.push('photoChecklist');
    }
    if (input.map) {
      if (input.map.defaultLat !== undefined) patch.mapDefaultLat = input.map.defaultLat;
      if (input.map.defaultLng !== undefined) patch.mapDefaultLng = input.map.defaultLng;
      if (input.map.defaultZoom !== undefined) patch.mapDefaultZoom = input.map.defaultZoom;
      if (input.map.geocodeProvider !== undefined) {
        patch.geocodeProvider = input.map.geocodeProvider;
      }
      if (input.map.geocodeCountryCodes !== undefined) {
        // 原樣帶過去,清洗在 toSettingsPatch 的 normalizeGeocodeCountryCodes 那一處做。
        // 在這裡先洗一次的話,規則就有兩份會走散的複本
        patch.geocodeCountryCodes = input.map.geocodeCountryCodes;
      }
      applied.push('map');
    }
    if (input.appearance) {
      const a = input.appearance;
      if (a.themeScheme !== undefined) patch.themeScheme = a.themeScheme;
      if (a.themeSidebar !== undefined) patch.themeSidebar = a.themeSidebar;
      if (a.themeDefaultMode !== undefined) patch.themeDefaultMode = a.themeDefaultMode;
      if (a.areaColors !== undefined) patch.areaColors = a.areaColors;
      applied.push('appearance');
    }
    if (input.lookup) {
      const l = input.lookup;
      if (l.enabled !== undefined) patch.lookupEnabled = l.enabled;
      if (l.label !== undefined) patch.lookupLabel = l.label;
      if (l.urlTemplate !== undefined) patch.lookupUrlTemplate = l.urlTemplate;
      if (l.fieldMap !== undefined) patch.lookupFieldMap = l.fieldMap;
      if (l.pattern !== undefined) patch.lookupPattern = l.pattern;
      applied.push('lookup');
    }

    if (input.departments?.length) {
      await this.createDepartments(tx, input.departments);
      applied.push('departments');
    }

    if (!userId) {
      this.logger.warn('[setup] 這次沒有建立管理員帳號,系統仍然是未初始化狀態,精靈可以再走一次');
    } else {
      this.logger.log(`[setup] 初始化完成,步驟:${applied.join('、') || '(無)'}`);
    }
    return {
      result: { ok: true, userId, applied },
      patch,
      stagesConfigured: Boolean(input.stages),
    };
  }

  private async createAdmin(tx: SetupTx, admin: SetupAdminInput): Promise<string> {
    const email = normalizeEmail(admin.email);
    const name = (admin.name ?? '').trim() || email.split('@')[0] || '系統管理員';
    const passwordHash = await argon2.hash(admin.password, { type: argon2.argon2id });
    try {
      const created = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: 'admin',
          status: 'active',
          // 精靈裡的密碼是本人自己輸入的,不是別人給的臨時密碼,不必強制改
          mustChangePassword: false,
        },
        select: { id: true },
      });
      return created.id;
    } catch {
      // 併發已經由 advisory lock 擋住了,這裡剩下的是「同一個 email 已經存在」之類的
      // 寫入失敗。交易會整筆回滾,設定不會留下寫到一半的狀態。
      throw new ConflictException(ALREADY_INITIALIZED_MESSAGE);
    }
  }

  /**
   * 建立初始部門。主管的 email 對得到人就順手指派,對不到就只建部門 ——
   * 精靈填的主管通常還沒有帳號,為了這件事把整個安裝擋下來並不合理。
   */
  private async createDepartments(
    tx: SetupTx,
    rows: readonly SetupDepartmentInput[],
  ): Promise<void> {
    for (const [index, row] of rows.entries()) {
      const name = row.name.trim();
      if (!name) continue;
      const dept = await tx.department.create({
        data: { name, sortOrder: (index + 1) * 10 },
        select: { id: true },
      });
      // 這一格是拿去對 users.email 的,所以要跟寫入端走完全同一套正規化
      // (見 common/email.ts)。自己寫 trim().toLowerCase() 少了「移除夾帶的空白」,
      // 貼上時帶進一個全形空白就查不到人,而畫面上只是部門建好了卻沒有主管。
      const email = normalizeEmail(row.managerEmail);
      if (!email) continue;
      const manager = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (!manager) {
        this.logger.warn(`[setup] 部門「${name}」的主管信箱還沒有對應的帳號,只建立部門`);
        continue;
      }
      await tx.user.update({
        where: { id: manager.id },
        data: { departmentId: dept.id },
      });
    }
  }
}
