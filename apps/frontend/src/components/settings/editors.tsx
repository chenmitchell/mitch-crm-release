// ref:3687 mc/陳彥輔/米球®
'use client';

// 設定用的共用編輯器。安裝精靈(/setup)與系統設定(/admin/settings)共用同一份 ——
// 兩邊改的是同一組設定,長得不一樣只會讓人以為是兩種東西。
//
// 無障礙共通規則:每個輸入都有 <label>;可點區域最小 44px;
// 狀態(必拍、出現在看板、已刪除確認)都用文字寫出來,不是只有顏色或灰掉的按鈕。

import { useState } from 'react';
import {
  STAGE_COLOR_LABEL,
  STAGE_COLOR_NAMES,
  useAppSettings,
  type PhotoCheckItem,
  type StageColorName,
  type StageDef,
  type VocabItem,
} from '@/lib/app-settings';

// ── 階段編輯器(安裝精靈與系統設定共用)────────────────────────────────────

export function StageEditor({
  stages,
  onChange,
  inUseCounts,
  reservedKeys = [],
}: {
  stages: StageDef[];
  onChange: (next: StageDef[]) => void;
  /** 各階段目前有幾個客戶。有值時刪除鈕會擋下來並說明原因 */
  inUseCounts?: Record<string, number>;
  /**
   * 系統保留、不可刪除的階段代碼(見 @mitchcrm/shared 的 RESERVED_STAGE_KEYS)。
   * 標記成交與查重合併會直接寫這幾個代碼,刪掉之後那些客戶的階段對不到任何一列,
   * 看板上直接消失。後端也會回 409,但那要按了存檔才看得到,所以這裡先寫出來。
   */
  reservedKeys?: readonly string[];
}) {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  function update(i: number, next: Partial<StageDef>) {
    const rows = [...stages];
    const cur = rows[i];
    if (!cur) return;
    rows[i] = { ...cur, ...next };
    onChange(rows);
  }

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= stages.length) return;
    const rows = [...stages];
    const a = rows[i];
    const b = rows[j];
    if (!a || !b) return;
    rows[i] = b;
    rows[j] = a;
    onChange(rows);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        看板由左到右就是下面的順序。代碼(key)寫進資料庫,改了之後既有客戶的階段會對不上,
        所以只在還沒開始用的時候改。
      </p>
      <p className="text-sm text-muted-foreground">
        勾「終止階段」代表這一階已經結束,不用再追。終止階段裡的客戶不算逾期、不進拜訪地圖、
        不再出現在待辦。成交與放棄之外自己加的結案階段(例如「已結案不再追蹤」)也要勾,
        沒勾的話那些客戶會被永遠當成還在追。
      </p>
      <p className="text-sm text-muted-foreground">
        至少要留一個階段。全部刪掉的話伺服器會擋下來,而且要按了存檔才知道,
        所以只剩一個的時候刪除鈕會直接關掉並寫出原因。
      </p>
      <ul className="space-y-3">
        {stages.map((st, i) => {
          const used = inUseCounts?.[st.key] ?? 0;
          const reserved = reservedKeys.includes(st.key);
          const confirming = confirmKey === st.key;
          return (
            <li key={i} className="rounded-md border border-border p-3">
              <div className="grid gap-3 md:grid-cols-4">
                <Field label={`第 ${i + 1} 階段的名稱`}>
                  <input
                    type="text"
                    className="input"
                    value={st.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                  />
                </Field>
                <Field label={`第 ${i + 1} 階段的代碼`} hint="小寫英數字、底線、減號">
                  <input
                    type="text"
                    className="input font-mono"
                    value={st.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                </Field>
                <Field label={`第 ${i + 1} 階段的顏色`}>
                  <select
                    className="input"
                    value={st.color}
                    onChange={(e) => update(i, { color: e.target.value as StageColorName })}
                  >
                    {STAGE_COLOR_NAMES.map((c) => (
                      <option key={c} value={c}>
                        {STAGE_COLOR_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </Field>
                <div
                  className="flex items-center rounded-md px-2 text-sm"
                  style={{
                    backgroundColor: `var(--st-${st.color}-bg)`,
                    color: `var(--st-${st.color}-fg)`,
                    border: `2px solid var(--st-${st.color}-bar)`,
                  }}
                >
                  {/* 預覽色塊裡直接寫名稱,顏色不是唯一資訊 */}
                  {st.label || '(未命名)'}
                  {st.terminal ? <span className="ml-2 font-medium">(終止)</span> : null}
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Check
                  label="出現在看板"
                  checked={st.board}
                  onChange={(v) => update(i, { board: v })}
                />
                <Check
                  label="可在表單選"
                  checked={st.form}
                  onChange={(v) => update(i, { form: v })}
                />
                <Check
                  label="終止階段"
                  hint="到這一階就不再追蹤"
                  checked={st.terminal}
                  onChange={(v) => update(i, { terminal: v })}
                />
                <button
                  type="button"
                  className="btn btn-sm min-h-[44px] px-3"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  上移
                </button>
                <button
                  type="button"
                  className="btn btn-sm min-h-[44px] px-3"
                  onClick={() => move(i, 1)}
                  disabled={i === stages.length - 1}
                >
                  下移
                </button>
                {reserved ? (
                  // 系統保留的階段。用一句話說明原因與還能改什麼,
                  // 不是只把按鈕變灰讓人猜為什麼刪不掉。
                  <span className="text-sm text-muted-foreground">
                    系統保留的階段,不能刪除(名稱、顏色與順序照樣可以改)
                  </span>
                ) : stages.length <= 1 ? (
                  // 至少要留一階。後端也會擋(回 400),但那要按了存檔才看得到,
                  // 所以在這裡就寫出來,而且是一句話,不是把按鈕變灰讓人猜。
                  <span className="text-sm text-muted-foreground">
                    這是最後一個階段,不能刪除。要換流程請先新增別的階段
                  </span>
                ) : used > 0 ? (
                  // 有客戶在用就不給刪。這一句同時說明原因與解法,
                  // 不是只把按鈕變灰讓人猜為什麼按不下去。
                  <span className="text-sm text-muted-foreground">
                    有 {used} 位客戶在這個階段,要先把他們移到別的階段才能刪除
                  </span>
                ) : confirming ? (
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span>確定刪除「{st.label || st.key}」?</span>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm min-h-[44px] px-3"
                      onClick={() => {
                        setConfirmKey(null);
                        onChange(stages.filter((_, j) => j !== i));
                      }}
                    >
                      確定刪除
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm min-h-[44px] px-3"
                      onClick={() => setConfirmKey(null)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm min-h-[44px] px-3"
                    onClick={() => setConfirmKey(st.key)}
                  >
                    刪除這個階段
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn min-h-[44px] px-4"
        onClick={() =>
          onChange([
            ...stages,
            {
              key: `stage_${stages.length + 1}`,
              label: '',
              color: 'neutral' as StageColorName,
              board: true,
              form: true,
              terminal: false,
            },
          ])
        }
      >
        新增一個階段
      </button>
    </div>
  );
}

// ── 照片存證檢查表編輯器 ────────────────────────────────────────────────

export function PhotoChecklistEditor({
  items,
  onChange,
  premisesTypes,
  exemptPremises,
  onExemptChange,
}: {
  items: PhotoCheckItem[];
  onChange: (next: PhotoCheckItem[]) => void;
  /**
   * 要顯示哪些場所類型。不給就用全站設定裡那一份。
   *
   * 這個 prop 是給 /admin/settings 用的:那一頁的「場所類型」分頁可能正在改清單,
   * 還沒存檔。傳當下編輯中的那一份,勾選框才會跟著使用者剛加的場所走,
   * 而不是等存完檔重新整理才出現。
   */
  premisesTypes?: readonly VocabItem[];
  /**
   * 明確設定為「不需照片存證」的場所類型代碼。
   * 不給(安裝精靈)就不顯示豁免那一段 —— 精靈是「先設好要拍什麼」,
   * 豁免是裝好之後才會遇到的例外,不必在第一次安裝時就問。
   */
  exemptPremises?: readonly string[];
  onExemptChange?: (next: string[]) => void;
}) {
  const settings = useAppSettings();
  const places = premisesTypes ?? settings.premisesTypes;
  const exempt = exemptPremises ?? [];
  const showExempt = onExemptChange !== undefined;

  /** 這個場所有幾項必拍。placeTypes 空陣列的意思是「所有場所都要」 */
  function requiredCount(place: string): number {
    return items.filter(
      (it) => it.required && (it.placeTypes.length === 0 || it.placeTypes.includes(place)),
    ).length;
  }

  /**
   * 這個場所目前的照片存證狀態,與後端 photoRequirementState 是同一套三分法。
   * 兩邊的判定要一致,不然畫面說會放行、按下去卻被擋。
   */
  function stateOf(place: string): 'required' | 'exempt' | 'unset' {
    if (requiredCount(place) > 0) return 'required';
    return exempt.includes(place) ? 'exempt' : 'unset';
  }

  function toggleExempt(place: string) {
    if (!onExemptChange) return;
    onExemptChange(exempt.includes(place) ? exempt.filter((p) => p !== place) : [...exempt, place]);
  }
  function update(i: number, next: Partial<PhotoCheckItem>) {
    const rows = [...items];
    const cur = rows[i];
    if (!cur) return;
    rows[i] = { ...cur, ...next };
    onChange(rows);
  }

  function togglePlace(i: number, place: string) {
    const cur = items[i];
    if (!cur) return;
    const has = cur.placeTypes.includes(place);
    update(i, {
      placeTypes: has ? cur.placeTypes.filter((p) => p !== place) : [...cur.placeTypes, place],
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        外勤到現場時,這張清單決定要拍哪些照片。標了「必拍」的缺一張,
        客戶卡上就會顯示缺件提示。沒有勾任何場所類型 = 不管什麼場所都要拍。
      </p>
      <p className="text-sm text-muted-foreground">
        下面的場所類型來自「場所類型」那一頁,不是寫死的。要多一種現場請去那一頁加。
      </p>

      {showExempt ? (
        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">每一種場所目前的狀態</legend>
          <p className="text-sm text-muted-foreground">
            一種場所沒有任何必拍項目時,有兩種可能:管理員還沒設,或是這種場所本來就
            不用拍。系統分不出來就只能一律擋成交,所以「不需照片存證」要在這裡明講。
            勾起來的場所,標記成交時一張照片都不會要求。
          </p>
          <ul className="space-y-2">
            {places.map((p) => {
              const state = stateOf(p.key);
              const n = requiredCount(p.key);
              return (
                <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="shrink-0 basis-32 text-sm font-medium">{p.label}</span>
                  {/*
                    狀態用文字寫出來,不是只靠顏色或勾選框的位置:
                    三種狀態的差別是「會不會擋成交」,那件事一定要讀得到
                  */}
                  <span
                    className={`text-sm ${
                      state === 'unset' ? 'font-semibold text-destructive' : 'text-muted-foreground'
                    }`}
                  >
                    {state === 'required'
                      ? `必拍 ${n} 項,缺件會擋成交`
                      : state === 'exempt'
                        ? '不需照片存證,標記成交不檢查照片'
                        : '尚未設定必拍項目,目前會擋住成交'}
                  </span>
                  <Check
                    label={`${p.label}不需照片存證`}
                    checked={exempt.includes(p.key)}
                    onChange={() => toggleExempt(p.key)}
                  />
                </li>
              );
            })}
          </ul>
          {places.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前沒有任何場所類型。請先到「場所類型」那一頁加。
            </p>
          ) : null}
        </fieldset>
      ) : null}
      <ul className="space-y-3">
        {items.map((it, i) => (
          <li key={i} className="rounded-md border border-border p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={`第 ${i + 1} 項的名稱`}>
                <input
                  type="text"
                  className="input"
                  value={it.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
              </Field>
              <Field label={`第 ${i + 1} 項的代碼`} hint="要與後端照片類型一致">
                <input
                  type="text"
                  className="input font-mono"
                  value={it.key}
                  onChange={(e) => update(i, { key: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Check
                label="必拍"
                checked={it.required}
                onChange={(v) => update(i, { required: v })}
              />
              {places.map((p) => (
                <Check
                  key={p.key}
                  label={`只在${p.label}要求`}
                  checked={it.placeTypes.includes(p.key)}
                  onChange={() => togglePlace(i, p.key)}
                />
              ))}
              <button
                type="button"
                className="btn btn-sm min-h-[44px] px-3"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                移除第 {i + 1} 項
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn min-h-[44px] px-4"
        onClick={() =>
          onChange([
            ...items,
            { key: `photo_${items.length + 1}`, label: '', required: false, placeTypes: [] },
          ])
        }
      >
        新增一個照片項目
      </button>
    </div>
  );
}

// ── 小元件 ──────────────────────────────────────────────────────────────

export function Field({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${full ? 'md:col-span-2' : ''}`}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex min-h-[44px] items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-5 w-5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint ? <span className="ml-1 text-xs text-muted-foreground">({hint})</span> : null}
      </span>
    </label>
  );
}

// ── 外部查詢帶入(安裝精靈與系統設定共用)──────────────────────────────────

/** 這一組設定在畫面上的形狀。與 AppSettings 的 lookup* 五格一一對應 */
export interface LookupEditorValue {
  enabled: boolean;
  label: string;
  urlTemplate: string;
  fieldMap: Record<string, string>;
  pattern: string;
}

/** 三個目標欄位在畫面上要顯示的說明。key 是後端 applyFieldMap 認得的欄位名 */
const LOOKUP_FIELD_ROWS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'name', label: '名稱', hint: '帶進「公司名」那一格' },
  { key: 'address', label: '地址', hint: '帶進「登記地址」那一格' },
  { key: 'phone', label: '電話', hint: '帶進「電話」那一格' },
];

/**
 * 外部查詢帶入的設定編輯器。
 *
 * 這一組存在的理由:「輸入一組號碼就查得到這家店叫什麼、開在哪裡」是很有用的功能,
 * 但那個號碼叫什麼、要打哪個網址、回應長什麼樣子,每個國家都不一樣。
 * 所以程式碼不內建任何一個資料源,全部由這一頁決定。關著的時候那一格就是純手填。
 *
 * 欄位對應做成三個獨立輸入框而不是一整塊 JSON:貼 JSON 很容易少一個引號,
 * 而錯誤只會在業務按下查詢的時候變成一句「查詢失敗」,從設定頁上看不出來。
 */
export function LookupEditor({
  value,
  onChange,
}: {
  value: LookupEditorValue;
  onChange: (next: LookupEditorValue) => void;
}) {
  const set = (patch: Partial<LookupEditorValue>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        讓使用者輸入一組識別碼(例如當地的商業登記編號),由伺服器去查一個外部服務,
        自動填上名稱、地址與電話。不啟用的話,那一格就是單純的手動輸入欄位,其他功能不受影響。
      </p>

      <Check
        label="啟用外部查詢帶入"
        hint="關著時新增客戶頁不會出現「查詢帶入」按鈕"
        checked={value.enabled}
        onChange={(v) => set({ enabled: v })}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="識別碼的名稱"
          hint="這個號碼在當地怎麼稱呼。整個系統的欄位標籤、提示與錯誤訊息都用這個字"
        >
          <input
            type="text"
            className="input"
            maxLength={40}
            value={value.label}
            onChange={(e) => set({ label: e.target.value })}
          />
        </Field>

        <Field
          label="識別碼格式"
          hint="正規表示式,送出前先擋掉明顯打錯的值。留空 = 不檢查格式。八位數字請填 \d{8}"
        >
          <input
            type="text"
            className="input"
            maxLength={200}
            spellCheck={false}
            value={value.pattern}
            onChange={(e) => set({ pattern: e.target.value })}
          />
        </Field>
      </div>

      <Field
        label="查詢網址樣板"
        full
        hint="{q} 會被使用者輸入的識別碼取代。只接受 https,而且不可以指向內部網路或本機"
      >
        <input
          type="url"
          className="input"
          maxLength={500}
          spellCheck={false}
          placeholder="https://example.com/registry?id={q}"
          value={value.urlTemplate}
          onChange={(e) => set({ urlTemplate: e.target.value })}
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">回應欄位對應</legend>
        <p className="text-sm text-muted-foreground">
          外部服務回的 JSON 要怎麼對到客戶欄位。用點分隔的路徑指到那一格,例如回應是{' '}
          <code>{'{"data":{"company_name":"…","addr":"…"}}'}</code> 時,名稱就填{' '}
          <code>data.company_name</code>、地址填 <code>data.addr</code>。留空的欄位不會被帶入。
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          {LOOKUP_FIELD_ROWS.map((row) => (
            <Field key={row.key} label={row.label} hint={row.hint}>
              <input
                type="text"
                className="input"
                maxLength={200}
                spellCheck={false}
                value={value.fieldMap[row.key] ?? ''}
                onChange={(e) => {
                  const next = { ...value.fieldMap };
                  const v = e.target.value;
                  if (v.trim() === '') delete next[row.key];
                  else next[row.key] = v;
                  set({ fieldMap: next });
                }}
              />
            </Field>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
