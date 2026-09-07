// ref:3687 mc/陳彥輔/米球®
/**
 * email 的正規化。全系統只有這一份。
 *
 * ── 為什麼需要 ────────────────────────────────────────────────────
 * users.email 是 `@unique`,而 PostgreSQL 的唯一索引是區分大小寫的
 * (schema 沒有 citext)。所以 `Alice@Example.com` 與 `alice@example.com` 在資料庫眼裡
 * 是兩個不同的值。原本五個寫入點只有三個轉小寫(邀請、安裝精靈、seed-admin),
 * 使用者管理建帳號與登入沒有轉,實際後果有兩層:
 *
 *   1. 管理員建了 `Alice@Example.com`,使用者打 `alice@example.com` 登入會失敗,
 *      而訊息跟密碼打錯一模一樣(刻意的反枚舉設計),查不出原因。
 *   2. 更嚴重的是 SSO:Microsoft 的 id_token claim 一律被轉成小寫
 *      (見 auth/entra-domain.ts 的 pickLoginIdentity),所以大小寫混雜建立的
 *      帳號,SSO 對帳時找不到它。`entraAutoProvision` 開著的話就會**再開一個
 *      全新的 active 帳號** —— 管理員把 `Alice@Example.com` 停用之後,
 *      她走 Microsoft 登入仍然拿得到可用帳號,「停用」這個管制在這條路徑上失效。
 *
 * ── 做什麼 ────────────────────────────────────────────────────────
 * 去頭尾空白、移除夾帶的空白字元(含全形空白,貼上時很容易帶進來)、轉小寫。
 * 只做這三件,不做「移除 Gmail 的點」那種供應商特規 —— 那會把兩個真的不同的
 * 帳號併成一個。
 *
 * ── 誰在用 ────────────────────────────────────────────────────────
 * 寫入 users.email 的路徑全部走這一支:使用者管理建帳號(create-user.dto 的
 * @Transform 與 users.service.create)、登入(login.dto 的 @Transform +
 * auth.service 的鎖定計數)、SSO 對帳(entra.service)、邀請接受(invites.service)、
 * 安裝精靈(setup.service)與 seed-admin(setup/seed-admin.ts)。
 * 後三者原本各自寫一份 `.trim().toLowerCase()` —— 轉小寫這件事是對的,
 * 但少了「移除夾帶的空白」,而且這一支日後改了規則,那三處不會跟著改。
 *
 * 「拿 email 去查 users」的讀取路徑也算在內,理由一樣:查詢用的正規化跟寫入
 * 不一致,就是查不到本來存在的那一列。安裝精靈匯入部門時用 managerEmail 找主管
 * 就是這一條(setup.service.ts),原本自己寫一份,現在走這裡。
 * 新增任何會讀寫 users.email 的路徑,一律呼叫這裡,不要再抄一份。
 *
 * 唯一不走這一支的是 auth/entra-audit.service.ts 的 normalizeForLog:那是把 email
 * 寫進登入紀錄 JSONB 前的整理,多一道 320 字元截斷,而且它的輸出不會拿去比對
 * 任何帳號。目的不同,不併過來。網域設定的 normalizeDomain(auth/entra-domain.ts)
 * 處理的是網域不是 email,也不在這一支的範圍內。
 *
 * 大小寫規則:整串轉小寫。RFC 5321 說 local-part 理論上可以區分大小寫,
 * 但實務上沒有任何一家郵件供應商這樣做,而「登入要分大小寫」造成的
 * 使用者困擾與重複帳號遠大於那個理論上的正確性。
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}
