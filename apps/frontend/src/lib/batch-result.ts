// ref:3687 mc/陳彥輔/米球®
// 整批刪除 / 整批還原的結果說法(純函式,無 React 相依,方便單元測試)。
// 畫面在 app/admin/crm/data/page.tsx。
//
// ── 這一支在救什麼 ────────────────────────────────────────────────
// 兩支整批端點都會「做掉一部分、擋下一部分」,而擋下來的那幾筆才是使用者
// 唯一需要知道的事:他按了整批還原,回收桶卻沒有清空。
//
// 整批刪除那一半本來就有好好講(blockedCount),整批還原那一半只印
// 「已還原 N 筆」—— 後端回的 skipped 完全沒有消費端,被跳過的那幾筆為什麼
// 還留在回收桶,畫面上一個字都沒有。使用者的結論會是「還原壞掉了」,
// 而真正的原因(案件編號撞號、階段被停用或刪掉)就寫在那個沒人讀的欄位裡。
//
// 補上消費端之後還有第二段:skipped 是**截斷過的明細**(後端最多回 50 筆),
// 拿它的長度當總數,一批 60 筆整批被擋時畫面會少報 10 筆。總數要吃後端另外
// 回的 skippedCount,與整批刪除的 blockedCount 同形狀。
//
// 所以兩支的說法放在同一個檔案、用同一個句型:先講做掉幾筆,再講剩下幾筆與為什麼。

/** 整批還原時被跳過的一筆:它為什麼還留在回收桶 */
export interface RestoreSkipped {
  id?: string;
  companyName: string;
  message: string;
}

/** 訊息裡最多列出幾家公司名,再多就只講總數(狀態列不是報表) */
export const SKIPPED_SHOWN = 3;

/**
 * 整批還原的結果說法。
 *
 * skippedCount 為 0 時就只講還原了幾筆;不是 0 的話一定要接著講
 * 「另有幾筆留在回收桶」與前幾筆的原因,不能讓數字自己不對上。
 *
 * ── 為什麼總數是獨立的參數,不是 skipped.length ──────────────────
 * 後端的 skipped 是**截斷過的明細**(最多 50 筆),真實總數在另一格
 * skippedCount 裡。拿 skipped.length 當總數的話,一批 60 筆整批被擋
 * (那一批的階段被停用或刪掉,是很日常的情況)時,畫面會寫
 * 「已還原 0 筆,另有 50 筆留在回收桶」,而回收桶裡實際上還有 60 筆 ——
 * 這是救援流程,數字對不上會讓人以為已經處理掉 10 筆。
 * 整批刪除那一半一直是這樣做的(blocked 明細 + blockedCount 總數)。
 *
 * 所以總數是必填參數而不是有預設值的選填:漏傳會在編譯期紅燈,
 * 不會安靜地退回「用明細長度當總數」的舊行為。
 */
export function describeBatchRestore(
  restored: number,
  skipped: readonly RestoreSkipped[],
  skippedCount: number,
): string {
  const head = `已還原 ${restored} 筆`;
  // 明細比總數多是不可能的,真的發生就以明細為準(寧可多講,不要少報)
  const total = Math.max(skippedCount, skipped.length);
  if (total <= 0) return head;
  const shown = skipped
    .slice(0, SKIPPED_SHOWN)
    .map((s) => `${s.companyName}(${s.message})`)
    .join(';');
  // 明細整個沒回來(例如舊版後端只回總數)時就只講數字,不留一個空的冒號
  if (!shown) return `${head},另有 ${total} 筆留在回收桶`;
  const more = total > SKIPPED_SHOWN ? ` 等 ${total} 筆` : '';
  return `${head},另有 ${total} 筆留在回收桶:${shown}${more}`;
}

/**
 * 整批刪除的結果說法。
 * 被擋下來的原因是同一套(有互動紀錄、有存證照片、已成交),不逐筆列公司名,
 * 逐筆明細在回應的 blocked 裡,畫面上講清楚「要找誰」就夠。
 */
export function describeBatchDelete(deleted: number, blockedCount: number): string {
  const head = `已刪除 ${deleted} 筆`;
  if (blockedCount <= 0) return head;
  return `${head},另有 ${blockedCount} 筆因為已經有互動紀錄、存證照片或已成交而保留,需要系統管理員逐筆確認`;
}
