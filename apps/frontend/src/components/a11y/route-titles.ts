// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 全站頁面名稱的單一來源(WCAG 2.4.2 Page Titled / 2.4.3 Focus Order)
 *
 * ── 為什麼會有這個檔 ────────────────────────────────────────────
 * 這套系統有二十幾頁是 client component,拿不到 Next 的 metadata,所以
 * `<title>` 全部吃根 layout 的預設值「Mitch CRM」。換頁時瀏覽器分頁標題不變、
 * `<next-route-announcer>` 也永遠是空字串,螢幕閱讀器完全不知道自己換到哪一頁了。
 * 補救的做法是掛載時自己寫 `document.title`,並把頁名播進 live region
 * (見 route-announcer.tsx)。
 *
 * ── 為什麼頁名放這裡,不放各頁 ──────────────────────────────────
 * 後台側欄本來就有一份完整的頁面名稱清單。如果標題再寫第二份,改了側欄文案
 * 標題不會跟著變,兩邊就會慢慢對不上。所以側欄的 NAV_GROUPS 搬到這個檔,
 * `admin/layout.tsx` 從這裡 import,標題也從同一份算出來 —— 一份資料兩個用途。
 *
 * 這個檔沒有 'use client',伺服器端(root layout 的 metadata)與瀏覽器端
 * (route-announcer)都 import 得動。
 */
import type { UserRole } from '@/lib/roles';

/** 產品名。root layout 的 metadata 與這裡的標題後綴共用同一個值 */
export const SITE_TITLE = 'Mitch CRM';

export interface NavItem {
  href: string;
  label: string;
  /** 允許看到這一項的登入角色;未指定 = 全部 */
  roles?: readonly UserRole[];
}

export interface NavGroup {
  /** localStorage 記展開狀態用的鍵,不要隨便改 */
  key: string;
  label: string;
  items: readonly NavItem[];
}

/**
 * 後台側欄。每一項的可見角色直接看登入角色(users.role);
 * roles 未指定 = 所有登入者都看得到(例:改密碼)。
 *
 * 對照權限矩陣:
 *   客戶管理 / 外勤拜訪   admin / 訪查人員 / 訪查主管
 *   主管戰情              admin / 訪查主管
 *   批次轉派              admin / 訪查主管
 *   團隊管理              admin / 訪查主管
 *   使用者管理 / 系統設定 / 錯誤記錄   只有 admin
 *
 * 分群的順序就是側欄由上而下的順序:每天要做的事在最前面,系統設定在最後。
 * label 同時是那一頁的 `<title>`,改文案兩邊會一起變。
 */
export const ADMIN_NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'crm',
    label: '客戶管理',
    items: [
      { href: '/admin/crm/home', label: '我的首頁', roles: ['admin', 'sales', 'sales_manager'] },
      { href: '/admin/crm/new', label: '新增客戶', roles: ['admin', 'sales', 'sales_manager'] },
      { href: '/admin/crm/search', label: '秒查客戶', roles: ['admin', 'sales', 'sales_manager'] },
      { href: '/admin/crm/board', label: '客戶看板', roles: ['admin', 'sales', 'sales_manager'] },
      {
        href: '/admin/crm/week',
        label: '本週工作報告',
        roles: ['admin', 'sales', 'sales_manager'],
      },
      { href: '/admin/crm/stats', label: '主管戰情', roles: ['admin', 'sales_manager'] },
      {
        href: '/admin/crm/duplicates',
        label: '客戶查重合併',
        roles: ['admin', 'sales', 'sales_manager'],
      },
      { href: '/admin/crm/import', label: '匯入名單', roles: ['admin', 'sales', 'sales_manager'] },
      // 匯入的客戶一律歸在匯入者名下,所以匯入的下一步幾乎一定是分派;放在匯入名單後面
      { href: '/admin/crm/transfer', label: '批次轉派', roles: ['admin', 'sales_manager'] },
      // 匯出與回收桶。放在匯入與轉派之後:它們是同一組「整批資料進出」的事,
      // 而回收桶最常見的用途正好是「上一批匯錯了」
      { href: '/admin/crm/data', label: '資料管理', roles: ['admin', 'sales', 'sales_manager'] },
    ],
  },
  {
    key: 'field',
    label: '外勤拜訪',
    items: [
      { href: '/admin/crm/map', label: '拜訪地圖', roles: ['admin', 'sales', 'sales_manager'] },
      {
        href: '/admin/crm/field/checkin',
        label: 'GPS 到訪打卡',
        roles: ['admin', 'sales', 'sales_manager'],
      },
      {
        href: '/admin/crm/field/report',
        label: '拜訪日報',
        roles: ['admin', 'sales', 'sales_manager'],
      },
      {
        href: '/admin/crm/field/contacts',
        label: '我聯絡過的客戶',
        roles: ['admin', 'sales', 'sales_manager'],
      },
      {
        href: '/admin/crm/daily-reports',
        label: '日報彙整',
        roles: ['admin', 'sales', 'sales_manager'],
      },
    ],
  },
  {
    key: 'team',
    label: '團隊管理',
    items: [
      { href: '/admin/team', label: '團隊成員', roles: ['admin', 'sales_manager'] },
      { href: '/admin/users', label: '使用者管理', roles: ['admin'] },
    ],
  },
  {
    key: 'system',
    label: '系統設定',
    items: [
      { href: '/admin/settings', label: '系統設定', roles: ['admin'] },
      { href: '/admin/errors', label: '錯誤記錄', roles: ['admin'] },
      { href: '/account/change-password', label: '改密碼' },
    ],
  },
];

