import { Injectable, Logger } from '@nestjs/common';

/**
 * Microsoft Graph 的「使用者組織資料」讀取器
 *
 * ★ 為什麼需要這一支:id_token 裡沒有部門與職稱
 *   Entra 的 id_token 只帶 oid / email / name 這幾個身分 claim。
 *   公司組織圖上的東西(職稱、部門、辦公室、公司電話、手機、員工編號、主管)
 *   一律要另外打 Microsoft Graph 的 /me 才拿得到。
 *   常見的誤會是「把 optional claims 打開就有了」—— 職稱與部門並不在
 *   Entra 可加掛的 optional claims 清單裡,打開也不會出現。
 *
 * ★ 權限分成兩級,這件事一定要讓 IT 知道(見 docs/設定說明.md 的單一登入章節)
 *   - /me          → User.Read。這是應用程式註冊時就預設有的委派權限,
 *                    使用者自己同意即可,不需要系統管理員。
 *   - /me/manager  → User.Read.All。這是**需要系統管理員同意**的權限,
 *                    而且是「可以讀全租用戶所有人資料」的等級,IT 不見得會給。
 *   所以主管欄位做成選用:後台沒開就完全不打這支;開了但沒同意權限,
 *   Graph 會回 403,這裡安靜跳過,不寫警告 log(那不是故障,是預期內的沒權限)。
 *
 * ★ 這支永遠不丟例外
 *   組織資料是「錦上添花」,登入是「有沒有飯吃」。Graph 掛掉、逾時、被防火牆擋、
 *   權限被撤,任何一種都只回 null,由呼叫端降級成「這次沒同步到組織資料」。
 *   讓 Graph 決定使用者能不能登入是錯的分層。
 *
 * ★ access token 的處理規則
 *   token 只出現在 Authorization 標頭裡。不進 log、不進 audit_logs、不回前端、
 *   不寫進任何 JSONB。錯誤處理時也只取 HTTP 狀態碼與 Graph 的 error.code
 *   (像 Authorization_RequestDenied 這種機器碼),原始回應內文不落地 ——
 *   Graph 的錯誤內文會回音請求內容,那是最容易把 token 帶進 log 的路徑。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * 單次 Graph 請求的逾時。
 * 使用者正卡在「登入中」的白畫面上等這一下,所以抓得比一般後端呼叫短。
 * 逾時不是錯誤,是「這次不同步」。
 */
export const GRAPH_TIMEOUT_MS = 5000;

/**
 * 只要這幾個欄位。用 $select 而不是整包拿的理由:
 * 少拿一個欄位就少一個「不小心把它寫進 log 或 JSONB」的機會,
 * 而且 Graph 的預設回應含 userPrincipalName 等一堆用不到的東西。
 */
const ME_SELECT_FIELDS = [
  'displayName',
  'jobTitle',
  'department',
  'officeLocation',
  'mobilePhone',
  'businessPhones',
  'mail',
  'employeeId',
] as const;

const MANAGER_SELECT_FIELDS = ['displayName', 'mail', 'jobTitle'] as const;

/** users 表對應欄位的長度上限(schema 是 VarChar(40))。超過就截斷,不能讓它撞 DB 限制 */
export const M365_SHORT_FIELD_MAX = 40;
/** 存進 system_settings JSON 的欄位長度上限。純粹防呆,避免有人的職稱是一整段自我介紹 */
export const M365_TEXT_FIELD_MAX = 120;

export interface M365OrgProfile {
  displayName: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  /** Graph 的 mobilePhone */
  mobilePhone: string | null;
  /** Graph 的 businessPhones[0](Graph 回的是陣列,本系統只有一個公司電話欄位) */
  businessPhone: string | null;
  mail: string | null;
  employeeId: string | null;
}

export interface M365ManagerInfo {
  displayName: string | null;
  mail: string | null;
  jobTitle: string | null;
}

