// ref:3687 mc/陳彥輔/米球®
/**
 * /privacy 的長篇正文標記
 *
 * 這一層只做一件事:把整頁標成 `.prose`,讓 globals.css 裡的段落間距規則
 * (WCAG 2.1 AAA 1.4.8 Visual Presentation,段距 ≥ 1.5 × 行距)生效。
 *
 * 為什麼是 opt-in 而不是全站套:那條規則的 specificity 贏得過 Tailwind 的
 * `space-y-*`,全站套會把頁尾、後台 meta 卡、表單欄位的 hint/error 這些
 * **刻意排緊**的地方一律撐成 38.4px。1.4.8 管的是「blocks of text」,
 * 不是每一對相鄰的 <p>。完整推導見 globals.css 的段落間距註解區塊。
 *
 * 為什麼寫在 layout 而不是 page:page 元件由別人維護中,而「這條路由是長篇
 * 正文」是路由層級的事實,放在 layout 是它該在的位置;新增正文頁時照抄這一份即可。
 *
 * 實際間距以建置產物為準,
 * `.prose` 內比值 < 1.5 紅燈,`.prose` 外被這條規則搶走邊距也紅燈。
 */
export default function PrivacyProseLayout({ children }: { children: React.ReactNode }) {
  return <div className="prose">{children}</div>;
}
