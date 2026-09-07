// 外勤拜訪的舊入口(/admin/crm/field)。內容已拆成 checkin / report / contacts 三頁,
// 這裡導到最常用的打卡頁,舊書籤與舊連結才不會落到空頁。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { redirect } from 'next/navigation';

export default function FieldIndexPage() {
  redirect('/admin/crm/field/checkin');
}
