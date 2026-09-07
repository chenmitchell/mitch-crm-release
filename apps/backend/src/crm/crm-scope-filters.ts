// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 「哪些紀錄算數」的 where 片段,單一份。
 *
 * 為什麼要有這一支:同一週的同一位訪查人員,本週工作報告說 3 筆互動、
 * 主管戰情圖表說 0 筆,兩邊都沒有錯誤訊息,而使用者只會覺得「數字是錯的」。
 * 原因是兩支各自組 where:報告沒排除系統紀錄(【客戶移交】【照片刪除】
 * 【合併】【已成交】全被當成互動)、逾期沒排除終止階段、互動也沒有作者條件
 * (主管在我客戶上寫的備註算成我的)。
 *
 * 排除規則寫在這裡一份,兩支都引用,走散這件事就不可能發生。
 * 純函式,不碰 Prisma Client 執行期也不碰 Nest,測試直接餵值。
 */
import type { Prisma } from '@prisma/client';
import { VISIT_CHANNEL_KEY } from '@mitchcrm/shared';
import { SYSTEM_NOTE_PREFIX } from './checkin/checkin-rules';
import { CONVERTED_NOTE_PREFIX } from './crm-messages';
import { relatedOwnerFilter, type ViewScope } from '../scope/view-scope';

export { SYSTEM_NOTE_PREFIX };

/** note 是否為系統紀錄(以「【」開頭);null / 空字串都不是 */
export function isSystemNote(note: string | null | undefined): boolean {
  return typeof note === 'string' && note.startsWith(SYSTEM_NOTE_PREFIX);
}

/**
 * 互動計數用的 where 片段:排除系統紀錄。
 *
 * 寫成 OR(note 為 null 或不以【開頭),不用 NOT + startsWith:
 * SQL 的 NOT (note LIKE '【%') 在 note 為 NULL 時是 NULL,
 * 那會把沒寫備註的拜訪也一起排掉。
 */
export function humanInteractionWhere(): Prisma.DevInteractionWhereInput {
  return { OR: [{ note: null }, { NOT: { note: { startsWith: SYSTEM_NOTE_PREFIX } } }] };
}

/**
 * 可疑拜訪的 where 片段:期間內、channel=visit、gpsSuspicious=true。
 * 打卡的 note 不會以【開頭,所以不用再排系統紀錄。
 */
export function suspiciousVisitWhere(from: Date): Prisma.DevInteractionWhereInput {
  return { occurredAt: { gte: from }, channel: VISIT_CHANNEL_KEY, gpsSuspicious: true };
}

/** 拜訪計數用的 where 片段:期間內、channel=visit,且不是系統紀錄 */
export function visitInteractionWhere(from: Date): Prisma.DevInteractionWhereInput {
  return { occurredAt: { gte: from }, channel: VISIT_CHANNEL_KEY, ...humanInteractionWhere() };
}

/**
 * 「這一筆客戶沒有被刪掉」的 where 片段。
 *
 * 軟刪除的整個賣點是「刪掉的東西真的看不見」。漏掉任何一支查詢的症狀都一樣:
 * 使用者刪了一批匯錯的資料,清單乾淨了,可是查重照樣把它們配成重複、
 * 戰情圖表照樣把它們算進漏斗、地圖上照樣有一堆點 —— 而畫面完全不會說為什麼。
 * 所以條件寫成一份,每一支要「數客戶」或「列客戶」的地方都套這一份。
 */
export function notDeletedWhere(): Prisma.DevCustomerWhereInput {
  return { deletedAt: null };
}

/**
 * 互動查詢用的片段:限縮可見範圍,同時排除「客戶已被刪掉」的互動。
 *
 * 不能直接寫 `{ ...relatedOwnerFilter(view), customer: { deletedAt: null } }` ——
 * 兩邊都是 customer 這個鍵,後面那個會整個蓋掉前面的可見範圍條件,
 * 結果是本來只看團隊的統計變成看全公司,而測試與畫面都不會有任何異狀。
 * 所以在這裡把兩者合成同一個 customer 物件。
 */
export function relatedLiveCustomerFilter(view: ViewScope): Prisma.DevInteractionWhereInput {
  return relatedLiveCustomerWhere(view) as Prisma.DevInteractionWhereInput;
}

