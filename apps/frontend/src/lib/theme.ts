// 佈景:方案 A／B、淺色／深色／跟隨系統、深／淺側欄。
//
// 兩種來源要分清楚:
//   配色方案與側欄深淺是「整間公司的外觀」,由系統管理員在系統設定決定,
//     伺服器透過 GET /api/public/settings 送下來,所有人一致。localStorage 只留一份快取,
//     用途是讓第一畫面不閃色,不是設定的來源;伺服器回來的值一律覆蓋快取。
//   淺色／深色是「這個人現在想怎麼看」,只存在這台瀏覽器,不進資料庫也不同步。
//
// 套用方式都是寫 <html> 上的 data-* 屬性,顏色本身由 app/globals.css 的 CSS 變數決定。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

export const THEME_STORAGE_KEY = 'mitchcrm-theme';

/** 配色方案:A = 藍綠、B = 赤陶 */
export type ThemeScheme = 'A' | 'B';
/** 明暗:null = 跟隨系統 prefers-color-scheme */
export type ThemeMode = 'light' | 'dark' | null;
/** 側欄:深底或淺底 */
export type ThemeSidebar = 'dark' | 'light';

export interface ThemeState {
  scheme: ThemeScheme;
  theme: ThemeMode;
  sidebar: ThemeSidebar;
  /**
   * 這個人有沒有自己按過顯示模式切換鈕。
   *
   * 為什麼需要這個旗標:管理者可以在系統設定挑「預設日夜模式」。
   * 沒有這個旗標的話,分不出「使用者刻意選了跟隨系統」與「他從來沒碰過」——
   * 兩者存進去都是 theme: null。分不出來就只有兩種爛結果:
   * 要嘛管理者的預設值永遠套不上去,要嘛每次重新整理都把使用者自己的選擇蓋掉。
   */
  chosen: boolean;
}

export const THEME_DEFAULTS: ThemeState = {
  scheme: 'A',
  theme: null,
  sidebar: 'dark',
  chosen: false,
};

function isScheme(v: unknown): v is ThemeScheme {
  return v === 'A' || v === 'B';
}
function isMode(v: unknown): v is Exclude<ThemeMode, null> {
  return v === 'light' || v === 'dark';
}
function isSidebar(v: unknown): v is ThemeSidebar {
  return v === 'dark' || v === 'light';
}

/**
 * 讀出目前的選擇。
 * 讀不到、格式壞掉、瀏覽器擋 localStorage（無痕模式、企業原則）都回預設值,不丟例外。
 * 存進去的值也一律驗過型別 —— localStorage 是使用者可以自己改的地方,不能當可信輸入。
 */
export function loadTheme(): ThemeState {
  if (typeof window === 'undefined') return { ...THEME_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { ...THEME_DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...THEME_DEFAULTS };
    const o = parsed as Record<string, unknown>;
    return {
      scheme: isScheme(o.scheme) ? o.scheme : THEME_DEFAULTS.scheme,
      theme: isMode(o.theme) ? o.theme : null,
      sidebar: isSidebar(o.sidebar) ? o.sidebar : THEME_DEFAULTS.sidebar,
      chosen: o.chosen === true,
    };
  } catch {
    return { ...THEME_DEFAULTS };
  }
}

/**
 * 套用（並存下）使用者自己的顯示模式。
 * theme 傳 null 代表回到「跟隨系統」——這時候把 data-theme 整個拿掉,
 * 讓 globals.css 的 @media (prefers-color-scheme: dark) 接手。
 *
 * 也接受 scheme／sidebar,但那只在 applyOrgAppearance 內部用到;
 * 一般畫面請只傳 theme,不要從使用者端去改公司統一的配色。
 */
export function applyTheme(next: Partial<ThemeState>): ThemeState {
  const t: ThemeState = { ...loadTheme(), ...next };
  if (typeof document !== 'undefined') {
    try {
      const el = document.documentElement;
      el.dataset.scheme = t.scheme;
      el.dataset.sidebar = t.sidebar;
      if (t.theme) el.dataset.theme = t.theme;
      else delete el.dataset.theme;
    } catch {
      // 動不到 DOM 就算了,不要讓切換鈕整個炸掉
    }
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(t));
    } catch {
      // 無痕模式 / 配額滿:這一次的選擇不留存,但畫面已經換好了
    }
  }
  return t;
}

/**
 * 套用系統管理員設定的公司外觀（配色方案、側欄深淺、預設日夜模式）。
 *
 * 由 <OrgAppearance /> 在取得 /api/public/settings 之後呼叫。伺服器是唯一來源,
 * 這裡順手更新 localStorage 的快取,下次進站第一畫面就不會先閃預設色再跳成公司色。
 *
 * 預設日夜模式只在「這個人從來沒按過切換鈕」時才套用。按過就以他的選擇為準 ——
 * 管理者定的是新人第一次進來看到什麼,不是每天早上把每個人的選擇重設一次。
 * defaultMode 傳 'system' 或看不懂的值 = 跟隨作業系統,也就是不寫 data-theme。
 */
export function applyOrgAppearance(scheme: unknown, sidebar: unknown, defaultMode?: unknown): void {
  const cur = loadTheme();
  const next: Partial<ThemeState> = {
    scheme: isScheme(scheme) ? scheme : THEME_DEFAULTS.scheme,
    sidebar: isSidebar(sidebar) ? sidebar : THEME_DEFAULTS.sidebar,
  };
  if (!cur.chosen) next.theme = isMode(defaultMode) ? defaultMode : null;
  applyTheme(next);
}

/** 使用者自己按了切換鈕。記下 chosen,之後管理者的預設值就不再蓋過他 */
export function applyUserTheme(theme: ThemeMode): ThemeState {
  return applyTheme({ theme, chosen: true });
}

/**
 * 在 <head> 內同步執行,避免第一畫面閃錯色（FOUC）。
 * 由 app/layout.tsx 用 <script dangerouslySetInnerHTML> 塞進 <head>,
 * 一定要在任何樣式套用前跑完,所以不能改成 useEffect。
 * 內容是純字串常數,沒有任何外部輸入拼接。
 */
export const inlineBootScript =
  '(function(){try{var t=JSON.parse(localStorage.getItem("mitchcrm-theme")||"{}");' +
  'var e=document.documentElement;e.dataset.scheme=t.scheme==="B"?"B":"A";' +
  'e.dataset.sidebar=t.sidebar==="light"?"light":"dark";' +
  'if(t.theme==="light"||t.theme==="dark")e.dataset.theme=t.theme;}catch(_){}})();';
