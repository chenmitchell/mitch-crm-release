// ref:3687 mc/陳彥輔/米球®
/**
 * 客戶刪除的規則(純函式,不碰 Prisma 也不碰 Nest)。
 *
 * ── 為什麼要有刪除 ──────────────────────────────────────────────
 * 在這之前系統沒有任何刪除客戶的路徑。匯入一出錯(欄位錯位、編碼壞掉、
 * 同事重複匯同一份名單),那批假資料就永久留在秒查、看板、查重、統計與地圖裡。
 * 唯一的軟路徑是逐筆改成終止階段(三百筆就是點三百次,而且它們還在查重候選裡),
 * 硬路徑是找工程師連進資料庫下 DELETE。這對「一家公司要上線」是不能接受的。
 *
 * ── 為什麼是軟刪除而不是硬刪 ────────────────────────────────────
 * 定案:預設軟刪除(標記 deleted_at,所有查詢排除),硬刪只留給管理員明確操作。
 *
 * 1. 誤刪要救得回來。刪除本身就是誤操作最常發生的地方,而「刪錯了」與
 *    「匯錯了」是同一種手滑。硬刪之後唯一的救援是還原整個資料庫備份,
 *    那會把刪除之後其他人做的每一件事一起還原掉,代價遠大於問題本身。
 * 2. 硬刪會沿著外鍵把互動紀錄與存證照片一起帶走(dev_interactions 與
 *    dev_visit_photos 都是 onDelete: Cascade)。存證照片是這套系統的核心價值,
 *    它不該因為一次「清掉測試資料」的操作安靜消失。
 * 3. 統計要能對得起來。已刪除的客戶留在表上,事後要查「上個月的數字為什麼變了」
 *    才有東西可看,回收桶本身就是那份交代。
 *
 * 代價是資料表會長胖,尤其是照片。所以保留硬刪(purge):管理員在回收桶裡
 * 明確按下去,才會真的把列與照片刪掉,而且一定留稽核紀錄。
 *
 * ── 什麼情況要擋 ────────────────────────────────────────────────
 * 有人真的跑過、留下證據的客戶不該被一鍵刪掉:有人工互動紀錄、有存證照片、
 * 已成交。這三種預設擋下並說明理由;管理員可以帶 force 強制,那一次會寫稽核。
 * 「安靜的硬刪」是這裡最不想做出來的東西 —— 使用者按一下,證據沒了,沒有人知道。
 */

/** 判斷用得到的客戶現況(從 DB 讀一次就夠,不要在規則裡再查) */
export interface DeletableCustomerFacts {
  /** 已經被查重合併掉的那一筆(mergedIntoId 不為 null) */
  readonly merged: boolean;
  /** 已經被刪掉了 */
  readonly alreadyDeleted: boolean;
  /** 已成交(stage 是成交階段,或有外部案件編號) */
  readonly converted: boolean;
  /** 人工互動紀錄筆數(不含【開頭的系統紀錄) */
  readonly humanInteractions: number;
  /** 存證照片張數 */
  readonly photos: number;
}

/** 擋下來的原因代碼。前端用它決定要不要顯示「仍要刪除」 */
export type DeleteBlockCode = 'merged' | 'already_deleted' | 'converted' | 'has_history';

export interface DeleteBlock {
  readonly code: DeleteBlockCode;
  readonly message: string;
  /** 管理員帶 force 就可以蓋過去嗎 */
  readonly forcible: boolean;
}

/**
 * 這一筆客戶現在可以刪嗎。回 null 表示可以,回物件表示擋下來的理由。
 *
 * 順序有意義:合併與重複刪除是「這個操作本身沒有意義」,連 force 都不該放行;
 * 已成交與有紀錄是「有代價的刪除」,管理員知道自己在做什麼就可以繼續。
 */
