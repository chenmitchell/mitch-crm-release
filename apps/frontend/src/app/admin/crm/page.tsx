// 舊入口(/admin/crm)。內容已拆成 home / new / search / board / stats / import 各頁,
// 這裡只把人導到我的首頁,舊書籤與舊連結才不會落到空頁。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { redirect } from 'next/navigation';

export default function CrmIndexPage() {
  redirect('/admin/crm/home');
}
