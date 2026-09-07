'use client';

// 客戶卡的「標記為成交」動作區。
//
// 流程:
//   1. 一進來(以及每次 refreshKey 變動)就打 GET /api/admin/crm/:id/convert-check,
//      把後端說的「還缺什麼」直接寫在畫面上。不是按下去才跳錯誤。
//   2. 缺件時按鈕維持可聚焦但 aria-disabled,並在旁邊給補件入口:
//      場所類型沒選就把焦點送回上面那一格,存證照片缺件就展開補拍。
//   3. 條件齊備才 POST /api/admin/crm/:id/convert,成功後由外層重新載入客戶卡。
//
// 這一區不自己判斷「能不能成交」,那一題只有後端回答得了(必拍清單、豁免場所、
// 已成交都在後端的同一份規則裡)。前端只負責把答案講清楚並指出補件的地方。
//
// 無障礙:按鈕用 aria-disabled 而不是 disabled(disabled 會把焦點丟掉,而這一顆
// 正是使用者從補件回來之後要再按的那一顆);狀態同時用文字表達,不只靠顏色;
// 所有按鈕吃 .btn(命中區 ≥44px)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getApiBase } from '@/lib/env';
import { apiErrorMessage } from '@/lib/api-error';
import {
  CONVERT_CHECK_FALLBACK,
  CONVERT_FAILED_FALLBACK,
  convertBlockText,
  convertFixTarget,
  externalRefBlockReason,
  parseConvertCheck,
  type ConvertCheck,
  type ConvertFacts,
} from '@/lib/crm-convert';

export interface ConvertPanelProps {
  customerId: string;
  /** 這一筆已經成交(階段是成交或已有外部案件編號);已成交就只顯示結果,不再給按鈕 */
  converted: boolean;
  /** 客戶卡已經知道的事實,只用來決定補件入口指向哪一區 */
  facts: ConvertFacts;
  /** 外層改這個值就重新預檢(改完場所類型、補拍完照片) */
  refreshKey: number;
  /** 成交成功後由外層重新載入客戶卡與照片 */
  onConverted: () => void | Promise<void>;
  /** 補件入口:把焦點送回場所類型那一格 */
  onFixPremises: () => void;
  /** 補件入口:展開存證照片的補拍區 */
  onFixPhotos: () => void;
}

