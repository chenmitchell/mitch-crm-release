'use client';

// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * ModalDialog — 對話框的焦點管理(WCAG 2.1.2 No Keyboard Trap / 2.4.3 Focus Order /
 * 2.4.11 Focus Not Obscured 的前置條件)
 *
 * ── 為什麼要有這個共用元件 ──────────────────────────────────────
 * `aria-modal="true"` 只是告訴輔助科技「這底下是模態」,它不會幫你做任何事。
 * 焦點要自己搬進去、Tab 要自己鎖、Escape 要自己接、關掉要自己還給觸發的按鈕、
 * 背景要自己設成 inert。少任何一項,鍵盤與螢幕閱讀器使用者就會走出對話框、
 * 在看不到的背景裡亂按 —— 使用者管理那兩個視窗實測就是一路 Tab 到頁尾再掉到 body。
 *
 * 做法照的是 `app/admin/team/page.tsx` 那一份(它是這個 repo 裡唯一做對的),
 * 這裡把它抽出來,再補上兩件那一份沒做的事:
 *   1. 背景 inert:對話框以外的 DOM 一律加 `inert`,滑鼠、Tab、螢幕閱讀器的
 *      虛擬游標都進不去。作法是從對話框自己往上走到 body,沿路把「兄弟節點」
 *      設成 inert,關閉時原樣還原(本來就有 inert 的不還原)。
 *   2. 觸發鈕在請求期間被 disabled 時焦點會掉到 body,關閉後就沒有東西可以還。
 *      所以 opener 由呼叫端在按下的當下記起來(見 useDialogOpener),
 *      還原時若那顆按鈕已經不能聚焦,就退回 fallback。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   const dlg = useDialogOpener();
 *   <button onClick={(e) => { dlg.remember(e.currentTarget); setOpen(true); }}>編輯</button>
 *   {open ? (
 *     <ModalDialog labelledBy="edit-title" onClose={() => setOpen(false)} opener={dlg}>
 *       <h2 id="edit-title">...</h2>
 *     </ModalDialog>
 *   ) : null}
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/** 可聚焦元素的選擇器。跟 team 那一份同一串,另外把 disabled 的排掉 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogOpener {
  /** 按下觸發鈕的當下記住它。請求期間那顆鈕可能被 disabled,那時焦點已經掉了,記晚了就沒得記 */
  remember: (el: HTMLElement | null) => void;
  /** 內部用:把焦點還回去 */
  restore: () => void;
}

/**
 * 記住「是誰打開這個對話框的」。
 * 回傳的物件身分固定,可以安心放進 effect 的相依陣列。
 */
export function useDialogOpener(): DialogOpener {
  const ref = useRef<HTMLElement | null>(null);
  const remember = useCallback((el: HTMLElement | null) => {
    ref.current = el;
  }, []);
  const restore = useCallback(() => {
    const el = ref.current;
    if (!el || !el.isConnected) return;
    // 觸發鈕可能還停在請求中的 disabled 狀態。disabled 的 <button> 聚焦不了,
    // 補 tabindex 也一樣,focus() 是無效呼叫,焦點會留在 body ——
    // 鍵盤使用者要從整份文件的最前面重新 Tab 一次才回得到那一列。
    // 這種時候退而求其次:把焦點放在包住它的那一塊(表格列、清單項、表單),
    // 螢幕閱讀器就從那裡接下去。
    if (el instanceof HTMLButtonElement && el.disabled) {
      const holder = el.closest('tr, li, form, fieldset, section, article') ?? el.parentElement;
      if (holder instanceof HTMLElement) {
        if (!holder.hasAttribute('tabindex')) holder.setAttribute('tabindex', '-1');
        holder.focus();
      }
      return;
    }
    el.focus();
  }, []);
  return useRef<DialogOpener>({ remember, restore }).current;
}

/**
 * 把 root 以外的整棵 DOM 設成 inert,回傳還原函式。
 * 只動「祖先鏈上的兄弟節點」,所以對話框整塊(含遮罩按鈕)與它的祖先都不受影響 ——
 * 從 panel 起算的話遮罩會被自己 inert 掉,點遮罩關閉就失效了。
 */
function inertOutside(root: HTMLElement): () => void {
  const touched: HTMLElement[] = [];
  let node: HTMLElement | null = root;
  while (node && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute('inert')) continue; // 本來就是 inert,不是我們設的,別還原
      sibling.setAttribute('inert', '');
      touched.push(sibling);
    }
    node = parent === document.body ? null : parent;
  }
  return () => {
    for (const el of touched) el.removeAttribute('inert');
  };
}

export interface ModalDialogProps {
  /** 對話框標題元素的 id(對應 aria-labelledby) */
  labelledBy: string;
  /** 關閉。Escape、點遮罩、以及呼叫端自己的關閉鈕都走這一條 */
  onClose: () => void;
  /** 由 useDialogOpener() 取得。關閉後焦點還給它記住的那顆按鈕 */
  opener?: DialogOpener;
  /** panel 的附加 class(例如 max-w-md) */
  panelClassName?: string;
  /** 用 form 當 panel 時給 onSubmit;有給就 render 成 <form> */
  onSubmit?: (e: React.FormEvent) => void;
  children: ReactNode;
}