/** 取字串欄位:非字串、空白字串一律當成「沒有」,並截到上限長度 */
function pickString(raw: Record<string, unknown>, key: string, max: number): string | null {
  const v = raw[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Graph 的 /me 回應 → 本系統的組織資料。
 * 單獨拉出來 export 是為了讓測試可以直接餵各種畸形回應(欄位是 null、
 * businessPhones 是空陣列、職稱超長)而不用去 mock HTTP。
 */
export function normalizeM365Profile(raw: Record<string, unknown>): M365OrgProfile {
  const phones = Array.isArray(raw.businessPhones) ? raw.businessPhones : [];
  const firstPhone = phones.find((p): p is string => typeof p === 'string' && p.trim() !== '');
  return {
    displayName: pickString(raw, 'displayName', M365_TEXT_FIELD_MAX),
    jobTitle: pickString(raw, 'jobTitle', M365_TEXT_FIELD_MAX),
    department: pickString(raw, 'department', M365_TEXT_FIELD_MAX),
    officeLocation: pickString(raw, 'officeLocation', M365_TEXT_FIELD_MAX),
    mobilePhone: pickString(raw, 'mobilePhone', M365_SHORT_FIELD_MAX),
    businessPhone:
      firstPhone == null ? null : firstPhone.trim().slice(0, M365_SHORT_FIELD_MAX) || null,
    mail: pickString(raw, 'mail', 255),
    employeeId: pickString(raw, 'employeeId', M365_TEXT_FIELD_MAX),
  };
}

@Injectable()
export class GraphProfileService {
  private readonly logger = new Logger(GraphProfileService.name);

  /**
   * 讀登入者自己的組織資料(需要 User.Read,預設就有)。
   * 任何失敗都回 null,並且只在「非權限問題」時寫 warn ——
   * 權限沒開是設定問題,不該每次登入都在 log 洗一行紅字。
   */
  async fetchMe(accessToken: string): Promise<M365OrgProfile | null> {
    const url = `${GRAPH_BASE_URL}/me?$select=${ME_SELECT_FIELDS.join(',')}`;
    const raw = await this.getJson(url, accessToken, 'me', false);
    return raw ? normalizeM365Profile(raw) : null;
  }

  /**
   * 讀登入者的主管(需要 User.Read.All,**要系統管理員同意**)。
   * 呼叫端只有在後台把「同步主管」打開時才會走到這裡。
   * 沒有主管的人 Graph 回 404,沒權限回 403,兩種都安靜回 null。
   */
  async fetchManager(accessToken: string): Promise<M365ManagerInfo | null> {
    const url = `${GRAPH_BASE_URL}/me/manager?$select=${MANAGER_SELECT_FIELDS.join(',')}`;
    const raw = await this.getJson(url, accessToken, 'manager', true);
    if (!raw) return null;
    return {
      displayName: pickString(raw, 'displayName', M365_TEXT_FIELD_MAX),
      mail: pickString(raw, 'mail', 255),
      jobTitle: pickString(raw, 'jobTitle', M365_TEXT_FIELD_MAX),
    };
  }

  /**
   * 共用的 GET。
   * quiet=true 的呼叫(主管)在 403 / 404 時完全不寫 log:那是「權限沒給」或
   * 「這個人沒有主管」,兩者都是正常狀態,不是故障。
   */
  private async getJson(
    url: string,
    accessToken: string,
    label: string,
    quiet: boolean,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          // token 只出現在這裡,不進 log、不進 DB
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const code = await readGraphErrorCode(res);
        const expected = quiet && (res.status === 403 || res.status === 404);
        if (!expected) {
          // 只記狀態碼與 Graph 的機器碼。原始內文可能回音請求內容,不落地。
          this.logger.warn(
            `[graph] ${label} 讀取失敗 status=${res.status}${code ? ` code=${code}` : ''},這次登入不同步組織資料`,
          );
        }
        return null;
      }

      const body: unknown = await res.json();
      if (!body || typeof body !== 'object') return null;
      return body as Record<string, unknown>;
    } catch (e) {
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      if (!quiet) {
        this.logger.warn(
          `[graph] ${label} ${timedOut ? `逾時(${GRAPH_TIMEOUT_MS / 1000} 秒)` : `連線失敗:${err.name}`},這次登入不同步組織資料`,
        );
      }
      return null;
    }
  }
}

/**
 * 從 Graph 的錯誤回應裡只取 error.code(例:Authorization_RequestDenied)。
 * message 不取:那一欄會回音請求內容,是把憑證帶進 log 最常見的路徑。
 * 解析失敗回 null —— 錯誤處理本身不可以再丟例外。
 */
async function readGraphErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const err = (body as { error?: unknown } | null)?.error;
    if (!err || typeof err !== 'object') return null;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code.slice(0, 80) : null;
  } catch {
    return null;
  }
}
