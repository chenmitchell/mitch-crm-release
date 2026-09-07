'use client';

// 新增客戶(/admin/crm/new)。原本是 /admin/crm 頁裡的收合表單,拆頁後獨立成一頁。
// 流程:填識別碼,按「查詢帶入」帶出名稱與地址,補其餘欄位(建檔即時查重提示),送出後直接跳客戶卡。
// 資料來源:GET /api/admin/lookup/business?q=、POST /api/admin/crm。
//
// 「識別碼」這一格刻意不寫死任何地區的名稱:標籤、格式檢查、要不要出現查詢按鈕,
// 三件事全部由後台設定供應(見 lib/app-settings 的 useLookupSettings)。
// 外部查詢沒啟用時,只是少一顆按鈕,欄位本身照樣可以手動填。
// 商業分類同樣只送代碼,頁面裡不比對任何分類名稱;想多說一句話的人填「分類補充說明」,
// 那一格固定顯示、不綁分類,內容附在備註最前面。
// 無障礙:單一 h1、每個欄位都有 label、查詢結果與送出結果 role="status" aria-live、按鈕 >= 44px。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import DupeHint from '@/components/crm/dupe-hint';
import { useStageMeta, canUseCrm, crmApiBase, useCrmRole } from '@/lib/crm-shared';
import { useCrmVocab, useLookupSettings } from '@/lib/app-settings';

interface FormState {
  taxId: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  category: string;
  /** 分類補充說明。不綁任何一個分類,任何分類都能補一句話 */
  categoryNote: string;
  /** 場所類型代碼。'' 是未選(送出時不帶);合法值由後台設定,見 lib/app-settings */
  premisesType: string;
  stage: string;
  website: string;
  registeredAddress: string;
  actualAddress: string;
  contactAddress: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  taxId: '',
  companyName: '',
  contactName: '',
  contactPhone: '',
  category: '',
  categoryNote: '',
  premisesType: '',
  stage: '',
  website: '',
  registeredAddress: '',
  actualAddress: '',
  contactAddress: '',
  note: '',
};

/** 分類補充說明附進備註時的開頭。抽成常數,測試與這裡看的是同一個字串 */
export const CATEGORY_NOTE_PREFIX = '分類補充:';

/** 把分類補充說明併進備註。兩格都空的時候回空字串(送出時會變成 null) */
export function mergeCategoryNote(categoryNote: string, note: string): string {
  const extra = categoryNote.trim();
  const body = note.trim();
  if (extra === '') return body;
  return body === ''
    ? `${CATEGORY_NOTE_PREFIX}${extra}`
    : `${CATEGORY_NOTE_PREFIX}${extra}\n${body}`;
}

/**
 * 備註的字數上限。對齊後端 CreateDevCustomerDto 的 @MaxLength(8000),改一邊要改另一邊。
 *
 * 為什麼前端要自己擋:分類補充說明會被併到備註最前面,兩格加起來才是後端收到的那一段。
 * 前端不擋的話,備註貼滿 8000 字再填分類補充說明,送出後後端回的是 class-validator
 * 的英文訊息,那句話會被 api-error 的中文過濾濾掉,畫面只剩「新增失敗,請確認欄位後再試」,
 * 十幾格填好的東西還在,卻沒有一個字說是哪一格出問題。
 */
export const NOTE_MAX = 8000;

/**
 * 備註這一格還剩幾個字。分類補充說明連同前綴與那個換行都算在同一個額度裡,
 * 因為送出去的是併好的那一段。
 */
export function noteBudget(categoryNote: string): number {
  const extra = categoryNote.trim();
  const used = extra === '' ? 0 : CATEGORY_NOTE_PREFIX.length + extra.length + 1;
  return Math.max(0, NOTE_MAX - used);
}

/** 併起來超過上限幾個字。0 表示還在額度內 */
export function noteOverflow(categoryNote: string, note: string): number {
  return Math.max(0, mergeCategoryNote(categoryNote, note).length - NOTE_MAX);
}

/** 送出結果訊息那一格的 id。必填擋下來時,欄位的 aria-describedby 指的就是它 */
const FORM_MSG_ID = 'crm-form-msg';