/** 去掉 href 上的查詢字串,只留路徑(選單有幾項帶 ?list=1 這種參數) */
export function pathOf(href: string): string {
  const q = href.indexOf('?');
  return q === -1 ? href : href.slice(0, q);
}

/**
 * 側欄以外的頁面。有些頁面有伺服器端 metadata(無障礙聲明、隱私權政策、聯絡管道),
 * 這裡的字要跟那邊一模一樣,不然同一頁重新整理與 SPA 換頁會念出兩種標題。
 */
const EXTRA_TITLES: Readonly<Record<string, string>> = {
  '/login': '內部登入',
  '/setup': '安裝精靈',
  '/accessibility': '無障礙聲明',
  '/privacy': '隱私權政策',
  '/contact': '聯絡管道',
  '/admin': '控制台',
  '/admin/settings/sso': '單一登入設定',
};

/**
 * 動態路由。只有兩條,寫成明確的判斷而不是前綴表:
 * `/admin/crm/<uuid>` 是客戶卡(側欄那幾頁已經被精確比對先接走),
 * `/invite/<token>` 是邀請連結。多一層的路徑不算,免得把沒登記的頁面
 * 誤稱成客戶卡。
 */
function dynamicTitleFor(clean: string): string | null {
  if (/^\/admin\/crm\/[^/]+$/.test(clean)) return '客戶卡';
  if (/^\/invite\/[^/]+$/.test(clean)) return '接受邀請';
  return null;
}

const NAV_TITLES: ReadonlyMap<string, string> = new Map(
  ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => [pathOf(i.href), i.label] as const)),
);

/**
 * 這個路徑的頁面名稱。找不到就回 null ——
 * 呼叫端要把 null 當成「不要動 document.title」,而不是硬塞一個猜的名字:
 * 沒對到的路徑多半是 404,那一頁的標題是伺服器端給的,蓋掉只會更差。
 */
export function pageTitleForPath(pathname: string): string | null {
  const p = pathOf(pathname);
  const clean = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  if (clean === '' || clean === '/') return null; // 首頁用產品名本身當標題
  const nav = NAV_TITLES.get(clean);
  if (nav) return nav;
  const extra = EXTRA_TITLES[clean];
  if (extra) return extra;
  return dynamicTitleFor(clean);
}

/**
 * 這個路徑該有的 `<title>`。組法跟根 layout 的 metadata template(`%s | Mitch CRM`)
 * 一致,所以同一頁不管是伺服器 render 出來的還是換頁後改的,標題長得一樣。
 */
export function documentTitleForPath(pathname: string): string | null {
  const name = pageTitleForPath(pathname);
  if (name === null) return pathOf(pathname) === '/' ? SITE_TITLE : null;
  return `${name} | ${SITE_TITLE}`;
}
