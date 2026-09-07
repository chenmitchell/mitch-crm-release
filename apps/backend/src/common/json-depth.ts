// ref:3687 mc/陳彥輔/米球®
/**
 * 請求本體的巢狀深度上限。
 *
 * 為什麼需要這一層:全域的 ValidationPipe 開了 `transform`,class-transformer 對
 * 沒有宣告 @Type 的屬性會做遞迴深拷貝。深度大約一千五以上時它會爆
 * `RangeError: Maximum call stack size exceeded` —— 那不是 HttpException,
 * 於是整條路徑落到 GlobalExceptionFilter,回 500 並寫一列 error_logs
 * (message 1000 字 + stack 8000 字)。
 *
 * 觸發成本低到不像話:
 *   POST /api/auth/login,body 塞一個 `"junk": [[[[...]]]]`,
 *   兩千層大約 4KB,遠低於 100kb 的上限,**而且不需要任何憑證**。
 *   每打一次就是一列 error_logs,重複打就是把錯誤記錄灌爆。
 *
 * 所以在 body-parser 之後、ValidationPipe 之前先量一次深度,超過門檻直接 400。
 * 400 是使用者輸入問題,GlobalExceptionFilter 不會寫 DB(4xx 不落地),
 * 灌記錄的那條路徑一併斷掉。
 *
 * 量深度本身不能用遞迴 —— 那會用同一支堆疊爆同一種錯。這裡用顯式堆疊迭代。
 */

/**
 * 允許的最大巢狀深度。
 *
 * 本系統最深的合法結構是設定裡的物件對物件(例:photoChecklist 的
 * 「種類 → 檢查項目陣列」、lookupFieldMap 的欄位對應),個位數的深度就夠用;
 * 打卡上傳的照片陣列也只有兩三層。32 是「合法輸入永遠碰不到、
 * 攻擊性輸入一定碰得到」之間留了很大餘裕的一個數字。
 * 調小的風險是誤擋正常請求,調大的風險是留一段沒有意義的空間給攻擊者,
 * 兩邊都不急著動它。
 */
export const MAX_BODY_DEPTH = 32;

/**
 * 已解析的 JSON 值的巢狀深度。純量是 0,`{}` / `[]` 是 1,`{"a":{}}` 是 2。
 *
 * 一旦超過 limit 就立刻回報,不必把整棵樹走完 —— 攻擊性輸入的重點就是很深,
 * 提早停下來讓這個檢查的成本跟「攻擊的深度」無關。
 *
 * 迭代而非遞迴:這支函式的存在理由就是別人遞迴爆了堆疊,
 * 它自己再遞迴一次只是換一個地方爆。
 *
 * @returns 實際深度;超過 limit 時回 limit + 1(只保證「大於 limit」,不保證精確值)
 */
export function jsonDepth(value: unknown, limit: number = MAX_BODY_DEPTH): number {
  if (value === null || typeof value !== 'object') return 0;

  let max = 0;
  // 顯式堆疊:[要走的值, 它所在的深度]
  const stack: Array<[unknown, number]> = [[value, 1]];
  // 走過的容器,擋掉 body-parser 理論上不會產生、但防呆要有的循環參照
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const top = stack.pop();
    /* c8 ignore next */
    if (!top) break;
    const [node, depth] = top;
    if (node === null || typeof node !== 'object') continue;

    const obj = node as object;
    if (seen.has(obj)) continue;
    seen.add(obj);

    if (depth > max) max = depth;
    // 超過門檻就不必再往下走了,呼叫端只需要知道「太深」
    if (max > limit) return limit + 1;

    const children = Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }

  return max;
}

/** 超過門檻時回給使用者的訊息。刻意不回報實際深度,那對正常使用者沒有意義 */
export const TOO_DEEP_MESSAGE = '請求內容的巢狀層數過深';
// ref:3687 mc/陳彥輔/米球®