export default function CrmNewCustomerPage() {
  // 階段清單由後台設定供應;預設值取清單第一項,不寫死 'lead'
  const stageMeta = useStageMeta();
  // 識別碼欄位的標籤、格式與查詢開關,全部來自後台設定
  const lookup = useLookupSettings();
  const router = useRouter();
  const role = useCrmRole();
  // 場所類型清單由後台決定,不寫死在表單裡
  const { premisesTypes, categories } = useCrmVocab();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);

  // 設定載進來之前 form.stage 是空的,載到之後補上清單第一項當預設。
  // 只在使用者還沒選過(仍是空字串)時補,免得蓋掉他選好的值。
  useEffect(() => {
    const first = stageMeta.form[0];
    if (!first) return;
    setForm((cur) => (cur.stage === '' ? { ...cur, stage: first.key } : cur));
  }, [stageMeta]);
  /**
   * 送出被必填擋下來時,是哪一組欄位有錯(3.3.1、3.3.3)。
   * 'identity' = 識別碼與公司名兩格都空著。訊息不是只印在旁邊:
   * 那兩格會掛上 aria-invalid 與 aria-describedby 指到訊息本身,焦點也會送到第一格。
   */
  const [invalidField, setInvalidField] = useState<'identity' | null>(null);
  /** 送出失敗與必填錯誤都算錯誤:訊息要用 alert 唸出來,不是 polite 的 status */
  const [formError, setFormError] = useState(false);
  // 必填擋下來時把焦點送到第一個有問題的欄位
  const taxIdInputRef = useRef<HTMLInputElement>(null);
  // 最新識別碼的鏡像(onChange 內同步更新),查詢回來後比對用(state 在 await 後是舊值)
  const taxIdRef = useRef('');
  // 超過字數上限時把焦點送回備註,使用者才知道要改哪一格
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // 備註與分類補充說明共用同一個額度:先算這一格還能打幾個字,再算已經多了幾個字。
  // maxLength 擋得住「先填分類補充說明再打備註」,擋不住「先打滿備註再回頭填分類補充說明」,
  // 所以除了 maxLength 還要有這句話與送出前的那道檢查。
  const noteMax = noteBudget(form.categoryNote);
  const noteOver = noteOverflow(form.categoryNote, form.note);
  const noteLeft = Math.max(0, noteMax - form.note.trim().length);

  /** 識別碼與公司名這一組現在是不是被必填擋著 */
  const identityInvalid = invalidField === 'identity';
  /** 有錯的時候,欄位的 aria-describedby 要多指一個訊息節點 */
  function describedBy(base: string | null): string | undefined {
    const ids = [base, identityInvalid ? FORM_MSG_ID : null].filter(Boolean);
    return ids.length > 0 ? ids.join(' ') : undefined;
  }
  function clearIdentityError() {
    if (!identityInvalid) return;
    setInvalidField(null);
    setFormError(false);
    setFormMsg(null);
  }

  // 查詢帶入:成功就填名稱與登記地址;查無資料或失敗都提示手動填,不擋新增
  async function handleLookup() {
    const q = form.taxId.trim();
    if (q === '') {
      setLookupMsg(`請先輸入${lookup.label}`);
      return;
    }
    // 格式只在後台設了 lookupPattern 時才檢查。沒設就一律放行 ——
    // 各地的識別碼長什麼樣都有,寫死長度等於把產品綁在一個地區。
    if (lookup.pattern && !lookup.pattern.test(q)) {
      setLookupMsg(`${lookup.label}的格式不正確,請對照原始文件再確認一次`);
      return;
    }
    setLookupBusy(true);
    setLookupMsg('查詢中…');
    try {
      const res = await fetch(
        `${getApiBase()}/api/admin/lookup/business?q=${encodeURIComponent(q)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        setLookupMsg(await apiErrorMessage(res, '查詢失敗,請手動填'));
        return;
      }
      const data = (await res.json()) as {
        name?: string | null;
        address?: string | null;
        phone?: string | null;
      };
      const name = (data.name ?? '').trim();
      const address = (data.address ?? '').trim();
      const phone = (data.phone ?? '').trim();
      if (!name && !address && !phone) {
        setLookupMsg('查無資料,請手動填');
        return;
      }
      // 查詢期間識別碼若被改掉,這筆結果就作廢,避免把別家的資料填進去
      if (taxIdRef.current.trim() !== q) {
        setLookupMsg(`${lookup.label}已變更,請重新查詢`);
        return;
      }
      setForm((prev) =>
        prev.taxId.trim() !== q
          ? prev
          : {
              ...prev,
              companyName: name || prev.companyName,
              registeredAddress: address || prev.registeredAddress,
              contactPhone: phone || prev.contactPhone,
            },
      );
      setLookupMsg('已帶入查到的資料,有錯請直接修改');
    } catch {
      setLookupMsg('查詢失敗,請手動填');
    } finally {
      setLookupBusy(false);
    }
  }

  /** 送出失敗:訊息、錯誤旗標、出錯的欄位一起設,呼叫端不必記得三件事都要做 */
  function failWith(msg: string, field: 'identity' | null = null) {
    setFormMsg(msg);
    setFormError(true);
    setInvalidField(field);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormMsg(null);
    setFormError(false);
    setInvalidField(null);
    const taxId = form.taxId.trim();
    const companyName = form.companyName.trim();
    if (!taxId && !companyName) {
      // 3.3.1 / 3.3.3:訊息要說得出是哪一格、怎麼補,而且要跟欄位有程式上的關聯
      // (aria-invalid + aria-describedby),焦點也要送到第一個有問題的欄位,
      // 不然鍵盤與螢幕閱讀器的使用者停在送出鈕上,完全不知道要回頭改哪裡。
      failWith(`${lookup.label}或公司名至少要填一個,請至少填其中一格`, 'identity');
      taxIdInputRef.current?.focus();
      return;
    }
    // 分類送的一律是後台主檔的代碼,不做任何字串比對。
    // 以前這裡是「選到『其他』就改送使用者自己打的字」,但下拉送出的是代碼不是標籤,
    // 那個條件永遠不成立,補填欄位也永遠不會出現。補充說明改成獨立的一格,
    // 附在備註最前面:後端沒有這個欄位,而備註是這句話唯一讀得到的地方。
    const category = form.category.trim();
    const fullNote = mergeCategoryNote(form.categoryNote, form.note);
    // 先在這裡擋:送出去只會換回一句英文訊息,而那句話會被中文過濾濾掉
    const over = noteOverflow(form.categoryNote, form.note);
    if (over > 0) {
      failWith(`備註連同分類補充說明最多 ${NOTE_MAX} 字,現在多了 ${over} 字,請刪掉之後再送出`);
      noteRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        taxId: taxId || null,
        companyName: companyName || null,
        contactName: form.contactName.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        category: category || null,
        ...(form.premisesType ? { premisesType: form.premisesType } : {}),
        stage: form.stage,
        website: form.website.trim() || null,
        registeredAddress: form.registeredAddress.trim() || null,
        actualAddress: form.actualAddress.trim() || null,
        contactAddress: form.contactAddress.trim() || null,
        note: fullNote || null,
      };
      const res = await fetch(`${crmApiBase()}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 403) {
        failWith('你沒有新增客戶的權限');
        return;
      }
      if (!res.ok) {
        failWith(await apiErrorMessage(res, '新增失敗,請確認欄位後再試'));
        return;
      }
      const created = (await res.json()) as { id?: string };
      setFormMsg('已新增客戶,正在開啟客戶卡…');
      if (created.id) {
        router.push(`/admin/crm/${created.id}` as Route);
        return;
      }
      // 後端沒回 id(理論上不會)就退回看板,至少不會停在填好的表單上
      router.push('/admin/crm/board');
    } catch {
      failWith('新增失敗,請稍後再試');
    } finally {
      setSubmitting(false);
    }
  }

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUseCrm(role)) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">新增客戶</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          無權使用客戶管理。此功能僅限訪查人員、訪查主管與系統管理員使用。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">新增客戶</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {lookup.label}或公司名至少要填一個。建好之後會直接開啟這位客戶的客戶卡。
      </p>

      <form className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={handleCreate}>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="crm-taxId">{lookup.label}</label>
          <div className="flex items-stretch gap-2">
            <input
              id="crm-taxId"
              ref={taxIdInputRef}
              type="text"
              autoComplete="off"
              // 查詢關閉時那段說明不會被畫出來,這裡就不能指過去(指到不存在的 id
              // 等於什麼都沒說明,而且螢幕閱讀器會安靜地略過)。
              // 必填擋下來時再多指一個訊息節點,那一句才是「這一格現在錯在哪」
              aria-invalid={identityInvalid || undefined}
              aria-describedby={describedBy(lookup.enabled ? 'crm-lookup-msg' : null)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={form.taxId}
              // 不做任何字元過濾:各地的識別碼有英文字母、減號、斜線的都有。
              // 只留一個「不會長到離譜」的上限,格式對不對由 lookupPattern 判斷。
              maxLength={64}
              onChange={(e) => {
                const next = e.target.value;
                taxIdRef.current = next;
                setForm({ ...form, taxId: next });
                setLookupMsg(null);
                // 開始補了就把錯誤狀態收掉,不要讓紅字與 aria-invalid 一直掛著
                if (next.trim()) clearIdentityError();
              }}
            />
            {/* 外部查詢沒啟用就整顆不畫。欄位本身留著,只是純手填 */}
            {lookup.enabled ? (
              <button
                type="button"
                onClick={() => void handleLookup()}
                disabled={lookupBusy || form.taxId.trim() === ''}
                aria-describedby="crm-lookup-msg"
                className="btn shrink-0"
              >
                {lookupBusy ? '查詢中…' : '查詢帶入'}
              </button>
            ) : null}
          </div>
          {lookup.enabled ? (
            <p
              id="crm-lookup-msg"
              role="status"
              aria-live="polite"
              className="min-h-[1.25rem] text-xs text-muted-foreground"
            >
              {lookupMsg ?? `輸入${lookup.label}後按「查詢帶入」,自動填上查到的名稱與地址`}
            </p>
          ) : null}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span>公司名({lookup.label}或公司名至少一個)</span>
          <input
            id="crm-companyName"
            aria-invalid={identityInvalid || undefined}
            aria-describedby={describedBy(null)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.companyName}
            onChange={(e) => {
              const next = e.target.value;
              setForm({ ...form, companyName: next });
              if (next.trim()) clearIdentityError();
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>聯絡人</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>電話</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
          />
        </label>
        {/* 建檔即時查重:識別碼、電話、公司名任一有值就查,命中只提示不擋 */}
        <div className="md:col-span-2">
          <DupeHint taxId={form.taxId} phone={form.contactPhone} companyName={form.companyName} />
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span>商業分類</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            <option value="">請選擇</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>場所類型(結案前必選,決定要拍哪些存證照片)</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.premisesType}
            onChange={(e) => setForm({ ...form, premisesType: e.target.value })}
          >
            <option value="">未設定</option>
            {premisesTypes.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>客戶階段</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.stage}
            onChange={(e) => setForm({ ...form, stage: e.target.value })}
          >
            {stageMeta.form.map((st) => (
              <option key={st.key} value={st.key}>
                {st.label}
              </option>
            ))}
          </select>
        </label>
        {/*
          固定顯示,不綁任何一個分類。以前這一格的條件是「分類等於『其他』」,
          但下拉送出的是代碼,條件永遠不成立,選了「其他」的人等不到那一格。
          改成任何分類都能補一句話:選了餐飲想註明是早餐店、選了零售想註明是加盟店,
          都寫得下,而分類本身照樣是統計用得到的代碼。
        */}
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span>分類補充說明(選填)</span>
          <input
            id="crm-category-note"
            aria-describedby="crm-category-note-hint"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            maxLength={100}
            value={form.categoryNote}
            onChange={(e) => setForm({ ...form, categoryNote: e.target.value })}
          />
          <span id="crm-category-note-hint" className="text-xs text-muted-foreground">
            分類選不到剛好的一項,或想註明得更細的時候填。會附在備註最前面。
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span>公司網站</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span>登記地址</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.registeredAddress}
            onChange={(e) => setForm({ ...form, registeredAddress: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span>實際營業地址</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.actualAddress}
            onChange={(e) => setForm({ ...form, actualAddress: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span>聯絡/寄送地址</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={form.contactAddress}
            onChange={(e) => setForm({ ...form, contactAddress: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span>備註</span>
          <textarea
            ref={noteRef}
            aria-describedby="crm-note-hint"
            aria-invalid={noteOver > 0}
            className="min-h-[72px] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            maxLength={noteMax}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <span id="crm-note-hint" role="status" aria-live="polite" className="text-xs">
            {noteOver > 0 ? (
              <span className="text-destructive">
                備註連同分類補充說明最多 {NOTE_MAX} 字,現在多了 {noteOver} 字,送出前請先刪掉。
              </span>
            ) : (
              <span className="text-muted-foreground">
                備註連同分類補充說明共用 {NOTE_MAX} 字的額度,這一格還可以填 {noteLeft} 字。
              </span>
            )}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <button type="submit" disabled={submitting} className="btn btn-primary">
            {submitting ? '送出中…' : '新增'}
          </button>
          <Link href="/admin/crm/home" className="btn">
            回我的首頁
          </Link>
          {/* 錯誤與一般狀態用不同的節點(key 換掉會重新掛上去,輔助科技才會再唸一次):
              錯誤是 role="alert",而且有 id 讓上面的欄位指得到;一般狀態維持 polite */}
          <span
            key={formError ? 'form-error' : 'form-status'}
            id={FORM_MSG_ID}
            role={formError ? 'alert' : 'status'}
            aria-live={formError ? 'assertive' : 'polite'}
            className={`text-sm ${formError ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {formMsg}
          </span>
        </div>
      </form>
    </div>
  );
}
