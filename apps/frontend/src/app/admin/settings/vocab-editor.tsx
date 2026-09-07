// ref:3687 mc/陳彥輔/米球®
'use client';

// 互動管道與場所類型的編輯器。
//
// 兩份清單長得一模一樣(代碼加名稱加順序),所以共用同一個元件,由呼叫端給名詞。
// 分開寫兩份的話,加一個欄位就要記得兩邊都改,而漏掉的那一邊在畫面上看不出來。
//
// 為什麼要有這一頁:這兩份清單原本寫死在程式碼裡。設備維修公司想把管道換成
// 「工單、現場、電話」怎麼點都改不了;照片存證檢查表按場所類型分組,所以連
// 「加一種新的現場」都做不到。清單進了主檔,設定頁就要跟著出現,不然一樣沒人改得到。
//
// 無障礙:每個輸入都有 label;可點區域最小 44px;刪除要二次確認,而且確認的問句
// 寫得出「刪掉哪一個」;已經在用的那幾筆用文字寫出筆數,不是只把按鈕灰掉。

import { useState } from 'react';
import { Field } from '@/components/settings/editors';
import type { VocabItem } from '@/lib/app-settings';

export function VocabEditor({
  items,
  onChange,
  what,
  hint,
  inUseCounts,
  reservedKeys = [],
  keyPrefix,
  usageNoun,
}: {
  items: VocabItem[];
  onChange: (next: VocabItem[]) => void;
  /** 這份清單叫什麼(「互動管道」「場所類型」),所有文案都由它組出來 */
  what: string;
  /** 這一頁最上面那句說明 */
  hint: string;
  /** 代碼 → 目前有幾筆資料在用。有值時刪除鈕會擋下來並說明原因 */
  inUseCounts?: Record<string, number>;
  /** 系統保留、不可刪除的代碼 */
  reservedKeys?: readonly string[];
  /** 新增一列時代碼的前綴,例如 channel_3 */
  keyPrefix: string;
  /** 「已經有 N 筆」的那個量詞,例如「筆互動紀錄」「位客戶」 */
  usageNoun: string;
}) {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  function update(i: number, next: Partial<VocabItem>) {
    const rows = [...items];
    const cur = rows[i];
    if (!cur) return;
    rows[i] = { ...cur, ...next };
    onChange(rows);
  }

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const rows = [...items];
    const a = rows[i];
    const b = rows[j];
    if (!a || !b) return;
    rows[i] = b;
    rows[j] = a;
    onChange(rows);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{hint}</p>
      <p className="text-sm text-muted-foreground">
        代碼(key)會寫進資料庫,改了之後既有資料就對不上,所以只在還沒開始用的時候改。
        要換名字請改名稱那一格,代碼不用動。至少要留一項,全部刪掉存不了檔。
      </p>
      <ul className="space-y-3">
        {items.map((item, i) => {
          const used = inUseCounts?.[item.key] ?? 0;
          const reserved = reservedKeys.includes(item.key);
          const confirming = confirmKey === item.key;
          const blocked = used > 0 || reserved;
          return (
            <li key={i} className="rounded-md border border-border p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={`第 ${i + 1} 個${what}的名稱`}>
                  <input
                    type="text"
                    className="input"
                    value={item.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                  />
                </Field>
                <Field label={`第 ${i + 1} 個${what}的代碼`} hint="小寫英數字、底線、減號">
                  <input
                    type="text"
                    className="input font-mono"
                    value={item.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                </Field>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
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
                  disabled={i === items.length - 1}
                >
                  下移
                </button>

                {reserved ? (
                  <span className="text-sm text-muted-foreground">
                    系統保留,不能刪除(名稱與順序照樣可以改)
                  </span>
                ) : used > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    已經有 {used} {usageNoun}在用,不能刪除
                  </span>
                ) : confirming ? (
                  <>
                    <span className="text-sm">
                      確定刪掉「{item.label || item.key}」這個{what}?
                    </span>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm min-h-[44px] px-3"
                      onClick={() => {
                        onChange(items.filter((_, k) => k !== i));
                        setConfirmKey(null);
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
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm min-h-[44px] px-3"
                    onClick={() => setConfirmKey(item.key)}
                    disabled={blocked || items.length <= 1}
                  >
                    刪除
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
        onClick={() => onChange([...items, { key: `${keyPrefix}_${items.length + 1}`, label: '' }])}
      >
        新增{what}
      </button>
    </div>
  );
}
