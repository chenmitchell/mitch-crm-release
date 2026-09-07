/**
 * Entra 登入的「身分取值」與「網域比對」規則
 *
 * 抽成獨立檔案的理由:這是整套 SSO 唯一真正決定「誰進得來」的地方,
 * 必須能單獨測(entra-domain.spec.ts),不用起 Nest、不用連 DB、不用真的租用戶。
 *
 * ─────────────────────────────────────────────────────────────
 * 規則一:身分只取一個值,而且從頭到尾都用同一個
 *
 *   id_token 可能同時有 email / preferred_username / upn 三個 claim,
 *   三者不一定一致。最容易出事的寫法是「用 A 比網域、用 B 找帳號」——
 *   只要兩個 claim 的網域不同,網域白名單就形同虛設。
 *
 *   所以 pickLoginIdentity() 只挑出一個 loginEmail,之後網域比對與
 *   users 表比對都用它,不再回頭看其他 claim。
 *
 *   取用順序:email → preferred_username → upn(維持原本行為,不改既有部署)
 *
 *   為什麼 email 排第一:
 *     系統管理員在「使用者管理」建帳號時填的是同仁的信箱,users.email 存的
 *     就是信箱。而地端 AD 同步上雲的租用戶很常見 UPN 尾碼是 onmicrosoft.com
 *     (原本的 .local 尾碼不可路由,同步時會被換掉),此時 preferred_username
 *     是 alice@公司.onmicrosoft.com、email 才是 alice@example.com.tw。
 *     UPN 優先會讓整個白名單對不上,而且症狀是「全公司都登不進去」。
 *
 * 規則二:來賓帳號(B2B guest)一律拒絕
 *
 *   tid 檢查擋不掉來賓 —— 外部使用者被邀請進本租用戶後,他的 id_token 的 tid
 *   就是本租用戶。來賓的 UPN 長成 bob_gmail.com#EXT#@contoso.onmicrosoft.com,
 *   看到 #EXT# 就直接擋,不要讓「白名單留空」或「白名單剛好含 onmicrosoft.com」
 *   變成外部人員的後門。
 *
 * 規則三:子網域預設不算
 *
 *   允許 example.com.tw 不等於允許 tw.example.com.tw ——
 *   子網域可能是子公司、可能是測試租用戶,不該自動繼承權限。
 *   要放行子網域必須明確寫成 *.example.com.tw(後台勾「含子網域」會產生這個值)。
 *   注意 *.example.com.tw 同時也涵蓋 example.com.tw 本身。
 *
 * 規則四:白名單留空 = 不限網域
 *
 *   此時仍要求該 email 在 users 表存在(或開了自動建帳號),但等於把
 *   「誰能登入」整個交給租用戶設定。後台會用警告標示這件事,不要靜靜放行。
 */

// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

/** 拒絕登入的原因分類 —— 會寫進 audit_logs.metadata.reason,IT 排錯就看這個 */
export type EntraDenyReason =
  | 'not_configured'
  | 'provider_error'
  | 'bad_request'
  | 'state_mismatch'
  | 'tx_expired'
  | 'token_exchange_failed'
  | 'no_id_token'
  | 'malformed_id_token'
  | 'tenant_mismatch'
  | 'audience_mismatch'
  | 'token_expired'
  | 'nonce_mismatch'
  | 'no_email_claim'
  | 'guest_account'
  | 'domain_not_allowed'
  | 'user_not_found'
  | 'user_disabled'
  | 'internal_error';

/** 原因分類對應的中文說明(後台清單直接顯示,不要讓 IT 去查代碼表) */
export const ENTRA_DENY_REASON_LABEL: Record<EntraDenyReason, string> = {
  not_configured: 'SSO 尚未設定完成',
  provider_error: 'Microsoft 端回報錯誤(使用者取消或同意被拒)',
  bad_request: '回呼參數不完整',
  state_mismatch: 'state 不符(跨分頁或 CSRF)',
  tx_expired: '授權流程逾時(超過 10 分鐘)',
  token_exchange_failed: '向 Microsoft 換 token 失敗',
  no_id_token: 'Microsoft 未回傳 id_token',
  malformed_id_token: 'id_token 無法解析',
  tenant_mismatch: '租用戶不符(不是公司的 Microsoft 租用戶)',
  audience_mismatch: 'id_token 的 aud 與用戶端識別碼不符',
  token_expired: 'Microsoft 憑證已過期',
  nonce_mismatch: 'nonce 不符',
  no_email_claim: 'Microsoft 帳號沒有可用的 email',
  guest_account: '來賓帳號(B2B guest)不允許登入',
  domain_not_allowed: '網域不在允許清單',
  user_not_found: '本系統沒有這個帳號(未開自動建帳號)',
  user_disabled: '帳號已停用',
  internal_error: '系統內部錯誤',
};

export interface EntraIdentityClaims {
  email?: string;
  preferred_username?: string;
  upn?: string;
}