/**
 * 同一件事,但不綁 DevInteraction 的型別。
 *
 * 「透過 customer 關聯限縮 + 排除已刪除」不是只有互動需要:拜訪排程、存證照片
 * 也是同一個形狀,而 Prisma 的 WhereInput 是逐模型的型別,直接拿上面那支去套
 * 會被型別擋下來。擋下來之後最容易的路是「就地手寫一份」,而手寫的那一份
 * 正是這個檔案存在的理由 —— 兩個 customer 鍵展開會互相覆寫,
 * 覆寫掉的是可見範圍,而且沒有任何測試或畫面會有異狀。
 */
export function relatedLiveCustomerWhere(view: ViewScope): Record<string, unknown> {
  const related = relatedOwnerFilter(view).customer as Record<string, unknown> | undefined;
  return { customer: { ...(related ?? {}), deletedAt: null } };
}

/** 互動查詢用的片段:只排除「客戶已被刪掉」,可見範圍由呼叫端另外用 authorFilter 限縮 */
export function liveCustomerFilter(): Prisma.DevInteractionWhereInput {
  return { customer: { deletedAt: null } };
}

/** 新客戶計數用的 where 片段:排除已被合併掉與已被刪掉的客戶 */
export function newCustomerWhere(from: Date): Prisma.DevCustomerWhereInput {
  return { createdAt: { gte: from }, ...countableCustomerWhere() };
}

/**
 * 「這一筆客戶算不算數」的 where 片段:被查重合併掉的那一筆不算。
 *
 * 合併之後,被併掉的那一筆會留在資料表裡(稽核要看得到),stage 被標成 dropped,
 * 而它的內容都已經搬到保留的那一筆。清單與看板一直都排除它(list() 的
 * mergedIntoId: null),漏斗卻沒有 —— 結果是合併三筆之後漏斗的「無效/放棄」
 * 多三筆、每一階的百分比跟著偏,而看板同一欄是 0。
 * 排除規則寫成一份,誰要數客戶就套這一份。
 */
export function countableCustomerWhere(): Prisma.DevCustomerWhereInput {
  return { mergedIntoId: null, ...notDeletedWhere() };
}

/** 成交計數用的 where 片段:期間內、note 以【已成交】開頭(只有系統會寫這個前綴) */
export function convertedInteractionWhere(from: Date): Prisma.DevInteractionWhereInput {
  return { occurredAt: { gte: from }, note: { startsWith: CONVERTED_NOTE_PREFIX } };
}

/**
 * 逾期客戶的 where 片段:下次跟進時間已經過了,而且還在跑。
 *
 * 終止階段(成交、放棄,以及後台自己加的)一定要排掉:成交的客戶身上還留著
 * 一個舊的下次跟進時間,不排的話它會永遠掛在逾期清單上,而使用者無從清掉它。
 * 哪些是終止階段一律問 dev_stages.is_terminal,不寫死代碼。
 */
export function overdueCustomerWhere(
  now: Date,
  terminalKeys: readonly string[],
): Prisma.DevCustomerWhereInput {
  return {
    nextFollowUpAt: { lt: now },
    stage: { notIn: [...terminalKeys] },
    ...countableCustomerWhere(),
  };
}

/**
 * 進榜使用者的 where 片段:業務 / 訪查主管,依 ViewScope 限縮。
 *
 * 依 ViewScope 限縮是必要的 —— 沒有這一段的話,訪查主管的戰情圖表會列出全公司每一位
 * 業務的客戶數、拜訪數與貢獻分級,而 view-scope.ts 寫的口徑是主管只看自己團隊。
 *
 * 這裡**不篩帳號狀態**。原本是 status: 'active',而清單、看板、漏斗、各訪查人員狀態表
 * 都沒有這個條件,結果是同一頁上「各訪查人員狀態表合計 4、漏斗 4、貢獻度分級 1」:
 * 一位離職業務被停用之後,他名下的客戶在三張表裡有三種算法。
 *
 * 統一的方向選「全部含停用」,理由是這幾張表數的是**客戶**不是帳號:
 * 離職業務名下那些客戶還在、還會逾期、還等著被移交,把它們從統計裡拿掉
 * 不會讓它們消失,只會讓沒有人記得它們 —— 而那正是最需要被看見的一批。
 * 反過來「全部排除」則要連清單與看板一起排,那等於讓客戶在畫面上憑空不見。
 * 帳號是否停用改成用一個旗標標在該列上(見 CrmService.bySales 與
 * CrmStatsService.bySales 的 active 欄位),由畫面說明,不是靠少算一筆來表達。
 */
export function crmSalesUserWhere(view: ViewScope): Prisma.UserWhereInput {
  return {
    role: { in: ['sales', 'sales_manager'] },
    ...(view.viewAll ? {} : { id: { in: [...view.ownerIds] } }),
  };
}
