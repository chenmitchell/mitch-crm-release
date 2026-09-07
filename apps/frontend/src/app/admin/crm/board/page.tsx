'use client';

// 客戶看板(/admin/crm/board)。KPI 卡列 + 拖拉看板;欄位就是後台設定的客戶階段,不是寫死的六欄。
// 「今日三件事」不放這裡:我的首頁(/admin/crm/home)已經有一份,同一份清單出現兩次反而讓人分心。
// 資料來源:GET /api/admin/crm/board、GET /api/admin/crm/report?range=week&scope=me(KPI 的本週拜訪)、
//   PATCH /api/admin/crm/:id(換階段)。
// 無障礙:拖拉之外每張卡都有 >= 44px 的「移動」按鈕當鍵盤/觸控替代路徑,移動結果 role="status" aria-live,
//   欄位配色的 fg 對 bg >= 7:1(色盤見 lib/app-settings.tsx),階段名稱是文字不只靠顏色。
// 每一欄先畫前 COLUMN_PAGE_SIZE 張,其餘按「載入更多」才展開:
//   後端一次給到 BOARD_TAKE(1000)筆,七欄全部攤開就是上千張可拖曳的卡同時在 DOM 裡,
//   每張都掛著 dragStart / dragEnd。這裡不做虛擬捲動,是因為虛擬捲動會在拖曳中途把
//   來源或目標卡片卸載掉(HTML5 拖放的 dragend 會因此收不到),鍵盤那條「移動」按鈕的
//   焦點也會跟著掉。分頁展開沒有這個問題:畫出來的卡片就一直在,拖放與鍵盤路徑完全不變。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { apiErrorMessage } from '@/lib/api-error';
import KpiCards from '@/components/crm/kpi-cards';
import {
  canUseCrm,
  crmApiBase,
  fetchBoard,
  fmtShortDate,
  isOverdue,
  isViewAllRole,
  useCrmRole,
  useStageMeta,
  type Board,
  type StageKey,
} from '@/lib/crm-shared';
import { useAppSettings } from '@/lib/app-settings';

/** 每一欄一開始畫幾張卡,按一次「載入更多」再多畫這麼多張 */
export const COLUMN_PAGE_SIZE = 30;

/**
 * 這一欄目前該畫幾張。shown 是使用者按過幾次「載入更多」之後的張數。
 * 卡片被拖走、被移進來都會改變 total,所以每次都夾在 [0, total] 之間重算。
 */
export function columnShownCount(total: number, shown: number | undefined): number {
  const base = typeof shown === 'number' && shown > 0 ? shown : COLUMN_PAGE_SIZE;
  return Math.min(total, base);
}