export interface EntraIdentity {
  /** 決定權限的唯一身分值;取不到時為 null */
  loginEmail: string | null;
  /** loginEmail 取自哪一個 claim,寫進 audit log 方便排錯 */
  source: 'email' | 'preferred_username' | 'upn' | null;
  /** 是否為 B2B 來賓帳號(UPN 含 #EXT#) */
  isGuest: boolean;
  /** 三個 claim 的網域彼此不一致時記下來,IT 看 audit log 才知道發生什麼事 */
  claimDomains: Record<string, string>;
}

/**
 * 正規化一筆網域設定值。
 * 接受使用者可能貼進來的各種寫法:大小寫、前後空白、前導 @、結尾點、
 * 誤貼整串 email(user@domain)、誤貼網址(https://domain/)。
 * 回傳小寫、無空白的網域;無法解析時回空字串(呼叫端會過濾掉)。
 */
export function normalizeDomain(raw: string): string {
  let v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  // 移除所有空白字元(含全形空白):貼上時很容易夾帶
  v = v.replace(/[\s　]+/g, '');
  // 誤貼網址
  v = v.replace(/^[a-z]+:\/\//, '');
  v = v.split('/')[0] ?? '';
  // 誤貼整串 email:取最後一個 @ 之後
  const at = v.lastIndexOf('@');
  if (at >= 0) v = v.slice(at + 1);
  // 結尾的根點(example.com.)
  v = v.replace(/\.+$/, '');
  return v;
}

const DOMAIN_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 這筆設定值是不是一個合法的網域(可含 *. 前綴) */
export function isValidDomainPattern(raw: string): boolean {
  const v = normalizeDomain(raw);
  return v.length > 0 && DOMAIN_RE.test(v);
}

/**
 * 把設定值(env 的逗號字串 或 DB 的陣列)整理成乾淨的網域清單。
 * 正規化 → 去掉非法值 → 去重(保留第一次出現的順序)。
 */
export function parseAllowedDomains(raw: string | string[] | null | undefined): string[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : raw.split(',');
  const out: string[] = [];
  for (const item of items) {
    const v = normalizeDomain(typeof item === 'string' ? item : String(item));
    if (!v || !DOMAIN_RE.test(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 從 email 取網域。
 * 用「最後一個 @」切,不是第一個 —— RFC 5321 的 local-part 可以用引號包住 @,
 * a"@"b@example.com 的網域是 example.com,用 split('@')[1] 會拿到空字串。
 * 取不到合法網域時回空字串。
 */
export function extractDomain(email: string): string {
  const v = (email ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '');
  const at = v.lastIndexOf('@');
  if (at <= 0) return '';
  const domain = v.slice(at + 1).replace(/\.+$/, '');
  if (!domain || domain.includes('@')) return '';
  return domain;
}

/**
 * 網域是否被允許。
 *   - allowed 為空 → 一律 true(不限網域,呼叫端要另外警告)
 *   - 一般項目 → 完全相等才算
 *   - *.example.com → example.com 本身與任意層子網域都算
 */
export function isDomainAllowed(emailOrDomain: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = emailOrDomain.includes('@')
    ? extractDomain(emailOrDomain)
    : normalizeDomain(emailOrDomain);
  if (!domain) return false;
  for (const entry of allowed) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      if (!base) continue;
      if (domain === base || domain.endsWith(`.${base}`)) return true;
    } else if (domain === entry) {
      return true;
    }
  }
  return false;
}

/** UPN / preferred_username 含 #EXT# 就是 B2B 來賓帳號 */
function looksLikeGuest(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().includes('#ext#');
}

/**
 * 從 id_token claims 決定唯一的登入身分。規則見檔頭。
 */
export function pickLoginIdentity(claims: EntraIdentityClaims): EntraIdentity {
  const norm = (v: string | undefined): string =>
    (v ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s　]+/g, '');

  const email = norm(claims.email);
  const preferred = norm(claims.preferred_username);
  const upn = norm(claims.upn);

  const claimDomains: Record<string, string> = {};
  for (const [k, v] of [
    ['email', email],
    ['preferred_username', preferred],
    ['upn', upn],
  ] as Array<[string, string]>) {
    const d = extractDomain(v);
    if (d) claimDomains[k] = d;
  }

  const isGuest = looksLikeGuest(preferred) || looksLikeGuest(upn) || looksLikeGuest(email);

  let loginEmail: string | null = null;
  let source: EntraIdentity['source'] = null;
  for (const [src, value] of [
    ['email', email],
    ['preferred_username', preferred],
    ['upn', upn],
  ] as Array<[EntraIdentity['source'], string]>) {
    if (value && extractDomain(value)) {
      loginEmail = value;
      source = src;
      break;
    }
  }

  return { loginEmail, source, isGuest, claimDomains };
}

/** 三個 claim 的網域是不是彼此不一致(寫進 audit log 供排錯) */
export function hasDomainDisagreement(claimDomains: Record<string, string>): boolean {
  const values = Object.values(claimDomains);
  return values.length > 1 && new Set(values).size > 1;
}
