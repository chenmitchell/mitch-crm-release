/**
 * 登入角色的中文標籤對照(集中一份)
 *
 * 後台側欄的角色徽章、使用者管理清單、建立使用者下拉全部用這一份,
 * 不各自寫一份 —— 散在各處遲早對不齊(某頁改了標籤別頁沒改)。
 *
 * 三種角色與權限速記(權限矩陣的真理在後端,這裡只放標籤與一句說明):
 *   admin         系統管理員   全部權限,看得到全部客戶與戰情
 *   sales         訪查人員     只管自己負責的客戶,可建客戶
 *   sales_manager 訪查主管     看自己團隊的客戶與戰情,可建客戶、管團隊
 *
 * 口徑以後端 apps/backend/src/scope/view-scope.ts 為準:訪查主管看的是
 * 「自己團隊(所屬主管指向自己的人)加上自己所屬部門子樹」,不是全公司。
 * 這裡的說明寫成「看全部」的話,主管會以為看板漏資料是系統壞了。
 *
 * 這三個就是後端 schema 的 UserRole 列舉的全部。roleLabel 仍然對認不得的值原樣回傳:
 * 資料庫裡若有髒資料,畫面該照樣顯示得出來,而不是整頁壞掉。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

export type UserRole = 'admin' | 'sales' | 'sales_manager';

export const USER_ROLE_LABEL: Record<UserRole, string> = {
  admin: '系統管理員',
  sales: '訪查人員',
  sales_manager: '訪查主管',
};

/** 建立 / 檢視使用者時的角色清單(順序即下拉選單順序),每一項附一句說明 */
export const USER_ROLE_OPTIONS: ReadonlyArray<{
  value: UserRole;
  label: string;
  hint: string;
}> = [
  { value: 'sales', label: '訪查人員', hint: '只管自己負責的客戶,可以建客戶、打卡、寫日報' },
  { value: 'sales_manager', label: '訪查主管', hint: '看自己團隊的客戶與戰情,可以管團隊成員' },
  { value: 'admin', label: '系統管理員', hint: '全部權限,含系統設定與使用者管理' },
];

/** 安全取標籤:認得的回中文,認不得的原樣回傳(不讓畫面因為髒資料整個壞掉) */
export function roleLabel(role: string | null | undefined): string {
  if (role && role in USER_ROLE_LABEL) return USER_ROLE_LABEL[role as UserRole];
  return role ?? '';
}
