/**
 * 客戶查重與合併。
 * 判定規則:識別碼相同(去空白)/ 電話正規化後相同(至少 8 碼才比,含國碼處理)/
 * 公司名正規化(全形轉半形、去空白、去各國法人格後綴、小寫)後相同。
 * 三個比對鍵的實作都在 duplicate-keys.ts,那裡寫了為什麼要處理國碼與國際後綴。
 * 已合併(mergedIntoId 不為 null)、已刪除(deletedAt 不為 null)與 stage=dropped 的不進群組;
 * 合併本身也會在鎖內再確認兩筆都不在回收桶裡(候選清單是幾秒前撈的,不能當作當下的事實)。
 * 合併在同一個交易內完成:互動搬到保留那筆、空欄位補值、階段取較前進者、
 * 被合併者標記 dropped + mergedIntoId,並在保留者時間軸留一筆紀錄。
 * 存取範圍與 CrmService 相同:業務只看自己的(ownerId),主管/admin 看全部。
 */
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { canSeeOwner, ownerFilter, type ViewScope } from '../../scope/view-scope';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgTimeService } from '../../settings/org-time.service';
import { callingCodeForLocale } from './calling-codes';
import {
  normalizeCompanyName,
  normalizePhone,
  normalizeTaxId,
  phoneDuplicateKey,
} from './duplicate-keys';
import { CUSTOMER_NOT_FOUND_MESSAGE, INTERACTIONS_TAKE } from '../crm-messages';
import { countableCustomerWhere } from '../crm-scope-filters';
// 合併會把兩筆客戶的照片疊在一起,可能超過「每位客戶 40 張 / 20MB」的配額。
// 判斷與說明文字跟打卡端點吃同一份(checkin/checkin-rules.ts),不在這裡另抄一份門檻。
import { customerPhotoOverQuotaNotice } from '../checkin/checkin-rules';
import { SettingsService } from '../../settings/settings.service';
import { LOOKUP_DEFAULT_LABEL } from '../../app-settings/app-settings.view';
import {
  DEFAULT_STAGE_CATALOG,
  LOST_STAGE_KEY,
  StageCatalogService,
  WON_STAGE_KEY,
} from '../../app-settings/stage-catalog.service';

/**
 * 命中理由的顯示文字。
 *
 * 電話與公司名是固定的字,識別碼那一個不是:那一格在各地叫什麼由後台設定
 * (lookupLabel)決定,所以這裡不能寫死成聯集型別裡的一個字串常值。
 * 讀不到設定時退回通用說法,畫面不會空白。
 */
export type DuplicateReason = string;

/**
 * 比對鍵的實作搬到 duplicate-keys.ts(純函式,與 Nest 無關),這裡原樣再匯出一次:
 * 既有的測試與呼叫端都是從這個服務檔匯入的,搬家不該連帶改掉每一個匯入點。
 */
export {
  normalizeCompanyName,
  normalizePhone,
  normalizeTaxId,
  phoneDuplicateKey,
} from './duplicate-keys';

export const PHONE_DUPLICATE_REASON = '電話相同';
export const COMPANY_NAME_DUPLICATE_REASON = '公司名相似';

export interface DuplicateCustomerSummary {
  id: string;
  taxId: string | null;
  companyName: string;
  contactName: string | null;
  contactPhone: string | null;
  stage: string;
  ownerName: string;
  interactionCount: number;
  createdAt: Date;
}

export interface DuplicateGroup {
  key: string;
  reason: DuplicateReason;
  customers: DuplicateCustomerSummary[];
}

export interface DuplicateMatch {
  id: string;
  companyName: string;
  taxId: string | null;
  contactPhone: string | null;
  stage: string;
  ownerName: string;
  reason: DuplicateReason;
}

/**
 * 階段前進順序的保底值(合併時取較前進者;成交另外處理,終止階段不參與比較)。
 *
 * 執行期一律以 dev_stages 的排序為準(見 StageCatalogService.rankByKey)——
 * 寫死名次的話,後台新增的階段名次是「查無」,合併時永遠被判定成比較不前進,
 * 客戶會被安靜地退回舊階段。這份只在沒有目錄服務(單元測試)時用。
 */
