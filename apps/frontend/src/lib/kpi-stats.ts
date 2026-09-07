// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * KPI 摘要卡的數字算法(純函式,沒有 React,方便直接測)。
 *
 * 為什麼要單獨一支:這幾個數字必須跟後端同一個口徑,而口徑最容易走散的地方
 * 就是「逾期」。原本卡片的判斷是「成交 → 不算、放棄 → 不算、其餘只要過期就算逾期」,
 * 後端 crm-scope-filters.ts 的 overdueCustomerWhere 則是 stage NOT IN (全部終止階段)。
 * 差別在管理員自己加的終止階段(例如「暫緩」「不再接觸」):
 * 卡片會把它們算成逾期,後端不會 —— 同一個畫面上 KPI 卡逾期 3、
 * 本週工作報告 1、主管戰情 1,而三個數字都沒有錯誤訊息。
 *
 * 這裡一律以 terminal 旗標判斷(對應後端 dev_stages.is_terminal),
 * 不看階段代碼。保留代碼 converted / dropped 只用在「成交轉換率」那一個比值上。
 */
import { LOST_STAGE_KEY, WON_STAGE_KEY } from '@mitchcrm/shared/vocab';

/** 算數字只需要階段與下次跟進時間,其餘欄位不管 */
export interface KpiCustomer {
  stage: string;
  nextFollowUpAt: string | null;
}

/** 只用得到這三格,跟 lib/app-settings 的 StageDef 相容 */
export interface KpiStage {
  key: string;
  label: string;
  terminal: boolean;
}

export interface KpiStats {
  inDev: number;
  interested: number;
  overdue: number;
  converted: number;
  dropped: number;
  /** 0–100 的整數;分母為 0 時為 null */
  conversionRate: number | null;
}

/** 下次跟進時間已經過了 */
export function isOverdueAt(iso: string | null, now: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < now;
}

/**
 * 從一份客戶陣列算出 KPI 卡的五個數字。
 *
 * @param stages 目前生效的階段設定(來自後台,見 lib/app-settings)
 * @param now    現在時刻的毫秒數,測試可以固定
 */
export function computeKpiStats(
  customers: readonly KpiCustomer[],
  stages: readonly KpiStage[],
  now: number = Date.now(),
): KpiStats {
  const inProgress = new Set(stages.filter((s) => !s.terminal).map((s) => s.key));
  const terminal = new Set(stages.filter((s) => s.terminal).map((s) => s.key));
  // 「快到手」的那一格:進行中階段裡排最後面的一個(預設設定就是「有意願」)
  const nearWin = stages.filter((s) => !s.terminal).slice(-1)[0]?.key ?? '';

  let inDev = 0;
  let interested = 0;
  let overdue = 0;
  let converted = 0;
  let dropped = 0;
  for (const c of customers) {
    if (inProgress.has(c.stage)) inDev += 1;
    if (c.stage === nearWin) interested += 1;
    if (c.stage === WON_STAGE_KEY) converted += 1;
    else if (c.stage === LOST_STAGE_KEY) dropped += 1;
    /*
     * 逾期只看「是不是終止階段」,與後端 overdueCustomerWhere 同一套。
     * 用 converted / dropped 兩個代碼判斷的話,後台自己加的終止階段會被算成逾期,
     * 而那些客戶的舊跟進時間永遠清不掉,卡片就會一直掛著一個使用者處理不了的數字。
     *
     * 設定裡查不到的階段(例如某一階被停用、還有客戶停在上面)當成還在跑:
     * 寧可提醒一次,也不要讓一筆真的逾期的客戶從提醒裡消失。
     */
    if (!terminal.has(c.stage) && isOverdueAt(c.nextFollowUpAt, now)) overdue += 1;
  }
  const denominator = converted + inDev + dropped;
  const conversionRate = denominator === 0 ? null : Math.round((converted / denominator) * 100);
  return { inDev, interested, overdue, converted, dropped, conversionRate };
}
