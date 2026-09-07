// ref:3687 mc/陳彥輔/米球®
'use client';

// 系統設定(/admin/settings)。
//
// 這一頁涵蓋安裝精靈裡的每一個項目 —— 精靈是「第一次裝的時候順手填」,
// 這一頁是「裝錯了、或公司變了要改」。兩邊改的是同一組設定,
// 用的也是同一份編輯器元件(components/settings/editors.tsx)。
//
// 為什麼分頁籤而不是一路捲到底:項目太多,一頁捲下去找不到東西。
// 頁籤用標準的 tablist/tab/tabpanel 語意,鍵盤可以用左右鍵在頁籤之間移動。
//
// 資料流:
//   GET   /api/admin/app-settings  → { settings: {...} }(admin 專用,完整設定)
//   PATCH /api/admin/app-settings  → 存檔;成功後呼叫 refresh() 讓全站立刻換新設定。
//   刪除階段時後端可能回 409 並帶 { message, stageKey, count },
//   表示還有客戶在那個階段。那個訊息要原樣顯示給人看,不要蓋成通用的「儲存失敗」。

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import {
  AREA_LABEL,
  DEFAULT_APP_SETTINGS,
  RESERVED_STAGE_KEYS,
  VISIT_CHANNEL_KEY,
  ZONE_LABEL,
  ZONE_NAMES,
  parseAppSettings,
  useAppSettingsContext,
  type AppSettings,
  type AreaKey,
  type ZoneName,
} from '@/lib/app-settings';
import {
  Field,
  LookupEditor,
  PhotoChecklistEditor,
  StageEditor,
} from '@/components/settings/editors';
import { DepartmentsEditor } from '@/components/settings/departments-editor';
import { LocaleField, TimeZoneField, localeFieldsError } from '@/components/settings/locale-fields';
import { VocabEditor } from './vocab-editor';
import { apiErrorMessage, redirectToLogin } from '@/lib/api-error';

/**
 * 系統保留、後台不能刪的互動管道。
 * 到訪打卡寫的是 visit,移交 / 成交 / 地址變更那些系統紀錄寫的是 note ——
 * 刪掉之後那些紀錄會指向一個不存在的管道。後端也會擋(回 409),這裡只是先講清楚。
 */
const RESERVED_CHANNELS: readonly string[] = [VISIT_CHANNEL_KEY, 'note'];

type TabId =
  | 'org'
  | 'locale'
  | 'stages'
  | 'photos'
  | 'channels'
  | 'premises'
  | 'categories'
  | 'map'
  | 'lookup'
  | 'appearance'
  | 'departments'
  | 'access';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'org', label: '組織與品牌' },
  { id: 'locale', label: '時區與地區' },
  { id: 'stages', label: '客戶階段' },
  { id: 'photos', label: '照片存證檢查表' },
  { id: 'channels', label: '互動管道' },
  { id: 'premises', label: '場所類型' },
  { id: 'categories', label: '商業分類' },
  { id: 'map', label: '地圖與地理編碼' },
  { id: 'lookup', label: '外部查詢帶入' },
  { id: 'appearance', label: '外觀' },
  { id: 'departments', label: '組織部門' },
  { id: 'access', label: '存取與帳號' },
];

/** 網址帶 ?tab=xxx 時直接開那一頁(使用者管理的「所屬部門」會連過來) */
function tabFromSearch(search: string): TabId | null {
  const wanted = new URLSearchParams(search).get('tab');
  return TABS.some((t) => t.id === wanted) ? (wanted as TabId) : null;
}

type Flash = { kind: 'success' | 'error'; text: string } | null;