export default function CrmBoardPage() {
  const role = useCrmRole();
  // 跟進日以組織設定的時區顯示,不是看板前面那個人的裝置時區
  const { timezone } = useAppSettings();
  // 看板欄位 = 後台設定裡標了「進看板」的階段,順序即設定的順序
  const stageMeta = useStageMeta();
  const [board, setBoard] = useState<Board>({});
  // 看板被後端上限切掉時要說出來(後端回 truncated / take,見 lib/crm-shared 的 fetchBoard)
  const [boardLimit, setBoardLimit] = useState<{ take: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weeklyVisits, setWeeklyVisits] = useState<number | null>(null);

  // 拖拉換階段的狀態
  const dragIdRef = useRef<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<StageKey | null>(null);
  const [moveMsg, setMoveMsg] = useState<string | null>(null);
  const [moveOpenId, setMoveOpenId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movePick, setMovePick] = useState<StageKey | ''>('');
  const moveBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  // 每一欄目前展開到第幾張(沒有記錄的欄位就是 COLUMN_PAGE_SIZE)
  const [shownPerStage, setShownPerStage] = useState<Record<string, number>>({});
  // 「載入更多」的結果要講出來,不然按下去只有畫面變長,螢幕閱讀器沒有任何回饋
  const [expandMsg, setExpandMsg] = useState<string | null>(null);

  const canUse = canUseCrm(role);
  const viewAll = isViewAllRole(role);

  const loadBoard = useCallback(async () => {
    if (role === null) return;
    if (!canUse) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBoard(stageMeta.all);
      if (data === null) setError('看板載入失敗,請稍後再試');
      else {
        setBoard(data.board);
        setBoardLimit({ take: data.take, truncated: data.truncated });
      }
    } catch {
      setError('看板載入失敗,請稍後再試');
    } finally {
      setLoading(false);
    }
  }, [role, canUse, stageMeta]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  // KPI 的「本週拜訪」:拿本人本週報告的 visits;拿不到就顯示 null(卡片自己會處理)
  useEffect(() => {
    if (role === null || !canUse) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${crmApiBase()}/report?range=week&scope=me`, {
          credentials: 'include',
        });
        if (!alive || !res.ok) return;
        const d = (await res.json()) as { stats?: { visits?: number } };
        setWeeklyVisits(typeof d.stats?.visits === 'number' ? d.stats.visits : null);
      } catch {
        /* 少一個數字不影響看板 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [role, canUse]);

  function findStageOf(id: string): StageKey | null {
    for (const { key: s } of stageMeta.all) {
      if ((board[s] ?? []).some((c) => c.id === id)) return s;
    }
    return null;
  }

  function focusMoveButton(id: string) {
    moveBtnRefs.current.get(id)?.focus();
  }
  useEffect(() => {
    if (movingId !== null || pendingFocusId === null) return;
    moveBtnRefs.current.get(pendingFocusId)?.focus();
    setPendingFocusId(null);
  }, [movingId, pendingFocusId]);

  // 移動卡片:先 optimistic 更新,PATCH 失敗只把這張卡搬回原欄原位
  async function moveCustomer(id: string, to: StageKey, fromButton = false) {
    const from = findStageOf(id);
    if (!from) return;
    if (from === to) {
      setMoveOpenId(null);
      setMovePick('');
      if (fromButton) focusMoveButton(id);
      return;
    }
    const customer = (board[from] ?? []).find((c) => c.id === id);
    if (!customer) return;
    const cname = customer.companyName || customer.taxId || '(未命名)';
    const fromIndex = (board[from] ?? []).findIndex((c) => c.id === id);
    const rollbackCard = () =>
      setBoard((prev) => {
        const without = (stage: StageKey) => (prev[stage] ?? []).filter((c) => c.id !== id);
        const restored = without(from);
        restored.splice(Math.min(Math.max(fromIndex, 0), restored.length), 0, customer);
        return { ...prev, [to]: without(to), [from]: restored };
      });
    setBoard((prev) => ({
      ...prev,
      [from]: (prev[from] ?? []).filter((c) => c.id !== id),
      [to]: [{ ...customer, stage: to }, ...(prev[to] ?? [])],
    }));
    setMovingId(id);
    if (fromButton) setPendingFocusId(id);
    setMoveOpenId(null);
    setMovePick('');
    setMoveMsg(`移動中:${cname} 移到 ${stageMeta.label(to)}`);
    try {
      const res = await fetch(`${crmApiBase()}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: to }),
      });
      if (!res.ok) {
        rollbackCard();
        // 後端對「看不到 / 不是自己的客戶」一律回 404(不透露客戶存不存在),
        // 403 只有「角色不能用 CRM」才會出現,所以權限訊息掛在 404 上
        setMoveMsg(
          res.status === 404
            ? `移動失敗:找不到 ${cname},可能已被移交或合併,請重新整理`
            : `移動失敗:${cname} 仍在「${stageMeta.label(from)}」,${await apiErrorMessage(res, '請稍後再試')}`,
        );
        return;
      }
      setMoveMsg(`已把 ${cname} 移到 ${stageMeta.label(to)}`);
    } catch {
      rollbackCard();
      setMoveMsg(`移動失敗:${cname} 仍在「${stageMeta.label(from)}」,請稍後再試`);
    } finally {
      setMovingId(null);
    }
  }

  // 原生 HTML5 拖放(桌機用;手機與鍵盤走每張卡片的「移動」按鈕)
  function handleDragStart(e: React.DragEvent, id: string) {
    dragIdRef.current = id;
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  }
  function handleDragEnd() {
    dragIdRef.current = null;
    setDragOverStage(null);
  }
  function handleDragOver(e: React.DragEvent, stage: StageKey) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverStage !== stage) setDragOverStage(stage);
  }
  function handleDragLeave(e: React.DragEvent, stage: StageKey) {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    if (dragOverStage === stage) setDragOverStage(null);
  }
  function handleDrop(e: React.DragEvent, stage: StageKey) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragIdRef.current;
    dragIdRef.current = null;
    setDragOverStage(null);
    if (id) void moveCustomer(id, stage);
  }

  const totalCount = useMemo(
    () => stageMeta.board.reduce((sum, st) => sum + (board[st.key]?.length ?? 0), 0),
    [board, stageMeta],
  );
  const allCustomers = useMemo(
    () => stageMeta.all.flatMap((st) => board[st.key] ?? []),
    [board, stageMeta],
  );

  if (role === null) {
    return <div className="p-6 text-sm text-muted-foreground">載入中…</div>;
  }
  if (!canUse) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">客戶看板</h1>
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
          你的帳號沒有客戶管理的使用權限,請找系統管理員開通。
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">客戶看板</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            客戶名單與跟進看板。
            {viewAll ? '你看得到全部訪查人員的客戶。' : '你看得到自己負責的客戶。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/crm/new" className="btn btn-primary">
            新增客戶
          </Link>
          <button type="button" className="btn" onClick={() => void loadBoard()}>
            重新整理
          </button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm"
          style={{ color: 'var(--color-destructive)' }}
        >
          {error}
        </div>
      ) : null}

      <div className="mt-4">
        <KpiCards customers={allCustomers} weeklyVisits={weeklyVisits} loading={loading} />
        <p className="mt-1 text-xs text-muted-foreground">
          「本週拜訪」算的是你本人本週的拜訪次數,其餘 KPI 是這份看板上的客戶。
        </p>
      </div>

      <div className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {/* 標題不寫死欄數:欄位是後台設定出來的,出廠就有七欄,寫死的數字裝好就是錯的 */}
          <h2 className="text-base font-semibold">客戶階段看板</h2>
          {/* 這個數字就是下面所有欄位的加總,終止階段只要在看板上就一起算。
              原本括號寫「不含無效/放棄」與實際算法不符,而畫面上看不出來 */}
          {/* 被上限切掉時,「共 N 筆」會剛好等於上限,讀起來像「總共就這麼多」。
              那正是最容易誤導的一句,所以截斷時改口說「已載入」並標明只是前 N 筆。 */}
          <span className="text-xs text-muted-foreground">
            {boardLimit?.truncated
              ? `看板已載入 ${totalCount} 筆(上限,不是全部),分 ${stageMeta.board.length} 欄`
              : `看板共 ${totalCount} 筆,分 ${stageMeta.board.length} 欄(下面每一欄的加總)`}
          </span>
          <span className="text-xs text-muted-foreground">
            拖拉卡片或按卡片上的「移動」可換階段;標記成交請到客戶卡操作
          </span>
          <span className="text-xs text-muted-foreground">
            每一欄先顯示 {COLUMN_PAGE_SIZE} 張,超過的按欄位下方的「載入更多」展開
          </span>
        </div>
        {boardLimit?.truncated ? (
          <p role="status" className="mb-2 text-xs font-semibold text-foreground">
            客戶數超過看板一次能載入的上限({boardLimit.take}
            筆),下面顯示的只是其中 {boardLimit.take} 筆,每一欄的數字與上面的 KPI
            也都只算這些。要找特定客戶請用「秒查客戶」,那一支是整份資料庫在查;
            要把名單分給不同人請用「批次轉派」。
          </p>
        ) : null}
        <p
          role="status"
          aria-live="polite"
          className="mb-2 min-h-[1.25rem] text-sm text-foreground"
        >
          {moveMsg}
        </p>
        {/* 「載入更多」的結果自己一區,不跟移動結果搶同一個播報區 */}
        <p
          role="status"
          aria-live="polite"
          className="mb-2 min-h-[1.25rem] text-sm text-foreground"
        >
          {expandMsg}
        </p>
        {/* 一筆都沒有時,七個空欄本身沒告訴人下一步要做什麼。 */}
        {!loading && totalCount === 0 ? (
          <div className="mb-2 rounded-lg border border-border bg-surface p-4 text-sm">
            <p>
              {viewAll
                ? '看板上還沒有任何客戶。先建一家,或請訪查人員把名單匯入進來,看板才會有東西可以拖。'
                : '看板上還沒有你名下的客戶。先建一家,或請主管把名單分派給你,看板才會有東西可以拖。'}
            </p>
            <p className="mt-2">
              <Link href="/admin/crm/new" className="btn btn-primary">
                新增客戶
              </Link>
            </p>
          </div>
        ) : null}
        {loading ? (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm text-muted-foreground">
            載入中…
          </div>
        ) : (
          /* 欄數由後台設定決定(出廠七欄),不能寫死 lg:grid-cols-6 —— 第七欄會掉下去。
             用 auto-fill + 最小寬度:欄多就換行排,欄少就把寬度撐開,兩種都不會擠爆。 */
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))' }}
          >
            {stageMeta.board.map(({ key: stage }) => {
              const items = board[stage] ?? [];
              const isOver = dragOverStage === stage;
              const colors = stageMeta.colors(stage);
              const shown = columnShownCount(items.length, shownPerStage[stage]);
              const hidden = items.length - shown;
              const label = stageMeta.label(stage);
              return (
                // 欄位本身只是拖放落點,語意由標題與卡片內的連結/按鈕承擔
                <div
                  key={stage}
                  role="presentation"
                  className="overflow-hidden rounded-lg border-2"
                  style={{
                    borderColor: colors.fg,
                    backgroundColor: colors.bg,
                    outline: isOver ? `2px solid ${colors.fg}` : undefined,
                    outlineOffset: isOver ? 2 : undefined,
                  }}
                  onDragOver={(e) => handleDragOver(e, stage)}
                  onDragEnter={(e) => handleDragOver(e, stage)}
                  onDragLeave={(e) => handleDragLeave(e, stage)}
                  onDrop={(e) => handleDrop(e, stage)}
                >
                  <div
                    className="flex items-center justify-between gap-1 px-2 py-1.5"
                    style={{ color: colors.fg }}
                  >
                    <span className="text-xs font-bold">
                      {stageMeta.label(stage)}
                      {isOver && <span className="ml-1 font-semibold">放開移到此欄</span>}
                    </span>
                    {/* 這一欄有沒有被收起來要看得出來:收起來時寫「已顯示/全部」,
                        沒收起來就只有一個數字,免得每一欄都掛一組分數看起來很吵 */}
                    <span className="text-xs font-bold">
                      <span aria-hidden="true">
                        {hidden > 0 ? `${shown}/${items.length}` : items.length}
                      </span>
                      <span className="sr-only">
                        {hidden > 0
                          ? `共 ${items.length} 張,已顯示 ${shown} 張`
                          : `共 ${items.length} 張`}
                      </span>
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5 p-2">
                    {items.length === 0 ? (
                      // 「—」對螢幕閱讀器沒有意義(有的會唸成破折號,有的直接跳過),
                      // 所以視覺上留破折號、實際唸出來的是一句話
                      <div className="py-2 text-center text-xs text-muted-foreground">
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">這一欄沒有客戶</span>
                      </div>
                    ) : (
                      items.slice(0, shown).map((c) => {
                        const overdue = isOverdue(c.nextFollowUpAt);
                        const cname = c.companyName || c.taxId || '(未命名)';
                        const isMoving = movingId === c.id;
                        const menuOpen = moveOpenId === c.id;
                        const selectId = `crm-move-${c.id}`;
                        const locked = false;
                        return (
                          <div
                            key={c.id}
                            role="presentation"
                            draggable={!locked && !isMoving}
                            onDragStart={locked ? undefined : (e) => handleDragStart(e, c.id)}
                            onDragEnd={locked ? undefined : handleDragEnd}
                            className="rounded-md border border-border bg-background"
                            style={{
                              cursor: locked ? undefined : isMoving ? 'progress' : 'grab',
                              opacity: isMoving ? 0.6 : undefined,
                            }}
                          >
                            <a
                              href={`/admin/crm/${c.id}`}
                              draggable={false}
                              className="block rounded-t-md p-1.5 text-left hover:bg-muted"
                            >
                              <div className="truncate text-xs font-medium" title={cname}>
                                {cname}
                              </div>
                              <div className="mt-0.5 flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
                                <span className="truncate">{c.owner?.name || '未指派'}</span>
                                {c.nextFollowUpAt ? (
                                  <span className="flex shrink-0 items-center gap-1">
                                    <span
                                      style={
                                        overdue
                                          ? { color: 'var(--color-destructive)', fontWeight: 600 }
                                          : undefined
                                      }
                                    >
                                      {fmtShortDate(c.nextFollowUpAt, timezone)}
                                    </span>
                                    {/* 逾期不能只用紅字表達(1.4.1、1.3.3):顏色以外要有文字,
                                        螢幕閱讀器與色覺障礙的使用者才分得出來。做法與拜訪地圖那份清單同一個 */}
                                    {overdue ? (
                                      <span className="badge badge-danger">逾期</span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </div>
                            </a>
                            {!locked && (
                              <div className="border-t border-border px-1 py-0.5">
                                <button
                                  type="button"
                                  ref={(el) => {
                                    if (el) moveBtnRefs.current.set(c.id, el);
                                    else moveBtnRefs.current.delete(c.id);
                                  }}
                                  className="btn w-full text-xs"
                                  style={{ minHeight: 44 }}
                                  aria-expanded={menuOpen}
                                  aria-controls={menuOpen ? selectId : undefined}
                                  aria-label={`移動 ${cname} 到其他階段`}
                                  // 送出中不用 disabled(焦點會掉到 body,鍵盤使用者跟丟),
                                  // 改 aria-busy 並在 handler 早退 —— 與打卡頁同一條規則
                                  aria-busy={isMoving}
                                  onClick={() => {
                                    if (isMoving) return;
                                    setMovePick('');
                                    setMoveOpenId(menuOpen ? null : c.id);
                                  }}
                                >
                                  {isMoving ? '移動中…' : menuOpen ? '取消移動' : '移動'}
                                </button>
                                {menuOpen && (
                                  <div className="mt-1 flex flex-col gap-1">
                                    <select
                                      id={selectId}
                                      aria-label={`把 ${cname} 移到階段`}
                                      className="w-full rounded-md border border-border bg-background px-2 text-sm"
                                      style={{ minHeight: 44 }}
                                      value={movePick}
                                      onChange={(e) => setMovePick(e.target.value as StageKey | '')}
                                    >
                                      <option value="">請選擇階段</option>
                                      {stageMeta.board
                                        .filter((st) => st.key !== stage)
                                        .map((st) => (
                                          <option key={st.key} value={st.key}>
                                            {st.label}
                                          </option>
                                        ))}
                                    </select>
                                    <button
                                      type="button"
                                      className="btn w-full text-xs"
                                      style={{ minHeight: 44 }}
                                      disabled={!movePick}
                                      aria-busy={isMoving}
                                      aria-label={
                                        movePick
                                          ? `確定把 ${cname} 移到 ${stageMeta.label(movePick)}`
                                          : '確定移動(請先選擇階段)'
                                      }
                                      onClick={() => {
                                        if (isMoving || !movePick) return;
                                        void moveCustomer(c.id, movePick, true);
                                      }}
                                    >
                                      確定
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                    {/* 一次全部展開會讓上千張可拖曳的卡同時進 DOM(見檔頭)。
                        全部展開之後按鈕不移除也不 disabled,改成 aria-disabled:
                        移除或 disable 都會讓剛按完的鍵盤使用者焦點掉到 body。 */}
                    {items.length > COLUMN_PAGE_SIZE ? (
                      <button
                        type="button"
                        className="btn w-full text-xs"
                        style={{ minHeight: 44 }}
                        aria-disabled={hidden === 0}
                        aria-label={
                          hidden === 0
                            ? `「${label}」已顯示全部 ${items.length} 張`
                            : `在「${label}」再顯示 ${Math.min(COLUMN_PAGE_SIZE, hidden)} 張,目前顯示 ${shown} 張,共 ${items.length} 張`
                        }
                        onClick={() => {
                          if (hidden === 0) return;
                          const next = Math.min(items.length, shown + COLUMN_PAGE_SIZE);
                          setShownPerStage((prev) => ({ ...prev, [stage]: next }));
                          setExpandMsg(
                            `「${label}」已顯示 ${next} 張,共 ${items.length} 張` +
                              (next >= items.length ? ',已全部顯示' : ''),
                          );
                        }}
                      >
                        {hidden === 0 ? '已全部顯示' : `載入更多(還有 ${hidden} 張)`}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="mt-6 text-sm">
        <Link href="/admin/crm/home" className="underline underline-offset-2">
          回我的首頁
        </Link>
      </p>
    </div>
  );
}
