// CRM 共用的對外訊息常數。
// 抽成獨立檔的理由跟 crm-stats.service.ts 一樣:crm-checkin.service 只需要這一句訊息,
// 不該為了它 import 整個 CrmService(那會讓 checkin 依賴 CrmService 連帶的 CrmGeoService 等相依)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

/**
 * 已被合併的客戶不可再操作。
 *
 * 訊息本身固定不帶 id:它會直接顯示給使用者看,而一串 uuid 對人沒有意義。
 * 保留筆的 id 改成獨立的 mergedIntoId 欄位,由呼叫端決定要不要帶(見 mergedCustomerError)。
 *
 * 「帶不帶 id」原本兩份註解互相打架:crm.service 說「把保留筆的 id 帶回去讓前端可以導過去」,
 * crm-checkin.service 說「不吐那個 id 是為了防外洩」,而實際回的訊息裡根本沒有 id,
 * 前端那段抓 uuid 的程式因此永遠到不了。定案是**帶,但只帶給看得到保留筆的人**:
 * 合併只發生在同一個可視範圍之內(查重服務用同一份 ViewScope 撈候選),
 * 對已經通過權限檢查、看得到保留筆的人來說,那個 id 不是新資訊;
 * 對看不到的人則一律不帶(呼叫端傳 null),他只會拿到訊息。
 */
export const MERGED_CUSTOMER_MESSAGE = '此客戶已合併到另一筆,請回客戶清單改用保留的那筆';

/** 已被合併時丟出的 400 內容。mergedIntoId 為 null 表示這個人看不到保留筆,不帶 id */
export function mergedCustomerError(mergedIntoId: string | null): {
  message: string;
  mergedIntoId: string | null;
} {
  return { message: MERGED_CUSTOMER_MESSAGE, mergedIntoId };
}

/**
 * 找不到、看不到、已經被硬刪掉,一律同一句(不洩漏這筆存不存在)。
 *
 * 客戶卡、拜訪排程、到訪打卡、查重合併、刪除原本各自寫死同一句字串,
 * 任何一處改字都會讓「查不到與沒權限回同一種訊息」出現破口,而且畫面上看不出來,
 * 所以集中在這裡,呼叫端一律引用不要再自己寫。
 */
export const CUSTOMER_NOT_FOUND_MESSAGE = '找不到此客戶';

/** 客戶卡 / 合併結果回傳的時間軸筆數上限:不設上限等於把整段互動歷史一次吐出來 */
export const INTERACTIONS_TAKE = 50;

/**
 * 成交事件的系統紀錄前綴。
 *
 * 「這位客戶是哪一天成交的」DB 沒有存(stage 是快照,沒有時間),所以統計是靠
 * 這個前綴去數互動紀錄。前綴改字要連 crm.service(寫入)與 crm-stats.service(計數)
 * 一起改,只改一邊的話報表會安靜地變成 0,而且畫面上完全正常。
 */
export const CONVERTED_NOTE_PREFIX = '【已成交】';

/**
 * 不是 CRM 角色時的拒絕訊息。守衛在 crm-roles.ts,訊息放這裡是為了讓
 * 「對外講什麼話」全部集中在同一支,不必為了一句字串去讀守衛的實作。
 *
 * 「開發 CRM」是內部叫法,拿到畫面上使用者不知道那是什麼,也不知道下一步該找誰。
 * 訊息要說清楚兩件事:這個帳號現在不能做什麼,以及去找誰開通。
 */
export const CRM_FORBIDDEN_MESSAGE = '你的帳號沒有客戶管理的使用權限,請找系統管理員開通';

/** 不是主管級角色時的拒絕訊息(審日報、戰情圖表、指派負責人都用同一句) */
export const CRM_MANAGER_FORBIDDEN_MESSAGE = '僅訪查主管與系統管理員可執行此操作';
