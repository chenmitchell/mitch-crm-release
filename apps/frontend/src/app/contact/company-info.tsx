'use client';

import { useEffect, useState } from 'react';
import { fetchPublicSettings, type PublicSettings } from '@/lib/public-settings';

type LoadState = 'loading' | 'ready' | 'unavailable';

/**
 * 公司聯絡資料區塊。
 *
 * 值一律從後端的公開設定端點來(GET /api/public/settings),不寫死在這裡。
 * 公司搬家、換總機號碼時,管理員在後台改一次,這一頁跟客戶下載頁同時跟著變。
 *
 * 讀不到的時候刻意「不顯示任何地址與電話」,只請對方找承辦窗口:
 * 一組可能已經過期的地址,比沒有地址危險得多 —— 對方會照著它把文件寄到
 * 已經搬走的地方,而且沒有人會發現。
 */
export function CompanyInfo() {
  const [state, setState] = useState<LoadState>('loading');
  const [settings, setSettings] = useState<PublicSettings | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      const s = await fetchPublicSettings(ac.signal);
      if (ac.signal.aborted) return;
      if (!s) {
        setState('unavailable');
        return;
      }
      setSettings(s);
      setState('ready');
    })();
    return () => ac.abort();
  }, []);
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
  const rows: Array<{ term: string; value: string }> = settings
    ? [
        { term: '公司名稱', value: settings.companyName },
        { term: '聯絡電話', value: settings.phone },
        { term: '紙本文件收件地址', value: settings.mailingAddress },
      ].filter((r) => r.value.trim().length > 0)
    : [];

  return (
    <section aria-labelledby="contact-company" className="card space-y-3">
      <h2 id="contact-company" className="page-h2">
        公司聯絡資料
      </h2>
      <div role="status" aria-live="polite">
        {state === 'loading' ? <p className="text-muted-foreground">正在讀取公司聯絡資料</p> : null}

        {state === 'ready' && rows.length > 0 ? (
          <dl className="space-y-2">
            {rows.map((r) => (
              <div key={r.term} className="sm:grid sm:grid-cols-[10rem_1fr] sm:gap-3">
                <dt className="font-semibold">{r.term}</dt>
                <dd className="text-muted-foreground">{r.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {state === 'unavailable' || (state === 'ready' && rows.length === 0) ? (
          <p className="text-muted-foreground">
            目前讀不到系統設定裡的公司聯絡資料。請直接聯絡您的業務窗口,或稍後重新整理這一頁
          </p>
        ) : null}
      </div>
      {state === 'ready' && rows.length > 0 ? (
        <p className="page-subtle">
          以上資料由系統設定即時帶出。要寄回紙本文件前,建議再跟您的業務窗口確認一次收件人
        </p>
      ) : null}
    </section>
  );
}
