'use client';

// 新增客戶表單的即時查重提示。
// 識別碼、電話、公司名任一欄位輸入停止 600ms 後打 GET /api/admin/crm-duplicates/check,
// 有命中就顯示「可能已有此客戶」並連到客戶卡;沒命中或查詢失敗就不顯示(不擋建檔)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getApiBase } from '@/lib/env';
import { useStageMeta } from '@/lib/crm-shared';

export interface DupeHintProps {
  taxId: string;
  phone: string;
  companyName: string;
}

interface DupeMatch {
  id: string;
  companyName: string | null;
  taxId: string | null;
  contactPhone: string | null;
  stage: string;
  ownerName: string;
  reason: string;
}

const DEBOUNCE_MS = 600;
const MIN_PHONE_DIGITS = 8;

export default function DupeHint({ taxId, phone, companyName }: DupeHintProps) {
  const stageMeta = useStageMeta();
  const [matches, setMatches] = useState<DupeMatch[]>([]);

  const tax = taxId.trim();
  const digits = phone.replace(/\D/g, '');
  const name = companyName.trim();

  useEffect(() => {
    // 三個都空(或電話太短)就不查,並清掉舊結果
    const usePhone = digits.length >= MIN_PHONE_DIGITS;
    if (!tax && !usePhone && !name) {
      setMatches([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams();
      if (tax) params.set('taxId', tax);
      if (usePhone) params.set('phone', digits);
      if (name) params.set('companyName', name);
      try {
        const res = await fetch(
          `${getApiBase()}/api/admin/crm-duplicates/check?${params.toString()}`,
          {
            credentials: 'include',
            signal: ctrl.signal,
          },
        );
        if (!res.ok) {
          setMatches([]);
          return;
        }
        const data = (await res.json()) as { matches?: DupeMatch[] };
        setMatches(data.matches ?? []);
      } catch {
        // 中止或連線失敗都靜默,不影響建檔
        if (!ctrl.signal.aborted) setMatches([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [tax, digits, name]);

  // 沒命中不佔版面,但保留 live region 讓螢幕報讀器在出現時播報
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {matches.length > 0 && (
        <div
          className="mt-1 rounded-md border-2 p-2"
          style={{ borderColor: 'var(--color-warning)', backgroundColor: 'var(--color-surface)' }}
        >
          <p className="font-medium text-foreground">可能已有此客戶,請先確認再建檔:</p>
          <ul className="mt-1 flex flex-col gap-1">
            {matches.map((m) => {
              const cname = m.companyName || m.taxId || '(未命名)';
              return (
                <li key={m.id} className="text-foreground">
                  可能已有此客戶:{cname}(負責人 {m.ownerName},階段 {stageMeta.label(m.stage)},
                  {m.reason})
                  <Link
                    href={`/admin/crm/${m.id}`}
                    target="_blank"
                    rel="noopener"
                    className="ml-2 inline-flex min-h-[44px] items-center"
                  >
                    開啟 {cname} 的客戶卡(另開分頁)
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
