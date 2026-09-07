'use client';

// 客戶管理「秒查客戶」:業務在電話上或現場,打幾個字就找到客戶卡。
//
// 關鍵字送到後端查(GET /api/admin/crm?q=),不是把客戶整批撈到前端過濾:
// 清單有筆數上限(預設 500),前端過濾的結果是第 501 筆起的客戶永遠查不到,
// 而畫面上不會說少了什麼 —— 一支「查不到就是沒有」的搜尋,錯得完全看不出來。
// 停止輸入 250ms 後才送出,而且要打到最小字數才送:中文兩個字、英數三個字元。
// 為什麼要有最小字數:後端那支是四到六個欄位的 ILIKE '%x%',btree 索引一個都用不到,
// 而且 ORDER BY 逼它把命中的列全部掃完才排得出來,LIMIT 不會讓它提早結束。
// 五萬筆客戶實測單次就是全表掃描;只打一個中文字最糟,命中兩三萬列。
// 只打一個字,換回來的也是「符合的客戶不只這些」,對使用者沒有價值,對資料庫卻是滿載。
// 不到最小字數時畫面要說還差幾個字(role=status 會播報),不能靜靜不動。
// 結果最多列 8 筆,超過就提示縮小範圍。
// 每筆整塊連到 /admin/crm/[id]。
// 無障礙:輸入框有 label 與說明、查詢狀態 role="status" aria-live、
//   查詢中不 disable 輸入框(焦點會掉),改 aria-busy。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useStageMeta } from '@/lib/crm-shared';
import { useLookupLabel } from '@/lib/app-settings';

// 最小結構型別,不從 page.tsx import;清單的 DevCustomer 可直接當這個型別傳入
export interface QuickSearchCustomer {
  id: string;
  taxId: string | null;
  companyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  stage: string;
  owner?: { name: string } | null;
}

export interface QuickSearchResult {
  rows: QuickSearchCustomer[];
  /** 後端還有更多沒回(命中數超過這次要的筆數) */
  more: boolean;
}

export interface QuickSearchProps {
  /** 關鍵字查詢;回 null 表示失敗,由元件顯示錯誤訊息 */
  search: (q: string, signal: AbortSignal) => Promise<QuickSearchResult | null>;
}

/** 停止輸入多久之後才真的送出查詢 */
export const SEARCH_DEBOUNCE_MS = 250;
/** 一次最多列幾筆 */
export const MAX_RESULTS = 8;
/** 含非 ASCII 字元(中文、日文這類)的關鍵字,最少要幾個字 */
export const MIN_QUERY_CJK = 2;
/** 純 ASCII(英數、電話、識別碼)的關鍵字,最少要幾個字元 */
export const MIN_QUERY_ASCII = 3;

/**
 * 這個關鍵字還差幾個字才會送出查詢。0 表示可以查了。
 *
 * 中文兩個字、英數三個字元:一個中文字在五萬筆的資料裡命中好幾萬列,兩個字就收斂得多;
 * 英數的區辨度更低(電話與識別碼都是數字),所以要三個字元。
 * 用 code point 數,不是 length:一個罕用字或表情符號在 UTF-16 裡佔兩格,
 * 用 length 會讓它自己一個就滿足「兩個字」。
 */
export function charsShortOf(query: string): number {
  const chars = [...query.trim()];
  if (chars.length === 0) return 0;
  const min = chars.some((c) => (c.codePointAt(0) ?? 0) > 0x7f) ? MIN_QUERY_CJK : MIN_QUERY_ASCII;
  return Math.max(0, min - chars.length);
}

export default function QuickSearch({ search }: QuickSearchProps) {
  const stageMeta = useStageMeta();
  // 識別碼欄位在當地叫什麼由後台設定決定,畫面不寫死任何一種說法
  const lookupLabel = useLookupLabel();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<QuickSearchCustomer[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // 已經送出過查詢的關鍵字:用來分辨「還沒查」與「查完了沒有結果」
  const [answered, setAnswered] = useState('');
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const labelId = `${inputId}-label`;

  const trimmed = query.trim();
  // 還差幾個字才送得出去。> 0 就不打後端,只在畫面上說還差幾個字
  const short = charsShortOf(trimmed);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    if (!trimmed || short > 0) {
      setHits([]);
      setMore(false);
      setBusy(false);
      setFailed(false);
      setAnswered('');
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await searchRef.current(trimmed, ac.signal);
          if (ac.signal.aborted) return;
          setFailed(res === null);
          setHits(res?.rows ?? []);
          setMore(res?.more ?? false);
          setAnswered(trimmed);
        } catch {
          if (!ac.signal.aborted) {
            setFailed(true);
            setHits([]);
          }
        } finally {
          if (!ac.signal.aborted) setBusy(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [trimmed, short]);

  const shown = hits.slice(0, MAX_RESULTS);
  const extra = hits.length - shown.length;

  // 播報文字:沒輸入不播,查詢中講查詢中,查完講幾筆
  let statusText = '';
  if (trimmed && short > 0) {
    statusText = `再輸入 ${short} 個字就開始查(中文至少 ${MIN_QUERY_CJK} 個字,英數至少 ${MIN_QUERY_ASCII} 個字元)`;
  } else if (trimmed) {
    if (busy) statusText = '查詢中';
    else if (failed) statusText = '查詢失敗,請稍後再試';
    else if (answered === trimmed)
      statusText = hits.length === 0 ? '找不到符合的客戶' : `找到 ${hits.length} 筆`;
  }

  return (
    <section aria-labelledby={labelId} className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-col gap-1 text-sm">
        <label id={labelId} htmlFor={inputId} className="text-base font-semibold">
          秒查客戶
        </label>
        {/* 查詢中不 disable 輸入框(焦點會掉,而且使用者正在打字),只標 aria-busy */}
        <input
          id={inputId}
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={`電話／${lookupLabel}／公司名`}
          aria-describedby={hintId}
          aria-busy={busy}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          輸入電話、{lookupLabel}
          、公司名或聯絡人的一部分,中文打滿 {MIN_QUERY_CJK} 個字、英數打滿 {MIN_QUERY_ASCII}{' '}
          個字元,停一下就會查。查的是你看得到的全部客戶,不只畫面上這一頁。
        </p>
      </div>

      <p
        role="status"
        aria-live="polite"
        className="mt-2 min-h-[1.25rem] text-xs text-muted-foreground"
      >
        {statusText}
      </p>

      {shown.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {shown.map((c) => {
            const cname = c.companyName || c.taxId || '(未命名)';
            const stageLabel = stageMeta.label(c.stage);
            return (
              <li key={c.id}>
                <Link
                  href={`/admin/crm/${c.id}`}
                  className="block min-h-[44px] rounded-md border border-border bg-background px-3 py-2 text-left hover:bg-muted"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{cname}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{stageLabel}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>
                      {lookupLabel} {c.taxId || '—'}
                    </span>
                    <span>電話 {c.contactPhone || '—'}</span>
                    <span>負責人 {c.owner?.name || '未指派'}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {(extra > 0 || more) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {more
            ? '符合的客戶不只這些,請輸入更多字縮小範圍'
            : `還有 ${extra} 筆,請輸入更多字縮小範圍`}
        </p>
      )}
    </section>
  );
}