const FALLBACK_STAGE_RANK: Record<string, number> = Object.fromEntries(
  DEFAULT_STAGE_CATALOG.filter((s) => !s.isTerminal).map((s, i) => [s.key, i]),
);

const CHECK_LIMIT = 5;

/**
 * 「沒填名稱」的佔位字串正規化之後的樣子。
 *
 * 建檔與匯入在公司名空白時會寫入 `(未命名)`,那不是名字。不排除的話,
 * 一個組織裡所有沒填名稱的客戶會被湊成同一個「公司名相似」的大群組,
 * 而那一群裡沒有任何兩筆是真的重複。
 */
const UNNAMED_NAME_KEYS = new Set(['(未命名)', '未命名'].map((v) => normalizeCompanyName(v)));

/**
 * 一次查重最多讀幾筆客戶。
 *
 * 查重是把可見範圍內的客戶整批讀進記憶體再分組,沒有上限的話,一位普通業務
 * 只要匯入夠多筆(匯入本身有 1000 筆的上限,但可以重複匯),就能讓這一支
 * 佔住整個 event loop —— Node 是單執行緒,那段時間連健康檢查都不會被回應,
 * 容器會被判定為不健康而重啟。所以這裡寧可回一句「請縮小範圍」。
 *
 * 同專案其他清單也都有上限(地圖 2000、日報 2000、排程 1000);
 * 查重要跨全部客戶比對,所以放寬到一萬,但不是沒有。
 */
export const DUPLICATE_SCAN_LIMIT = 10_000;
/**
 * 超過上限時回的那句話。
 *
 * 這句話一定要跟畫面上真的做得到的操作對得起來。原本它寫「請用查詢條件縮小範圍」,
 * 而端點一個 query 參數都不收、查重頁也沒有任何篩選器 —— 五萬筆的部署每次打開查重
 * 都拿到這一句,而照著做的路徑並不存在。現在負責人與階段兩個篩選器是真的,
 * 訊息就照著它們寫。
 */
export const DUPLICATE_TOO_MANY_MESSAGE =
  `可查重的客戶超過 ${DUPLICATE_SCAN_LIMIT} 筆,一次比對不完。` +
  '請用畫面上的負責人或階段篩選縮小範圍再查一次;已經篩過還是太多的話,兩個條件一起用';

/**
 * 合併之後客戶要停在哪一階(純函式,方便測試)。
 *
 * 規則:任一邊已成交就是成交(並保留外部案件編號);否則取「較前進」的那一階,
 * 名次由 dev_stages 的排序決定,不是寫死的代碼。
 *
 * 「永遠取保留那筆的階段」是很容易寫出來的簡化,而且不會有任何錯誤訊息:
 * 把一筆停在名單的客戶合併掉一筆已經談到有意願的,結果整段進度安靜地退回名單,
 * 業務只會覺得「我明明談過了」。所以這一條由測試釘住。
 */
export function mergedStage(
  keep: { stage: string; externalCaseRef: string | null },
  gone: { stage: string; externalCaseRef: string | null },
  rank: ReadonlyMap<string, number>,
): { stage: string; externalCaseRef?: string | null } {
  if (keep.stage === WON_STAGE_KEY || gone.stage === WON_STAGE_KEY) {
    return {
      stage: WON_STAGE_KEY,
      externalCaseRef: keep.externalCaseRef ?? gone.externalCaseRef ?? null,
    };
  }
  const rk = rank.get(keep.stage) ?? -1;
  const rg = rank.get(gone.stage) ?? -1;
  return { stage: rg > rk ? gone.stage : keep.stage };
}

/*
 * 候選客戶要讀的欄位。
 *
 * 這裡**刻意沒有** `_count: { select: { interactions: true } }`。Prisma 會把那一格
 * 展開成逐列的相關子查詢,而查重是一次讀上限那麼多列 —— 一萬列實測 262MB 的
 * buffer 流量,而其中絕大多數列根本不會落進任何一個重複群組,那些次數算了沒人看。
 * 互動筆數改成分組之後才算:成員 id 湊齊,再用一句 groupBy 一次問完(見 countInteractions)。
 */