/** 伺服器回的「代碼 → 筆數」可能是任何東西,只留數字 */
function countsOf(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export default function AdminSettingsPage() {
  const { refresh } = useAppSettingsContext();
  const [tab, setTab] = useState<TabId>('org');
  const [s, setS] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  /** 伺服器上目前的值。用來算「哪些階段被刪掉了」,好在存檔前先問一次 */
  const [saved, setSaved] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [inUseCounts, setInUseCounts] = useState<Record<string, number>>({});
  const [channelUsage, setChannelUsage] = useState<Record<string, number>>({});
  const [premisesUsage, setPremisesUsage] = useState<Record<string, number>>({});
  const [categoryUsage, setCategoryUsage] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const tabRefs = useRef<Map<TabId, HTMLButtonElement>>(new Map());
  const uid = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/app-settings`, {
        credentials: 'include',
      });
      if (res.status === 401) {
        // 401 全站同一套處理(見 lib/api-error):導回登入頁並帶上 next
        redirectToLogin();
        return;
      }
      if (res.status === 403) {
        setError('你沒有權限管理系統設定(只有系統管理員可以)');
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(`載入失敗(${res.status})`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as {
        settings?: unknown;
        stageUsage?: unknown;
        channelUsage?: unknown;
        premisesTypeUsage?: unknown;
        categoryUsage?: unknown;
      };
      const parsed = parseAppSettings(data.settings);
      setS(parsed);
      setSaved(parsed);
      setChannelUsage(countsOf(data.channelUsage));
      setPremisesUsage(countsOf(data.premisesTypeUsage));
      setCategoryUsage(countsOf(data.categoryUsage));
      // 後端順便回各階段目前有幾個客戶,刪除鈕才知道能不能按。
      // 沒回也沒關係:存檔時後端還是會擋,只是使用者要多按一次才知道。
      if (typeof data.stageUsage === 'object' && data.stageUsage !== null) {
        const counts: Record<string, number> = {};
        for (const [k, v] of Object.entries(data.stageUsage as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
        }
        setInUseCounts(counts);
      }
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 深連結。用 window.location 而不是 useSearchParams:後者在 App Router 會逼整棵子樹
  // 包 Suspense,為了一個開哪一頁籤的參數不值得。
  useEffect(() => {
    const wanted = tabFromSearch(window.location.search);
    if (wanted) setTab(wanted);
  }, []);

  function set<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setS((cur) => ({ ...cur, [k]: v }));
  }

  /** 這次存檔會刪掉哪些階段(伺服器上有、畫面上已經沒有的) */
  const removedStages = useMemo(() => {
    const keep = new Set(s.stages.map((x) => x.key));
    return saved.stages.filter((x) => !keep.has(x.key));
  }, [s.stages, saved.stages]);

  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  async function doSave() {
    setSaving(true);
    setFlash(null);
    setConfirmingRemoval(false);
    try {
      const res = await fetch(`${getApiBase()}/api/admin/app-settings`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // 管道與場所類型就在 AppSettings 裡,跟其餘設定同一包送出:後端整段在一筆
        // 交易裡寫,分兩次送的話會出現「管道存好了、場所類型沒存到」的中間狀態
        body: JSON.stringify(s),
      });
      if (!res.ok) {
        // 409 = 階段還有客戶在用。後端的訊息已經寫清楚是哪一個階段、還有幾位客戶,
        // 原樣顯示,不要換成自己編的句子 —— 這件事正是 lib/api-error 的規則,
        // 所以走那一支,不在這裡自己解析 body。
        setFlash({ kind: 'error', text: await apiErrorMessage(res, `儲存失敗(${res.status})`) });
        return;
      }
      setFlash({ kind: 'success', text: '系統設定已儲存,全站已套用新設定' });
      await load();
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  function onSaveClick() {
    // 時區與語言標籤先在前端擋一次。後端的 resolveTimeZone 對不合法的值是靜靜換成
    // 預設時區,不會報錯,所以打錯字的人會以為存好了,實際上全站的時間都算錯。
    const localeMsg = localeFieldsError(s.timezone, s.locale);
    if (localeMsg) {
      setTab('locale');
      setFlash({ kind: 'error', text: localeMsg });
      return;
    }
    if (removedStages.length > 0 && !confirmingRemoval) {
      setConfirmingRemoval(true);
      return;
    }
    void doSave();
  }

  /** 頁籤的左右鍵瀏覽(WAI-ARIA tabs pattern) */
  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    const target = TABS[next];
    if (!target) return;
    setTab(target.id);
    tabRefs.current.get(target.id)?.focus();
  }

  if (loading) return <p className="text-muted-foreground">載入中...</p>;
  if (error)
    return (
      <p role="alert" className="flash flash-error">
        {error}
      </p>
    );

  return (
    <article className="space-y-4">
      <header>
        <p className="text-sm text-muted-foreground">
          <Link href="/admin" className="underline">
            後台
          </Link>{' '}
          / 系統設定
        </p>
        <h1>系統設定</h1>
        <p className="text-sm text-muted-foreground">
          安裝時填過的每一項都在這裡,改了立刻對所有使用者生效。
        </p>
      </header>

      {flash ? (
        <p
          role={flash.kind === 'error' ? 'alert' : 'status'}
          className={`flash ${flash.kind === 'success' ? 'flash-success' : 'flash-error'}`}
        >
          {flash.text}
        </p>
      ) : null}

      <div role="tablist" aria-label="設定分類" className="flex flex-wrap gap-1.5">
        {TABS.map((t, i) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${uid}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              // 選中的頁籤除了底色,字重也變粗(顏色不是唯一線索),
              // aria-selected 讓螢幕閱讀器讀得到。
              className={`min-h-[44px] rounded-md border px-3 py-2 text-sm ${
                selected
                  ? 'border-transparent bg-primary font-bold text-primary-foreground'
                  : 'border-border bg-surface font-normal text-foreground hover:bg-muted'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <section
        role="tabpanel"
        id={`${uid}-panel-${tab}`}
        aria-labelledby={`${uid}-tab-${tab}`}
        tabIndex={0}
        className="card space-y-4"
      >
        {tab === 'org' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="產品名稱"
              hint={`畫面上這套系統叫什麼,預設 ${DEFAULT_APP_SETTINGS.productName}`}
            >
              <input
                type="text"
                className="input"
                value={s.productName}
                onChange={(e) => set('productName', e.target.value)}
              />
            </Field>
            <Field label="站頭商標文字" hint="留空就用產品名稱">
              <input
                type="text"
                className="input"
                value={s.logoText}
                onChange={(e) => set('logoText', e.target.value)}
              />
            </Field>
            <Field label="組織全名" hint="頁尾版權列">
              <input
                type="text"
                className="input"
                value={s.organizationName}
                onChange={(e) => set('organizationName', e.target.value)}
              />
            </Field>
            <Field label="組織顯示名">
              <input
                type="text"
                className="input"
                value={s.organizationDisplayName}
                onChange={(e) => set('organizationDisplayName', e.target.value)}
              />
            </Field>
            <Field label="對外聯絡電話">
              <input
                type="tel"
                className="input"
                value={s.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>
            <Field label="收件地址" full>
              <input
                type="text"
                className="input"
                value={s.mailingAddress}
                onChange={(e) => set('mailingAddress', e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        {tab === 'locale' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <TimeZoneField
              value={s.timezone}
              onChange={(v) => set('timezone', v)}
              hint="打卡時間、日報的日期界線、存證照片浮水印上的時間與 GMT 位移都照這個時區算"
            />
            <LocaleField
              value={s.locale}
              onChange={(v) => set('locale', v)}
              hint="目前只存起來備用:畫面上的日期一律用不依語系的固定格式,改這一欄不會改變顯示方式"
            />
          </div>
        ) : null}

        {tab === 'stages' ? (
          <StageEditor
            stages={s.stages}
            inUseCounts={inUseCounts}
            reservedKeys={RESERVED_STAGE_KEYS}
            onChange={(next) => set('stages', next)}
          />
        ) : null}

        {tab === 'channels' ? (
          <VocabEditor
            items={s.channels}
            onChange={(next) => set('channels', next)}
            what="互動管道"
            hint="客戶卡「三秒記錄」的管道下拉,以及時間軸上每一筆紀錄前面的那個字,都是這份清單。"
            inUseCounts={channelUsage}
            reservedKeys={RESERVED_CHANNELS}
            keyPrefix="channel"
            usageNoun="筆互動紀錄"
          />
        ) : null}

        {tab === 'premises' ? (
          <VocabEditor
            items={s.premisesTypes}
            onChange={(next) => set('premisesTypes', next)}
            what="場所類型"
            hint="客戶卡上「場所類型」那一格的選項。照片存證檢查表按場所類型分組,所以要多一種現場(例如工地、廠房),先在這裡加。"
            inUseCounts={premisesUsage}
            keyPrefix="place"
            usageNoun="位客戶"
          />
        ) : null}

        {tab === 'categories' ? (
          <VocabEditor
            items={s.categories}
            onChange={(next) => set('categories', next)}
            what="商業分類"
            hint="客戶卡與新增客戶頁上「分類」那一格的選項。這份清單以前寫死在程式裡,現在整組由這裡決定;要換成自己這一行的講法,直接改就好。"
            inUseCounts={categoryUsage}
            keyPrefix="category"
            usageNoun="位客戶"
          />
        ) : null}

        {tab === 'photos' ? (
          <PhotoChecklistEditor
            items={s.photoChecklist}
            onChange={(next) => set('photoChecklist', next)}
            premisesTypes={s.premisesTypes}
            exemptPremises={s.photoExemptPremises}
            onExemptChange={(next) => set('photoExemptPremises', next)}
          />
        ) : null}

        {tab === 'map' ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              地理編碼是把客戶地址換成座標的動作,由伺服器去問外部地圖服務。
              下面的「限制國家」沒填就是不限制,也就是全世界都查。
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="拜訪地圖預設緯度">
                <input
                  type="number"
                  step="0.0001"
                  className="input"
                  value={s.mapDefaultLat}
                  onChange={(e) => set('mapDefaultLat', Number(e.target.value))}
                />
              </Field>
              <Field label="拜訪地圖預設經度">
                <input
                  type="number"
                  step="0.0001"
                  className="input"
                  value={s.mapDefaultLng}
                  onChange={(e) => set('mapDefaultLng', Number(e.target.value))}
                />
              </Field>
              <Field label="預設縮放層級" hint="1 是整個地球,19 是看得到門牌">
                <input
                  type="number"
                  min="1"
                  max="19"
                  className="input"
                  value={s.mapDefaultZoom}
                  onChange={(e) => set('mapDefaultZoom', Number(e.target.value))}
                />
              </Field>
              <Field label="地理編碼服務" hint="把客戶地址換成座標的服務">
                <select
                  className="input"
                  value={s.geocodeProvider}
                  onChange={(e) =>
                    set('geocodeProvider', e.target.value === 'none' ? 'none' : 'nominatim')
                  }
                >
                  <option value="nominatim">OpenStreetMap Nominatim</option>
                  <option value="none">不啟用(座標全部人工填)</option>
                </select>
              </Field>
              <Field
                label="地圖圖磚網址"
                full
                hint="{z}/{x}/{y} 是圖磚座標。圖磚由使用者的瀏覽器直接向這個網址請求,會把 IP 與檢視範圍送給對方。留空 = 用公共的 OpenStreetMap 圖磚"
              >
                <input
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="input font-mono"
                  placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                  value={s.mapTileUrl}
                  onChange={(e) => set('mapTileUrl', e.target.value)}
                />
              </Field>
              <Field
                label="限制國家"
                full
                hint="逗號分隔的兩碼國碼(ISO 3166-1 alpha-2),例如 tw,或 jp,kr。留空 = 不限制國家。填了之後,查不到的地址就只會是那幾國裡查不到"
              >
                <input
                  type="text"
                  inputMode="text"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="input font-mono"
                  placeholder="留空 = 不限制"
                  value={s.geocodeCountryCodes}
                  onChange={(e) => set('geocodeCountryCodes', e.target.value)}
                />
              </Field>
            </div>
          </div>
        ) : null}

        {tab === 'lookup' ? (
          <LookupEditor
            value={{
              enabled: s.lookupEnabled,
              label: s.lookupLabel,
              urlTemplate: s.lookupUrlTemplate,
              fieldMap: s.lookupFieldMap,
              pattern: s.lookupPattern,
            }}
            onChange={(next) =>
              setS((cur) => ({
                ...cur,
                lookupEnabled: next.enabled,
                lookupLabel: next.label,
                lookupUrlTemplate: next.urlTemplate,
                lookupFieldMap: next.fieldMap,
                lookupPattern: next.pattern,
              }))
            }
          />
        ) : null}

        {tab === 'appearance' ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              這裡設定的配色會套用到所有使用者。個別使用者可在站頭自行切換淺色或深色,
              不影響這裡的設定。
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="配色方案">
                <select
                  className="input"
                  value={s.themeScheme}
                  onChange={(e) => set('themeScheme', e.target.value === 'B' ? 'B' : 'A')}
                >
                  <option value="A">藍綠</option>
                  <option value="B">赤陶</option>
                </select>
              </Field>
              <Field label="側欄底色">
                <select
                  className="input"
                  value={s.themeSidebar}
                  onChange={(e) =>
                    set('themeSidebar', e.target.value === 'light' ? 'light' : 'dark')
                  }
                >
                  <option value="dark">深色</option>
                  <option value="light">淺色</option>
                </select>
              </Field>
              <Field label="預設日夜模式" hint="每個人之後仍可自己切換">
                <select
                  className="input"
                  value={s.themeDefaultMode}
                  onChange={(e) => {
                    const v = e.target.value;
                    set('themeDefaultMode', v === 'light' || v === 'dark' ? v : 'system');
                  }}
                >
                  <option value="system">跟隨作業系統</option>
                  <option value="light">淺色</option>
                  <option value="dark">深色</option>
                </select>
              </Field>
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">功能區識別色</legend>
              <p className="text-sm text-muted-foreground">
                只能從這五組挑,是因為每一組的對比在淺色與深色模式都量過。
                自由填色碼很容易讓文字掉出無障礙標準,而在設定頁上看不出來。
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                {(Object.keys(AREA_LABEL) as AreaKey[]).map((area) => (
                  <Field key={area} label={AREA_LABEL[area]}>
                    <select
                      className="input"
                      value={s.areaColors[area]}
                      onChange={(e) =>
                        set('areaColors', {
                          ...s.areaColors,
                          [area]: e.target.value as ZoneName,
                        })
                      }
                    >
                      {ZONE_NAMES.map((z) => (
                        <option key={z} value={z}>
                          {ZONE_LABEL[z]}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
            </fieldset>
          </div>
        ) : null}

        {tab === 'departments' ? <DepartmentsEditor /> : null}

        {tab === 'access' ? (
          <div className="space-y-4">
            <div>
              <h2 className="page-h2">單一登入</h2>
              <p className="page-subtle max-w-[70ch]">
                設定哪些公司網域的帳號可以登入後台、要不要自動建立帳號,
                並查看最近的登入成功與失敗紀錄。這一段要即時跟識別提供者連線檢查,
                所以獨立成一頁,不跟這裡的「一次存全部」混在一起。
              </p>
              <Link href="/admin/settings/sso" className="btn mt-2 min-h-[44px] px-4">
                前往單一登入設定
              </Link>
            </div>
            <div>
              <h2 className="page-h2">使用者與團隊</h2>
              <p className="page-subtle max-w-[70ch]">
                新增成員、指派角色、指定所屬主管與所屬部門,在使用者管理與團隊成員兩頁。
                部門本身的結構在「組織部門」頁籤維護。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link href="/admin/users" className="btn min-h-[44px] px-4">
                  使用者管理
                </Link>
                <Link href="/admin/team" className="btn min-h-[44px] px-4">
                  團隊成員
                </Link>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {confirmingRemoval ? (
        <div role="alert" className="flash flash-warning space-y-2">
          <p>
            這次存檔會刪掉 {removedStages.length} 個階段:
            {removedStages.map((x) => x.label || x.key).join('、')}。
          </p>
          <p className="text-sm">
            如果還有客戶停在這些階段,後端會擋下來並告訴你是哪一個階段、還有幾位客戶。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void doSave()}
              className="btn btn-danger min-h-[44px] px-4"
            >
              知道了,確定刪除並存檔
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemoval(false)}
              className="btn min-h-[44px] px-4"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onSaveClick}
          aria-busy={saving}
          className="btn btn-primary min-h-[44px] px-6"
        >
          {saving ? '儲存中...' : '儲存全部設定'}
        </button>
      </div>
      {saving ? (
        <p role="status" className="text-right text-sm text-muted-foreground">
          正在儲存設定…
        </p>
      ) : null}
    </article>
  );
}