export function deleteBlockOf(facts: DeletableCustomerFacts): DeleteBlock | null {
  if (facts.merged) {
    return {
      code: 'merged',
      message: '此客戶已合併到另一筆,資料都在保留的那筆上,不必也不能單獨刪除',
      forcible: false,
    };
  }
  if (facts.alreadyDeleted) {
    return { code: 'already_deleted', message: '此客戶已經在回收桶裡', forcible: false };
  }
  if (facts.converted) {
    return {
      code: 'converted',
      message: '此客戶已成交,刪除會一併帶走成交紀錄;需要系統管理員確認後才能刪除',
      forcible: true,
    };
  }
  if (facts.humanInteractions > 0 || facts.photos > 0) {
    const parts: string[] = [];
    if (facts.humanInteractions > 0) parts.push(`${facts.humanInteractions} 筆互動紀錄`);
    if (facts.photos > 0) parts.push(`${facts.photos} 張存證照片`);
    return {
      code: 'has_history',
      message: `此客戶已經有${parts.join('與')},不是一筆空資料;需要系統管理員確認後才能刪除`,
      forcible: true,
    };
  }
  return null;
}

/** 使用者按了「仍要刪除」,但他不是管理員時的訊息 */
export const FORCE_REQUIRES_ADMIN_MESSAGE =
  '這一筆有紀錄或已成交,只有系統管理員可以強制刪除,請聯絡管理者';

/** 回收桶(檢視已刪除、還原、硬刪)不是每個人都能進的 */
export const TRASH_FORBIDDEN_MESSAGE = '僅訪查主管與系統管理員可檢視回收桶';

/** 硬刪只有系統管理員 */
export const PURGE_FORBIDDEN_MESSAGE = '僅系統管理員可永久刪除客戶';

/** 回收桶裡找不到這一筆 */
export const TRASH_NOT_FOUND_MESSAGE = '回收桶裡找不到此客戶';

/**
 * 還原被擋下來的兩種情況。
 *
 * 還原一律不改客戶的任何一格(見 RESTORE_KEEPS_STAGE),所以「還原之後這一筆會不會
 * 跟現在的資料打架」只能在還原前問。兩種打架方式都會造成**看不見的壞掉**:
 *   階段被刪掉了:客戶的 stage 指向一個不存在的代碼,看板上沒有任何一欄放得下它,
 *     它會安靜地從畫面消失,而且沒有錯誤訊息可以循線找回來;
 *   案件編號被別人用了:兩筆活著的客戶掛同一個外部案件編號,對帳時分不出是哪一位
 *     (那個欄位沒有資料庫層的唯一索引,不會有人替我們擋)。
 * 兩句都要說得出「現在該做什麼」,不能只說還原失敗。
 */
export function restoreStageMissingMessage(stageKey: string): string {
  return `這一筆客戶停在「${stageKey}」這個階段,而該階段已經被刪除,還原之後它不會出現在任何看板欄位裡。請先到系統設定把這個階段加回來,再還原`;
}

/**
 * 「一個編號只能對到一位客戶」這件事,說不出對方是誰的那一版。
 *
 * 用在兩個地方:
 *   1. 標記成交查到已經有人佔著(CrmService.markConverted,原本就是這一句)
 *   2. 應用層檢查放行之後,資料庫的 partial unique index
 *      (dev_customers_external_case_ref_live_key)才擋下來的那條競態
 *
 * 第 2 種情況拿不到對方的公司名:那筆客戶是在我們檢查完之後才變成活著的,
 * 而交易此刻已經被中止,問不到任何東西。所以這一句不提對方是誰 ——
 * 說得出來的用 restoreCaseRefTakenMessage(那一句更好),說不出來的用這一句,
 * 兩句都比一個「伺服器發生未預期的錯誤」加一列 error_logs 好。
 */
export const CASE_REF_TAKEN_MESSAGE = '此案件編號已對應其他客戶';

export function restoreCaseRefTakenMessage(caseRef: string, companyName: string): string {
  return `這一筆客戶的案件編號 ${caseRef} 目前已經對應到「${companyName}」,一個編號只能對到一位客戶。請先清掉其中一邊的案件編號,再還原`;
}