export default function ConvertPanel({
  customerId,
  converted,
  facts,
  refreshKey,
  onConverted,
  onFixPremises,
  onFixPhotos,
}: ConvertPanelProps) {
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const crmBase = `${getApiBase()}/api/admin/crm`;

  const [check, setCheck] = useState<ConvertCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [externalRef, setExternalRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 送出中用 ref 早退(按鈕不 disabled,焦點才不會掉出去)
  const busyRef = useRef(false);
  /*
   * 預檢的請求序號。同一個面板常常有兩次預檢同時在路上:一進來問一次,使用者改完
   * 場所類型(refreshKey 變動)又問一次。沒有序號的話,先送出的那一次晚回來就會把
   * 後送出的答案蓋掉,面板停在「還缺:招牌、門牌」而按鈕維持 aria-disabled,
   * 但此刻其實已經可以成交。資料沒事(後端每次成交都自己重檢),壞掉的是畫面上的答案。
   * 每次發出就加一號,只有「號碼還是最新那一號」的回應才准寫進畫面。
   */
  const checkSeqRef = useRef(0);

  const runCheck = useCallback(async () => {
    if (converted) return;
    const seq = (checkSeqRef.current += 1);
    const latest = () => seq === checkSeqRef.current;
    setChecking(true);
    setCheckErr(null);
    try {
      const res = await fetch(`${crmBase}/${customerId}/convert-check`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const message = await apiErrorMessage(res, CONVERT_CHECK_FALLBACK);
        if (!latest()) return;
        setCheck(null);
        setCheckErr(message);
        return;
      }
      const parsed = parseConvertCheck(await res.json());
      if (!latest()) return;
      if (!parsed) {
        setCheck(null);
        setCheckErr(CONVERT_CHECK_FALLBACK);
        return;
      }
      setCheck(parsed);
    } catch {
      if (!latest()) return;
      setCheck(null);
      setCheckErr(CONVERT_CHECK_FALLBACK);
    } finally {
      // 舊的那一筆回來時不能把「還在問」關掉:此刻新的那一筆還在路上
      if (latest()) setChecking(false);
    }
  }, [converted, crmBase, customerId]);

  useEffect(() => {
    void runCheck();
  }, [runCheck, refreshKey]);

  async function submit() {
    if (busyRef.current) return;
    if (!check?.ok) {
      // 條件沒齊就不送出。按鈕本身已經標了 aria-disabled,這裡是最後一道。
      setMsg(check ? convertBlockText(check) : CONVERT_CHECK_FALLBACK);
      return;
    }
    const refBlocked = externalRefBlockReason(externalRef);
    if (refBlocked) {
      setMsg(refBlocked);
      return;
    }
    busyRef.current = true;
    setSubmitting(true);
    setMsg(null);
    try {
      const ref = externalRef.trim();
      const res = await fetch(`${crmBase}/${customerId}/convert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ref ? { externalRef: ref } : {}),
      });
      if (!res.ok) {
        setMsg(await apiErrorMessage(res, CONVERT_FAILED_FALLBACK));
        // 後端擋下來的理由可能已經變了(例如照片剛被別人刪掉),重問一次
        await runCheck();
        return;
      }
      setMsg('已標記為成交');
      setExternalRef('');
      await onConverted();
    } catch {
      setMsg(CONVERT_FAILED_FALLBACK);
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  }

  if (converted) {
    return (
      <section
        aria-labelledby={`${uid}-title`}
        className="rounded-lg border border-border bg-surface p-4"
      >
        <h2 id={`${uid}-title`} className="mb-3 text-base font-semibold">
          標記為成交
        </h2>
        <p role="status" className="text-sm text-foreground">
          這筆客戶已經成交,不會再標記一次。
        </p>
      </section>
    );
  }

  const blockText = check ? convertBlockText(check) : null;
  const fix = check ? convertFixTarget(check, facts) : null;
  const ready = check?.ok === true;

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={`${uid}-title`} className="mb-3 text-base font-semibold">
        標記為成交
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        標記之前系統會先檢查場所類型與必拍的存證照片。必拍清單由系統管理員在後台的照片存證檢查表決定。
      </p>

      {/* 狀態一律寫成整句話,不靠顏色或圖示表達 */}
      <p id={reasonId} role="status" aria-live="polite" className="mb-3 text-sm font-medium">
        {checking && !check && !checkErr
          ? '檢查中…'
          : checkErr
            ? checkErr
            : ready
              ? '目前條件齊備,可以標記為成交。'
              : (blockText ?? '')}
      </p>

      {!ready && fix === 'premises' && (
        <button type="button" className="btn mb-3" onClick={onFixPremises}>
          去選場所類型
        </button>
      )}
      {!ready && fix === 'photos' && (
        <button type="button" className="btn mb-3" onClick={onFixPhotos}>
          去補拍存證照片
        </button>
      )}

      <label className="mb-3 flex flex-col gap-1 text-sm">
        <span>外部案件編號(選填)</span>
        <input
          className="min-h-[44px] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={externalRef}
          onChange={(e) => setExternalRef(e.target.value)}
          placeholder="留空即可"
          inputMode="text"
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">
          接別的系統時才要填,格式是 UUID。一個編號只能對到一位客戶。
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={!ready}
          aria-describedby={reasonId}
          aria-busy={submitting}
          onClick={() => void submit()}
        >
          {submitting ? '標記中…' : '標記為成交'}
        </button>
        <button type="button" className="btn" onClick={() => void runCheck()} aria-busy={checking}>
          重新檢查
        </button>
      </div>
      {msg && (
        <p role="alert" className="mt-2 text-sm">
          {msg}
        </p>
      )}
    </section>
  );
}