const summarySelect = {
  id: true,
  taxId: true,
  companyName: true,
  contactName: true,
  contactPhone: true,
  stage: true,
  createdAt: true,
  owner: { select: { name: true } },
} satisfies Prisma.DevCustomerSelect;

type SummaryRow = Prisma.DevCustomerGetPayload<{ select: typeof summarySelect }>;

/**
 * 查重的篩選條件。
 *
 * 這一組存在的理由不是「多一個方便」:掃描上限是硬的(見 DUPLICATE_SCAN_LIMIT),
 * 而沒有篩選條件的端點在超過上限時只能回一句「請縮小範圍」,卻沒有任何一個
 * 可以縮小範圍的參數 —— 那等於叫使用者做一件做不到的事,功能在那個規模上等於不存在。
 */
export interface DuplicateScanFilter {
  /** 只看這一位負責人的客戶。不在呼叫者可見範圍內時回空清單(與查不到同一種結果) */
  ownerId?: string;
  /** 只看這一個階段(dev_stages.key) */
  stage?: string;
}

@Injectable()
export class CrmDuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly stageCatalog?: StageCatalogService,
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /**
   * 電話比對要用的預設國際冠碼,由系統設定的「地區與語言」推出來
   * (de-DE → 49、zh-TW → 886),見 callingCodeForLocale。
   *
   * 為什麼不是獨立的一格設定:組織所在地只該填一次。多開一格「預設國碼」
   * 就會有人只填其中一格,兩邊不一致的時候沒有任何畫面看得出來。
   * 讀不到設定(或設定的地區沒有地區子標籤)就回 undefined,
   * 電話比對退回純數字比對,也就是這個功能存在之前的行為。
   */
  private async defaultCallingCode(): Promise<string | undefined> {
    if (!this.orgTime) return undefined;
    try {
      return callingCodeForLocale(await this.orgTime.locale());
    } catch {
      return undefined;
    }
  }

  /** 目前的階段前進名次;沒有目錄服務(單元測試)就用出廠順序 */
  private async stageRank(): Promise<Map<string, number>> {
    if (!this.stageCatalog) return new Map(Object.entries(FALLBACK_STAGE_RANK));
    return this.stageCatalog.rankByKey();
  }

  /** 識別碼命中的理由文字。後台改了欄位名稱,查重畫面上的字跟著換 */
  private async taxIdDuplicateReason(): Promise<string> {
    let label = LOOKUP_DEFAULT_LABEL;
    try {
      const s = await this.settings?.get();
      const configured = (s?.lookupLabel ?? '').trim();
      if (configured) label = configured;
    } catch {
      // 讀不到設定不該讓查重整支掛掉,用預設說法就好
    }
    return `${label}相同`;
  }

  private toSummary(r: SummaryRow, interactionCount: number): DuplicateCustomerSummary {
    return {
      id: r.id,
      taxId: r.taxId,
      companyName: r.companyName,
      contactName: r.contactName,
      contactPhone: r.contactPhone,
      stage: r.stage,
      ownerName: r.owner?.name ?? '—',
      interactionCount,
      createdAt: r.createdAt,
    };
  }

  /**
   * 這幾位客戶各有幾筆互動。一句 groupBy 問完,不是逐列一個子查詢。
   *
   * 只問「真的落進某個重複群組」的那些人:候選有一萬筆,而重複群組的成員
   * 通常是其中的百分之幾。查不到就當 0 ——「互動筆數顯示成 0」不該讓整個查重掛掉,
   * 那一格是給人挑保留哪一筆的參考,不是判定條件。
   */
  private async countInteractions(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    try {
      const rows = await this.prisma.devInteraction.groupBy({
        by: ['customerId'],
        where: { customerId: { in: [...ids] } },
        _count: { _all: true },
      });
      for (const r of rows) out.set(r.customerId, r._count._all);
    } catch {
      // 互動筆數算不出來時整批當 0,不要把查重整支拖掛
    }
    return out;
  }

  /**
   * 負責人條件。沒有指定就是呼叫者本來的可見範圍;指定了就收斂到那一個人。
   *
   * 不能寫成 `{ ...ownerFilter(view), ownerId: 要求的那個人 }` —— 兩個鍵同名,
   * 後面那個會把可見範圍整個蓋掉,一位業務只要在網址上填別人的 id 就看得到別人的客戶,
   * 而畫面與測試都不會有任何異狀。所以這裡先問 canSeeOwner,不在範圍內就回 null,
   * 由呼叫端當成「查不到」處理。
   */
  private ownerScopeWhere(view: ViewScope, ownerId?: string): Prisma.DevCustomerWhereInput | null {
    const wanted = (ownerId ?? '').trim();
    if (!wanted) return ownerFilter(view) as Prisma.DevCustomerWhereInput;
    if (!canSeeOwner(view, wanted)) return null;
    return { ownerId: wanted };
  }

  /**
   * 呼叫者可見、未被合併、未放棄的客戶。
   *
   * 一律帶 take:多讀一筆用來判斷「還有沒有更多」,由呼叫端決定要擋下來
   * 還是照著這一批做。沒有上限的查詢在這一支特別危險,理由見 DUPLICATE_SCAN_LIMIT。
   */
  private async visibleCandidates(
    view: ViewScope,
    includeDropped: boolean,
    filter: DuplicateScanFilter = {},
  ): Promise<{ rows: SummaryRow[]; truncated: boolean }> {
    const owner = this.ownerScopeWhere(view, filter.ownerId);
    // 指定的負責人不在可見範圍內:回空清單,與「這個人名下沒有客戶」是同一種結果。
    // 不回 403 也不回 404 —— 兩者的差別本身就會透露「這個 id 存在」
    if (owner === null) return { rows: [], truncated: false };
    const where: Prisma.DevCustomerWhereInput = {
      // 已刪除的客戶不能進查重候選:不然刪掉的那一批會一直被配成「重複」,
      // 使用者每次打開查重都看到自己已經清掉的資料,而且還按得下去合併
      ...countableCustomerWhere(),
      ...owner,
    };
    // LOST_STAGE_KEY 是產品保留字(見 @mitchcrm/shared 的 dev-vocab):放棄有自己的流程語意,不是一般階段
    const stage = (filter.stage ?? '').trim();
    if (stage) {
      // 指定的就是放棄那一階,而這一支又不收放棄:條件互斥,直接回空清單。
      // 交給 SQL 去查一個必定為空的條件也可以,但那會多一次沒有意義的全表往返
      if (!includeDropped && stage === LOST_STAGE_KEY) return { rows: [], truncated: false };
      where.stage = stage;
    } else if (!includeDropped) {
      where.stage = { not: LOST_STAGE_KEY };
    }
    const rows = await this.prisma.devCustomer.findMany({
      where,
      select: summarySelect,
      orderBy: { createdAt: 'asc' },
      take: DUPLICATE_SCAN_LIMIT + 1,
    });
    if (rows.length > DUPLICATE_SCAN_LIMIT) {
      return { rows: rows.slice(0, DUPLICATE_SCAN_LIMIT), truncated: true };
    }
    return { rows, truncated: false };
  }

  /**
   * 疑似重複群組。同一組成員已出現在前面(識別碼優先)的群組時不再重複列出。
   *
   * 「已出現過」的判斷不能拿新群組去掃過所有已產生的群組:那是 O(群組數²),
   * 而群組數等於客戶數量級。實測:一萬組 0.8 秒、兩萬組 3.1 秒、五萬組 25 秒,
   * 那二十五秒裡 Node 什麼請求都不處理。
   * 改成「客戶 → 他出現過的群組編號」的索引之後,每一組只查自己的成員,
   * 而一位客戶最多只會落在三個群組裡(識別碼、電話、公司名各一),所以是常數時間。
   */
  async groups(
    userId: string,
    view: ViewScope,
    filter: DuplicateScanFilter = {},
  ): Promise<{ groups: DuplicateGroup[]; scanned: number; scanLimit: number }> {
    const { rows, truncated } = await this.visibleCandidates(view, false, filter);
    if (truncated) throw new BadRequestException(DUPLICATE_TOO_MANY_MESSAGE);
    const callingCode = await this.defaultCallingCode();
    const byTax = new Map<string, SummaryRow[]>();
    const byPhone = new Map<string, SummaryRow[]>();
    const byName = new Map<string, SummaryRow[]>();
    const push = (m: Map<string, SummaryRow[]>, k: string, r: SummaryRow) => {
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    };
    for (const r of rows) {
      const tax = normalizeTaxId(r.taxId);
      if (tax) push(byTax, tax, r);
      const phone = phoneDuplicateKey(r.contactPhone, callingCode);
      if (phone) push(byPhone, phone, r);
      const name = normalizeCompanyName(r.companyName);
      // 佔位字串本身不是名字:沒填名稱的客戶不該互相湊成一群。
      // 比的是正規化之後的值,正規化規則改了這裡不會失效
      if (name && !UNNAMED_NAME_KEYS.has(name)) push(byName, name, r);
    }

    const groups: DuplicateGroup[] = [];
    /** 客戶 id → 他已經出現在哪幾個群組(群組編號)。一位客戶最多三個,所以查詢是常數時間 */
    const emittedIndexes = new Map<string, number[]>();
    /** 群組編號 → 成員數。先比大小可以在成員數不夠時直接排除,不必逐一比對 */
    const emittedSize: number[] = [];
    const isCovered = (ids: string[]) => {
      const first = ids[0];
      if (first === undefined) return false;
      for (const g of emittedIndexes.get(first) ?? []) {
        if ((emittedSize[g] ?? 0) < ids.length) continue;
        if (ids.every((id) => (emittedIndexes.get(id) ?? []).includes(g))) return true;
      }
      return false;
    };
    const markEmitted = (ids: string[]) => {
      const g = emittedSize.length;
      emittedSize.push(ids.length);
      for (const id of ids) {
        const list = emittedIndexes.get(id);
        if (list) list.push(g);
        else emittedIndexes.set(id, [g]);
      }
    };
    /** 群組成員(還沒填互動筆數),等全部群組成形後再一次把筆數補上 */
    const pending: Array<{ key: string; reason: DuplicateReason; members: SummaryRow[] }> = [];
    const collect = (m: Map<string, SummaryRow[]>, prefix: string, reason: DuplicateReason) => {
      for (const [k, members] of m) {
        if (members.length < 2) continue;
        const ids = members.map((x) => x.id);
        if (isCovered(ids)) continue;
        markEmitted(ids);
        pending.push({ key: `${prefix}:${k}`, reason, members });
      }
    };
    collect(byTax, 'tax', await this.taxIdDuplicateReason());
    collect(byPhone, 'phone', PHONE_DUPLICATE_REASON);
    collect(byName, 'name', COMPANY_NAME_DUPLICATE_REASON);

    // 互動筆數只問真的進了群組的那些人,一句 groupBy 問完(理由見 summarySelect 的說明)
    const memberIds = [...new Set(pending.flatMap((g) => g.members.map((m) => m.id)))];
    const counts = await this.countInteractions(memberIds);
    for (const g of pending) {
      groups.push({
        key: g.key,
        reason: g.reason,
        customers: g.members.map((x) => this.toSummary(x, counts.get(x.id) ?? 0)),
      });
    }
    // scanned / scanLimit 一起回:畫面要說得出「這一次比對了幾筆、上限是多少」。
    // 少了這兩個數字,使用者分不出「真的沒有重複」與「範圍太小所以沒比到」
    return { groups, scanned: rows.length, scanLimit: DUPLICATE_SCAN_LIMIT };
  }

  /** 建檔即時查重:依識別碼、電話、公司名找已存在的客戶,最多 5 筆(識別碼優先)。 */
  async check(
    userId: string,
    view: ViewScope,
    q: { taxId?: string; phone?: string; companyName?: string },
  ): Promise<{ matches: DuplicateMatch[] }> {
    const tax = normalizeTaxId(q.taxId);
    const callingCode = await this.defaultCallingCode();
    const phone = phoneDuplicateKey(q.phone, callingCode);
    const name = normalizeCompanyName(q.companyName);
    if (!tax && !phone && !name) return { matches: [] };

    // 查重時放棄中的客戶也要列出,避免同一家被重複建檔;已合併的不列。
    // 這一支是建檔當下的輔助提示(最多回 5 筆),資料量超過上限時只比對讀到的那一批
    // 就好 —— 建檔本身不該因為「客戶太多」而整個做不下去。
    const { rows } = await this.visibleCandidates(view, true);
    const matches: DuplicateMatch[] = [];
    const seen = new Set<string>();
    const add = (r: SummaryRow, reason: DuplicateReason) => {
      if (seen.has(r.id) || matches.length >= CHECK_LIMIT) return;
      seen.add(r.id);
      matches.push({
        id: r.id,
        companyName: r.companyName,
        taxId: r.taxId,
        contactPhone: r.contactPhone,
        stage: r.stage,
        ownerName: r.owner?.name ?? '—',
        reason,
      });
    };
    if (tax) {
      const taxReason = await this.taxIdDuplicateReason();
      for (const r of rows) if (normalizeTaxId(r.taxId) === tax) add(r, taxReason);
    }
    if (phone) {
      for (const r of rows)
        if (phoneDuplicateKey(r.contactPhone, callingCode) === phone)
          add(r, PHONE_DUPLICATE_REASON);
    }
    if (name) {
      for (const r of rows)
        if (normalizeCompanyName(r.companyName) === name) add(r, COMPANY_NAME_DUPLICATE_REASON);
    }
    return { matches };
  }

  /** 合併:mergeId 併入 keepId。兩筆都要在呼叫者可見範圍。交易衝突(P2034)重試一次。 */
  async merge(keepId: string, mergeId: string, userId: string, view: ViewScope) {
    if (keepId === mergeId) throw new BadRequestException('保留與併入的客戶不能是同一筆');
    try {
      return await this.mergeOnce(keepId, mergeId, userId, view);
    } catch (e) {
      // 同一組客戶被兩個請求同時合併時,Postgres 可能以序列化失敗 / 死鎖回報(Prisma 包成 P2034);
      // 重跑一次會重新取鎖並重讀,後到的那一個會被「已經合併過」擋下
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
        return this.mergeOnce(keepId, mergeId, userId, view);
      }
      throw e;
    }
  }

  private async mergeOnce(keepId: string, mergeId: string, userId: string, view: ViewScope) {
    // 階段名次先在交易外查:交易裡再查會把查詢時間算進兩筆客戶列鎖的持有時間
    const rank = await this.stageRank();
    return this.prisma.$transaction(async (tx) => {
      // 先把兩筆鎖住(依 id 排序取鎖,避免兩個合併請求反向互等造成死鎖),鎖到後再重讀檢查,
      // 這樣同時對同一組客戶按兩次合併、或 A 併 B 同時 B 併 A,後到的會看到前一筆的結果而被擋。
      await tx.$queryRaw`SELECT id FROM dev_customers WHERE id IN (${keepId}::uuid, ${mergeId}::uuid) ORDER BY id FOR UPDATE`;
      const both = await tx.devCustomer.findMany({ where: { id: { in: [keepId, mergeId] } } });
      const keep = both.find((c) => c.id === keepId);
      const gone = both.find((c) => c.id === mergeId);
      if (!keep || !gone) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
      if (!canSeeOwner(view, keep.ownerId) || !canSeeOwner(view, gone.ownerId)) {
        throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
      }
      if (keep.mergedIntoId || gone.mergedIntoId) {
        throw new BadRequestException('其中一筆已經合併過,不能再合併');
      }
      // 回收桶裡的那一筆不能參與合併,兩個方向都要擋。
      //
      // 這一支是唯一「不經 where 過濾、直接吃兩個 id 寫入」的端點:查重候選有
      // countableCustomerWhere 擋著,但候選是幾秒前撈的,按下合併的當下另一個分頁
      // 可能已經把其中一筆刪進回收桶。漏掉這一段的後果不是查詢多幾筆,而是
      //   保留筆在回收桶:被併掉那筆的互動與存證照片會被搬進一筆看不見的客戶,
      //     接著它自己也被標成 dropped + mergedIntoId,兩筆連同照片一起從所有畫面消失,
      //     而回應是 200,畫面上沒有任何線索;
      //   被併筆在回收桶:等於把已經刪掉的資料倒回還活著的那筆。
      // 合併不可逆,所以這裡寧可擋下來並說清楚要先做什麼。
      if (keep.deletedAt || gone.deletedAt) {
        const which =
          keep.deletedAt && gone.deletedAt
            ? '這兩筆客戶都'
            : keep.deletedAt
              ? `要保留的「${keep.companyName}」`
              : `要併入的「${gone.companyName}」`;
        throw new BadRequestException(
          `${which}在回收桶裡,不能合併。請先到回收桶還原,或改選其他客戶再合併`,
        );
      }
      if (keep.stage === LOST_STAGE_KEY || gone.stage === LOST_STAGE_KEY) {
        throw new BadRequestException('已放棄的客戶不能合併,請先把階段改回再試');
      }

      // 1. 互動全部搬到保留那筆
      const moved = await tx.devInteraction.updateMany({
        where: { customerId: mergeId },
        data: { customerId: keepId },
      });
      // 存證照片一起搬(結案前檢查是看 customerId,不是看互動)
      await tx.devVisitPhoto.updateMany({
        where: { customerId: mergeId },
        data: { customerId: keepId },
      });
      /*
       * 合併刻意不看每位客戶 40 張 / 20MB 的照片配額。
       *
       * 合併的用途是修正重複建檔,如果因為「併起來會超過上限」就擋下來,重複的兩筆
       * 客戶永遠併不回去,資料修不乾淨 —— 那比超額本身嚴重。所以這裡照搬,
       * 允許保留筆處在超額狀態,代價是那一筆之後的補拍會被擋。
       *
       * 代價要看得見,不能安靜地發生:超額時在保留筆的時間軸上直接寫一句,
       * 客戶卡的存證照片區也會顯示同一件事(listPhotos 回的 quota),
       * 而補拍被擋時的訊息會說出真正的原因是合併而不是「你拍太多」
       * (見 checkin/checkin-rules.ts 的 customerPhotoQuotaError)。
       */
      const [photoCount, photoAgg] = await Promise.all([
        tx.devVisitPhoto.count({ where: { customerId: keepId } }),
        tx.devVisitPhoto.aggregate({ where: { customerId: keepId }, _sum: { sizeBytes: true } }),
      ]);
      const photoOverNotice = customerPhotoOverQuotaNotice({
        count: photoCount,
        bytes: photoAgg._sum.sizeBytes ?? 0,
      });

      // 2. 保留者的空欄位用被合併者的值補
      const fill = (a: string | null, b: string | null) => (a && a.trim().length ? a : b);
      const data: Prisma.DevCustomerUpdateInput = {
        taxId: fill(keep.taxId, gone.taxId),
        representative: fill(keep.representative, gone.representative),
        registeredAddress: fill(keep.registeredAddress, gone.registeredAddress),
        actualAddress: fill(keep.actualAddress, gone.actualAddress),
        contactAddress: fill(keep.contactAddress, gone.contactAddress),
        website: fill(keep.website, gone.website),
        social: fill(keep.social, gone.social),
        category: fill(keep.category, gone.category),
        contactName: fill(keep.contactName, gone.contactName),
        contactPhone: fill(keep.contactPhone, gone.contactPhone),
        premisesType: keep.premisesType ?? gone.premisesType ?? null,
      };
      const keepNote = (keep.note ?? '').trim();
      const goneNote = (gone.note ?? '').trim();
      if (goneNote && goneNote !== keepNote)
        data.note = keepNote ? `${keepNote}\n${goneNote}` : goneNote;

      // 3. 階段取較前進者;任一為 converted 就 converted 並帶外部案件編號
      let goneCaseRefMovedToKeep = false;
      const merged = mergedStage(
        { stage: keep.stage, externalCaseRef: keep.externalCaseRef },
        { stage: gone.stage, externalCaseRef: gone.externalCaseRef },
        rank,
      );
      data.stage = merged.stage;
      if (merged.externalCaseRef !== undefined) data.externalCaseRef = merged.externalCaseRef;
      /*
       * 案件編號抄給保留筆之後,被併掉那一筆自己那一格要清掉。
       *
       * 被併掉的那一筆留在資料表裡(稽核要看得到)而且 **deleted_at 是 null** ——
       * 它是「已合併」不是「已刪除」。所以不清的話,合併完成的那一刻起就有兩列
       * 活著的客戶掛同一個外部案件編號,對帳時分不出是哪一位,而且
       * external_case_ref 上那條 `WHERE deleted_at IS NULL` 的唯一索引建不起來。
       *
       * 只在「真的抄過去了」時才清:值不一樣的情況(保留筆本來就有自己的編號)
       * 清掉等於平白丟掉一筆資料。
       */
      if (
        merged.externalCaseRef !== undefined &&
        merged.externalCaseRef !== null &&
        gone.externalCaseRef === merged.externalCaseRef
      ) {
        goneCaseRefMovedToKeep = true;
      }

      // 4. 下次跟進取較早、最近接觸取較晚
      const earlier = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));
      const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
      data.nextFollowUpAt = earlier(keep.nextFollowUpAt, gone.nextFollowUpAt);
      data.lastContactAt = later(keep.lastContactAt, gone.lastContactAt);

      await tx.devCustomer.update({ where: { id: keepId }, data });

      // 5. 被合併者標記
      await tx.devCustomer.update({
        where: { id: mergeId },
        data: {
          stage: LOST_STAGE_KEY,
          mergedIntoId: keepId,
          // 抄走了就清掉這一格,理由見上面第 3 步的說明
          ...(goneCaseRefMovedToKeep ? { externalCaseRef: null } : {}),
          note: `【已合併】併入 ${keep.companyName}${goneNote ? `\n${goneNote}` : ''}`,
        },
      });

      // 5c. 拜訪排程:還會用到的(planned / missed)搬到保留筆,負責人跟著保留筆走;
      // 保留筆同一天已經有排程時不能硬搬(@@unique(customerId, plannedDate)),改標 cancelled。
      // 已 done 的留在原處:它掛著當時打卡的 interactionId,是歷史紀錄,不改動。
      const gonePlans = await tx.devVisitPlan.findMany({
        where: { customerId: mergeId, status: { in: ['planned', 'missed'] } },
        select: { id: true, plannedDate: true },
      });
      if (gonePlans.length) {
        const keepPlans = await tx.devVisitPlan.findMany({
          where: { customerId: keepId, plannedDate: { in: gonePlans.map((p) => p.plannedDate) } },
          select: { plannedDate: true },
        });
        const taken = new Set(keepPlans.map((p) => p.plannedDate.getTime()));
        const movable = gonePlans
          .filter((p) => !taken.has(p.plannedDate.getTime()))
          .map((p) => p.id);
        const clash = gonePlans.filter((p) => taken.has(p.plannedDate.getTime())).map((p) => p.id);
        if (movable.length) {
          await tx.devVisitPlan.updateMany({
            where: { id: { in: movable } },
            data: { customerId: keepId, ownerId: keep.ownerId },
          });
        }
        if (clash.length) {
          await tx.devVisitPlan.updateMany({
            where: { id: { in: clash } },
            data: { status: 'cancelled' },
          });
        }
      }

      // 5b. 之前併進 mergeId 的那些筆改指向 keepId,避免鏈狀(C→B→A)讓 get() 導到一筆已合併的
      await tx.devCustomer.updateMany({
        where: { mergedIntoId: mergeId },
        data: { mergedIntoId: keepId },
      });

      // 6. 保留者時間軸留紀錄
      await tx.devInteraction.create({
        data: {
          customerId: keepId,
          userId,
          channel: 'note',
          note:
            `【合併】自 ${gone.companyName}(${gone.id}) 合併,移入 ${moved.count} 筆互動` +
            (photoOverNotice ? `\n【存證照片超額】${photoOverNotice}` : ''),
          occurredAt: new Date(),
        },
      });

      return tx.devCustomer.findUniqueOrThrow({
        where: { id: keepId },
        include: {
          owner: { select: { id: true, name: true } },
          interactions: {
            orderBy: { occurredAt: 'desc' },
            // 合併後兩邊的互動會疊在同一筆客戶上,回應只帶最近 50 筆(與客戶卡 get() 同一個上限)
            take: INTERACTIONS_TAKE,
            include: { user: { select: { name: true } } },
          },
        },
      });
    });
  }
}
