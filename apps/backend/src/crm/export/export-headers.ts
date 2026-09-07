// ref:3687 mc/陳彥輔/米球®
/**
 * 匯出回應的自訂標頭名稱,集中在一處。
 *
 * 為什麼要獨立成一個檔:這幾個標頭有兩個必須一致的使用點,而它們離得很遠 ——
 * 控制器那一端 setHeader 把值寫出去(crm-export.controller.ts),
 * 啟動那一端要把同樣這幾個名字放進 CORS 的 exposedHeaders(main.ts)。
 * 兩邊各寫一份字串的話,少打一個名字的症狀是:單一網域部署下一切正常,
 * 換成前後端不同網域,前端 res.headers.get() 就安靜地回 null ——
 * 沒有錯誤、沒有警告,只是「截斷提示」再也不會出現。
 *
 * 跨網域時瀏覽器預設只讓 JavaScript 讀到七個安全清單內的回應標頭
 * (Cache-Control、Content-Language、Content-Length、Content-Type、
 *  Expires、Last-Modified、Pragma),其餘一律要伺服器明確放行。
 */

/** 匯出回應會帶的自訂標頭 */
export const EXPORT_COUNT_HEADER = 'X-Export-Count';
export const EXPORT_TRUNCATED_HEADER = 'X-Export-Truncated';
export const EXPORT_NEXT_OFFSET_HEADER = 'X-Export-Next-Offset';
export const EXPORT_TOTAL_BYTES_HEADER = 'X-Export-Total-Bytes';

/**
 * 跨網域時要讓前端讀得到的回應標頭。
 *
 * Content-Disposition 也在裡面:下載的檔名是從那個標頭讀出來的,
 * 少了它,跨網域下載的檔案會變成沒有名字(或是一串 uuid)。
 */
export const EXPORT_EXPOSED_HEADERS: readonly string[] = [
  'Content-Disposition',
  EXPORT_COUNT_HEADER,
  EXPORT_TRUNCATED_HEADER,
  EXPORT_NEXT_OFFSET_HEADER,
  EXPORT_TOTAL_BYTES_HEADER,
];
