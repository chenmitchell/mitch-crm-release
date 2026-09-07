// ref:3687 mc/陳彥輔/米球®
/**
 * `?next=` 的驗證。登入頁、改密碼頁、以及任何「做完某件事再把人送回原本那一頁」
 * 的地方都要走這一支。
 *
 * ── 為什麼需要 ──────────────────────────────────────────────────────
 * 登入頁原本把網址上的 `next` 原封不動丟給 `router.push`。Next 15 的 router 遇到
 * 外部 URL 不會靜靜失敗,它走 `handleExternalUrl` 做整頁硬導航,
 * 也就是說 `/login?next=https://attacker.example/fake-crm` 是一個「登入成功之後
 * 真的會離站」的連結。受害者看到的網域、憑證、登入頁全都是自家的,
 * 送出帳密之後才落到別人的假頁面上。
 *
 * 後端對同一個參數早就做對了(auth/entra.controller.ts 只收 `startsWith('/')`),
 * 前端這一半補上,兩邊判準寫成同一句話。
 *
 * ── 判準 ────────────────────────────────────────────────────────────
 * 只收「本站的絕對路徑」:
 *   `/admin`、`/admin/crm?tab=all`、`/admin#top` 收;
 *   `//evil.example`(protocol-relative,瀏覽器會當成 https://evil.example)擋;
 *   `/\evil.example`(反斜線,部分瀏覽器等同 `//`)擋;
 *   `https://evil.example`、`javascript:...`、`admin`(相對路徑)擋;
 *   夾帶控制字元(CR/LF/Tab/NUL)的擋,免得被拿去做折行注入。
 */

/** 控制字元:換行、Tab、NUL 之類。網址上不該出現,出現就是有人在試東西 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 把網址上的 `next` 收斂成一個可以安全 push 的站內路徑。
 * 不合格就回 `null`,呼叫端自己決定預設落點(通常是 `/admin`)。
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (CONTROL_CHARS.test(value)) return null;
  // 單一 `/` 開頭才是站內路徑
  if (!value.startsWith('/')) return null;
  // `//host` 與 `/\host` 都會被瀏覽器解讀成別的網站
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}