/**
 * 整批還原時,**同一批裡**兩筆共用同一個案件編號。
 *
 * 分成兩句話的理由是使用者的下一步不一樣:上面那句是「外面有人佔著」,
 * 到回收桶外面找得到那一筆;這一句是「跟你正在還原的另一筆撞」,
 * 兩筆都還在回收桶裡,要處理的是這一批自己。
 */
export function restoreCaseRefDuplicateInBatchMessage(
  caseRef: string,
  companyName: string,
): string {
  return `這一筆客戶的案件編號 ${caseRef} 跟同一批裡的「${companyName}」相同,一個編號只能對到一位客戶,所以這一批只還原得回其中一筆。請先清掉其中一邊的案件編號,再還原這一筆`;
}

/**
 * 階段還在,但已經被停用。
 *
 * 只問「階段存不存在」不夠:停用的階段不出現在看板欄位也不出現在表單下拉,
 * 還原回去的客戶會落在一個畫面上沒有的欄位裡,症狀跟階段被整個刪掉一模一樣
 * (安靜地不見,而且沒有訊息可以循線找回來)。
 */
export function restoreStageInactiveMessage(stageKey: string, label: string): string {
  return `這一筆客戶停在「${label}」(${stageKey})這個階段,而該階段目前是停用狀態,還原之後它不會出現在看板欄位裡。請先到系統設定把這個階段重新啟用,再還原`;
}

/** 稽核記錄的 action 代碼(寫進 audit_logs.action,長度上限 50) */
export const DELETE_AUDIT_ACTIONS = {
  delete: 'crm.customer.delete',
  batchDelete: 'crm.customer.batch_delete',
  restore: 'crm.customer.restore',
  purge: 'crm.customer.purge',
} as const;

/**
 * 保留筆被永久刪除之後,原本併進它的那幾筆客戶備註上要寫的那一句。
 *
 * 以「【」開頭,與其他系統紀錄同一套寫法(見 crm-scope-filters 的 isSystemNote):
 * 這不是使用者自己寫的字,統計與匯出要分得出來。
 */
export function purgedSurvivorNote(survivorName: string): string {
  return `【合併保留筆已永久刪除】原本合併到「${survivorName}」,那一筆已被系統管理員永久刪除,資料無法再取回`;
}

/**
 * 永久刪除一筆保留筆時,最多逐筆改寫幾筆客戶的備註。
 *
 * 超過這個數量的剩下那些只把 merged_into_id 清掉(指標懸空才是會壞掉的部分,
 * 備註只是說明)。一次合併鏈長到上千筆是不正常的資料,不值得為它拖長一個交易。
 */
export const UNLINK_NOTE_MAX = 500;

/**
 * 備註寫回去時的長度上限。dev_customers.note 是 text 沒有欄位長度,
 * 這個上限是為了「客戶卡上那一格還讀得完」,不是資料庫的限制。
 */
export const CUSTOMER_NOTE_MAX = 4000;

/** 刪除原因的長度上限(對齊 schema 的 varchar(300)) */
export const DELETE_REASON_MAX = 300;

/** 一次整批刪除最多處理幾筆。匯入一次上限是 IMPORT_MAX_ROWS,這裡取同一個量級 */
export const BATCH_DELETE_MAX = 2000;

/** 回收桶一頁最多幾筆 */
export const TRASH_LIST_TAKE = 200;

/** 「最近幾次匯入」列幾批。這是給人挑的清單,不是報表,20 批已經涵蓋幾週的匯入 */
export const IMPORT_BATCH_LIST_TAKE = 20;

/**
 * 還原時要不要改階段:不要。
 *
 * 還原就是把 deleted_at 清掉,其餘一格都不動。曾經考慮過「還原時順便放回第一階」,
 * 但那會把使用者刪除前的進度洗掉 —— 誤刪的救援不該再造成第二次資料損失。
 */
export const RESTORE_KEEPS_STAGE = true;