export function ModalDialog({
  labelledBy,
  onClose,
  opener,
  panelClassName = '',
  onSubmit,
  children,
}: ModalDialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | HTMLFormElement | null>(null);
  // onClose 幾乎都是 inline 箭頭函式,放進相依陣列會讓 effect 每次 render 都重跑,
  // 焦點就會被搶回第一個元素。用 ref 讀最新的那一份。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    const overlay = overlayRef.current;
    if (!panel || !overlay) return;
    const restoreInert = inertOutside(overlay);

    /** panel 自己收焦點的退路。它不是控制項,所以只給 tabindex="-1",不進 Tab 順序 */
    const focusPanel = () => {
      if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      panel.focus();
    };

    /**
     * FOCUSABLE 是選擇器比對,比對得到不等於聚焦得了。
     * `<input type="hidden">`、display:none 的 button、祖先是 hidden 的元素都選得到,
     * 而 focus() 對它們是無效呼叫。先把明顯聚焦不了的濾掉,焦點鎖算 first / last
     * 才算得到真的那一個。
     *
     * 這裡用 panel.querySelectorAll,它**不穿透 shadow root**:panel 裡若有
     * 自訂元素把控制項放在 shadow DOM 裡,這一串就看不到它們,Tab 會被鎖在
     * panel 本身。目前這個 repo 沒有任何 attachShadow,所以是潛在問題不是現況;
     * 哪天真的引進 shadow DOM,這一段要改成沿著 shadowRoot 遞迴收集。
     */
    const focusableItems = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
        if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
        if (el.getClientRects().length === 0) return false; // display:none、還沒排版
        return getComputedStyle(el).visibility !== 'hidden';
      });

    /**
     * 依序試著把焦點放進 list 裡的元素,真的進去了才算數,一個都不行就退回 panel。
     *
     * 為什麼要回頭確認:`items[0].focus()` 只要碰到一個「比對得到但聚焦不了」的
     * 元素就是無效呼叫,而 Tab 那一段的 preventDefault() 已經先執行了 ——
     * 焦點原地不動,使用者卡在最後一個元素上,往前 Tab 永遠不會動。
     * 實測(Chromium,panel 內容 `<input type="hidden">` + 兩顆 button,連按五次 Tab):
     * panel 到 b1 到 b2 到 b2 到 b2 到 b2。這跟 items.length === 0 要防的是同一件事,
     * 條件只是從「一個都沒有」變成「第一個是假的」。
     */
    const focusInto = (list: HTMLElement[]) => {
      for (const el of list) {
        el.focus();
        if (document.activeElement === el && panel.contains(el)) return true;
      }
      focusPanel();
      return false;
    };

    // 開啟時焦點移進對話框:第一個真的聚焦得了的元素,沒有的話退回 panel 本身。
    focusInto(focusableItems());

    const onKey = (e: KeyboardEvent) => {
      // 輸入法組字中的按鍵不要攔。正體中文使用者在對話框裡打字時,Escape 是
      // 「取消這一段還沒送出的候選字」,Tab 是「切候選字」,那些鍵在組字結束前
      // 不是給對話框的。實測(CDP Input.imeSetComposition 起一段注音再按 Escape):
      // 頁面收到的 keydown 帶 isComposing=true,少了這道判斷整個對話框會被關掉,
      // 連同已經填好的欄位一起消失。keyCode 229 是舊版瀏覽器同一件事的表示法。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // 焦點鎖:Tab 到底繞回第一個(反向亦然)。inert 已經擋掉大部分情況,
      // 這一段是為了不依賴瀏覽器對 inert 的支援程度。
      const items = focusableItems();
      // 一個可聚焦元素都沒有(內容還在載入、或整組控制項在送出期間被 disabled)。
      // 這時候放行等於把焦點交給瀏覽器,而背景已經全部 inert,焦點會直接掉到 body
      // 再一個 Tab 就跑出文件到瀏覽器的網址列 —— 使用者被推出對話框而且回不來。
      if (items.length === 0) {
        e.preventDefault();
        focusPanel();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        focusInto(items);
      } else if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        focusInto([...items].reverse());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreInert();
      opener?.restore();
    };
  }, [opener]);

  const panelClass = `modal-panel ${panelClassName}`.trim();

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="modal-overlay"
    >
      {/* 點遮罩關閉。它同時是「關閉視窗」這個動作在對話框裡的第一個可聚焦元素,
          所以放在 panel 外面 —— 焦點鎖只鎖 panel,遮罩不該吃到焦點。 */}
      <button
        type="button"
        aria-label="關閉視窗"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-transparent"
      />
      {onSubmit ? (
        <form
          ref={panelRef as React.RefObject<HTMLFormElement>}
          onSubmit={onSubmit}
          className={panelClass}
        >
          {children}
        </form>
      ) : (
        <div
          ref={panelRef as React.RefObject<HTMLDivElement>}
          role="document"
          className={panelClass}
        >
          {children}
        </div>
      )}
    </div>
  );
}
