// ref:3687 mc/陳彥輔/米球®
/**
 * 客戶刪除 / 回收桶 / 還原 / 永久刪除。
 *
 * 規則本體(什麼情況擋、為什麼是軟刪除)在 crm-deletion-rules.ts 的檔頭,
 * 這一支只負責「照規則對資料庫做事」與「留下稽核紀錄」。
 *
 * 可見範圍一律吃 ViewScope(見 ../../scope/view-scope.ts):
 *   刪除     CRM 角色,而且客戶要在自己的可見範圍內(業務只能刪自己的)
 *   強制刪除 只有系統管理員(有互動紀錄、有照片、已成交的那些)
 *   回收桶   訪查主管與系統管理員,看得到的一樣照 ViewScope 限縮
 *   還原     訪查主管與系統管理員
 *   永久刪除 只有系統管理員
 *   整批那三支(列出匯入批次 / 整批刪除 / 整批還原)一律訪查主管與系統管理員
 *
 * 為什麼整批刪除跟單筆刪除的門檻不一樣:單筆刪除是訪查人員自己收回自己剛建錯的一筆,
 * 而「還原要找主管」是刻意的分界(見 assertTrashRole)。整批那一條原本是 CRM 角色都能按,
 * 於是訪查人員一個動作可以把兩千筆推進一個他自己看不到(回收桶 403)、
 * 也還不回來(還原 403)的地方 —— 手滑之後完全沒有自救路徑,而入口是開著的
 * (匯入批次清單當時回 200)。刪與還原兩端的門檻對齊之後,按得下去的人就救得回來。
 *
 * 每一次刪除 / 整批刪除 / 還原 / 永久刪除都寫一筆 audit_logs,
 * metadata 帶客戶 id、公司名、原因、是否強制、以及當時的互動與照片數量。
 * 不寫這些的話,回收桶被清空之後就沒有任何地方交代「那批資料去哪了」。
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isCaseRefUniqueViolation } from '../case-ref-conflict';
import { WON_STAGE_KEY } from '../../app-settings/stage-catalog.service';
import { canSeeOwner, ownerFilter, type ViewScope } from '../../scope/view-scope';
import { humanInteractionWhere } from '../crm-scope-filters';
import { lockCustomerRow, lockCustomerRows, lockCustomerAndMergedSources } from '../lock';
import { auditContextColumns, type AuditContext } from '../../common/audit-context';
import { isCrmManagerRole } from '../crm-roles';
import {
  BATCH_DELETE_MAX,
  CASE_REF_TAKEN_MESSAGE,
  CUSTOMER_NOTE_MAX,
  DELETE_AUDIT_ACTIONS,
  DELETE_REASON_MAX,
  FORCE_REQUIRES_ADMIN_MESSAGE,
  PURGE_FORBIDDEN_MESSAGE,
  restoreCaseRefDuplicateInBatchMessage,
  restoreCaseRefTakenMessage,
  restoreStageInactiveMessage,
  restoreStageMissingMessage,
  TRASH_FORBIDDEN_MESSAGE,
  IMPORT_BATCH_LIST_TAKE,
  purgedSurvivorNote,
  TRASH_LIST_TAKE,
  UNLINK_NOTE_MAX,
  TRASH_NOT_FOUND_MESSAGE,
  deleteBlockOf,
  type DeletableCustomerFacts,
  type DeleteBlock,
} from './crm-deletion-rules';
import { CUSTOMER_NOT_FOUND_MESSAGE } from '../crm-messages';

/** 回收桶一列 */
export interface TrashRow {
  id: string;
  companyName: string;
  taxId: string | null;
  stage: string;
  ownerId: string;
  ownerName: string | null;
  deletedAt: Date | null;
  deletedById: string | null;
  deletedByName: string | null;
  deleteReason: string | null;
  importBatchId: string | null;
  interactions: number;
  photos: number;
}

/** 最近一次匯入的一批 */
export interface ImportBatchRow {
  importBatchId: string;
  count: number;
  firstCreatedAt: Date | null;
}

/** 單筆刪除的結果 */
export interface DeleteResult {
  ok: true;
  id: string;
  /** 被擋下來但管理員強制通過 */
  forced: boolean;
}

/** 整批刪除的結果:刪了幾筆、擋下幾筆、為什麼 */
export interface BatchDeleteResult {
  importBatchId: string;
  /** 這一批裡呼叫者看得到、而且還沒被刪的筆數 */
  matched: number;
  deleted: number;
  /** 被擋下來的(有紀錄 / 已成交 / 已合併),逐筆說明,最多回 50 筆 */
  blocked: Array<{ id: string; companyName: string; code: string; message: string }>;
  blockedCount: number;
  forced: boolean;
}

/** 階段代碼 → 這個階段現在的顯示名稱與啟用狀態(還原前的檢查用) */
type StageStateMap = ReadonlyMap<string, { label: string; isActive: boolean }>;
/** 案件編號 → 目前活著佔用它的那一筆(整批還原用,見 loadCaseRefHolders) */
type CaseRefHolderMap = ReadonlyMap<string, { id: string; companyName: string }>;

/**
 * blocked / skipped 回幾筆明細就夠了:再多也沒有人一筆一筆看。
 *
 * 明細被截斷之後,**總數一定要另外回一格**(整批刪除是 blockedCount,
 * 整批還原是 skippedCount)。少了那一格,呼叫端只剩 `blocked.length` /
 * `skipped.length` 可以拿,而那是截斷後的數字:一批 60 筆全部被擋時,
 * 畫面會寫「另有 50 筆留在回收桶」,回收桶裡實際上還有 60 筆。
 */
const BLOCKED_SHOWN = 50;

@Injectable()
export class CrmDeletionService {
  private readonly logger = new Logger(CrmDeletionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 原因欄:去頭尾空白、截到 schema 的長度上限;空字串當成沒填 */
  private reasonOf(v: unknown): string | null {
    const t = typeof v === 'string' ? v.trim() : '';
    return t.length ? t.slice(0, DELETE_REASON_MAX) : null;
  }

  /**
   * 寫一筆稽核紀錄(含來源 IP 與 User-Agent)。失敗只記 log 不往外丟:
   * 稽核寫不進去不該讓已經做完的刪除變成「畫面上失敗、資料庫已經生效」。
   */
  private async audit(
    action: string,
    userId: string,
    metadata: Record<string, unknown>,
    ctx?: AuditContext,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        // ip 與 user_agent 一起寫:只有 user_id 的話,事後回答不了
        // 「那批客戶是從哪一台機器刪掉的」(見 common/audit-context.ts)
        data: { userId, action, metadata: metadata as object, ...auditContextColumns(ctx) },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`[crm-delete] 稽核紀錄寫入失敗(${name}),操作本身已完成:${action}`);
    }
  }

  /**
   * 跑一段還原,並把資料庫擋下來的撞號轉成應用層本來就會回的那句 400。
   *
   * 整批還原這一側比單筆粗:那是一筆最多兩千列的交易,**一筆撞號會讓整個交易回滾**,
   * 另外一千九百九十九筆一起白做。不攔的話使用者拿到的是 500,而且看不出
   * 是哪一件事沒成功;攔下來至少會說「此案件編號已對應其他客戶」,
   * 使用者知道要先去處理編號,再按一次還原。
   *
   * 這是最後一道網,不是取代應用層那道:應用層那道說得出對方是誰
   * (restoreCaseRefTakenMessage),而且不用讓交易白跑一趟。
   */
  private async runCatchingCaseRefClash<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isCaseRefUniqueViolation(err)) {
        throw new BadRequestException(CASE_REF_TAKEN_MESSAGE);
      }
      throw err;
    }
  }

  /** 這一筆客戶現在的狀態(給 deleteBlockOf 用) */
  private async factsOf(customerId: string): Promise<DeletableCustomerFacts | null> {
    const c = await this.prisma.devCustomer.findUnique({
      where: { id: customerId },
      select: { id: true, stage: true, externalCaseRef: true, mergedIntoId: true, deletedAt: true },
    });
    if (!c) return null;
    const [humanInteractions, photos] = await Promise.all([
      this.prisma.devInteraction.count({
        where: { customerId, ...humanInteractionWhere() },
      }),
      this.prisma.devVisitPhoto.count({ where: { customerId } }),
    ]);
    return {
      merged: c.mergedIntoId !== null,
      alreadyDeleted: c.deletedAt !== null,
      converted: c.stage === WON_STAGE_KEY || c.externalCaseRef !== null,
      humanInteractions,
      photos,
    };
  }

  /**
   * 刪除前預檢(唯讀)。畫面按下刪除之前先問一次,才問得出
   * 「這一筆有 12 筆互動與 4 張照片,確定要刪嗎」,而不是按下去才被 400 打回來。
   */
  async deleteCheck(
    customerId: string,
    view: ViewScope,
  ): Promise<{ canDelete: boolean; block: DeleteBlock | null; facts: DeletableCustomerFacts }> {
    const c = await this.prisma.devCustomer.findUnique({
      where: { id: customerId },
      select: { ownerId: true },
    });
    if (!c || !canSeeOwner(view, c.ownerId))
      throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    const facts = await this.factsOf(customerId);
    if (!facts) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    const block = deleteBlockOf(facts);
    return { canDelete: block === null, block, facts };
  }

  /**
   * 單筆軟刪除。
   *
   * 整段在交易裡做,開頭 lockCustomerRow(與編輯 / 打卡 / 成交共用同一把列鎖):
   * 「檢查有沒有紀錄」到「標上 deleted_at」之間如果放行別的請求,
   * 同一秒的打卡或標記成交會落在一筆已經被判定為空資料的客戶上,
   * 結果是照片與成交紀錄掛在一筆回收桶裡的客戶身上,而畫面兩邊都正常。
   *
   * 條件式 updateMany(deleted_at IS NULL)是第二道保險:兩個人同時按刪除,
   * 第二個人的 count 會是 0,稽核就不會多記一筆不存在的刪除。
   */
  async softDelete(
    customerId: string,
    actorUserId: string,
    actorRole: string | null | undefined,
    view: ViewScope,
    opts: { reason?: unknown; force?: boolean } = {},
    ctx: AuditContext = {},
  ): Promise<DeleteResult> {
    const reason = this.reasonOf(opts.reason);
    const wantForce = opts.force === true;

    const outcome = await this.prisma.$transaction(async (tx) => {
      await lockCustomerRow(tx, customerId);
      const c = await tx.devCustomer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          companyName: true,
          ownerId: true,
          stage: true,
          externalCaseRef: true,
          mergedIntoId: true,
          deletedAt: true,
          importBatchId: true,
        },
      });
      // 查不到與看得到但沒權限回同一句話,不讓人用訊息差別問出這筆客戶存不存在
      if (!c || !canSeeOwner(view, c.ownerId)) {
        throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
      }
      const [humanInteractions, photos] = await Promise.all([
        tx.devInteraction.count({ where: { customerId, ...humanInteractionWhere() } }),
        tx.devVisitPhoto.count({ where: { customerId } }),
      ]);
      const facts: DeletableCustomerFacts = {
        merged: c.mergedIntoId !== null,
        alreadyDeleted: c.deletedAt !== null,
        converted: c.stage === WON_STAGE_KEY || c.externalCaseRef !== null,
        humanInteractions,
        photos,
      };
      const block = deleteBlockOf(facts);
      if (block) {
        // forcible=false(已合併、已經在回收桶裡)連管理員都不放行:那兩種情況下
        // 「強制刪除」本身沒有意義,放行只會讓人以為自己做了什麼
        if (!block.forcible) throw new BadRequestException(block.message);
        if (!wantForce) throw new BadRequestException(block.message);
        if (actorRole !== 'admin') throw new ForbiddenException(FORCE_REQUIRES_ADMIN_MESSAGE);
      }
      const res = await tx.devCustomer.updateMany({
        where: { id: customerId, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: actorUserId, deleteReason: reason },
      });
      return { changed: res.count > 0, customer: c, facts, forced: block !== null };
    });

    if (!outcome.changed) throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    await this.audit(
      DELETE_AUDIT_ACTIONS.delete,
      actorUserId,
      {
        customerId,
        companyName: outcome.customer.companyName,
        importBatchId: outcome.customer.importBatchId,
        reason,
        forced: outcome.forced,
        interactions: outcome.facts.humanInteractions,
        photos: outcome.facts.photos,
        converted: outcome.facts.converted,
      },
      ctx,
    );
    return { ok: true, id: customerId, forced: outcome.forced };
  }

  /**
   * 刪掉「這一批匯入的」。
   *
   * 這是整個功能的重點:匯錯一批三百筆,使用者要的是一個動作收回去,
   * 不是點三百次。批次識別碼由匯入時產生(dev_customers.import_batch_id),
   * 匯入的回應會把它帶回前端。
   *
   * 逐筆套同一套規則:這一批裡如果有幾筆已經有人跑過(打過卡、拍過照),
   * 那幾筆會被擋下並逐筆列出來,其餘照刪 —— 全批放棄或全批硬刪都不對。
   */
  async deleteImportBatch(
    importBatchId: string,
    actorUserId: string,
    actorRole: string | null | undefined,
    view: ViewScope,
    opts: { reason?: unknown; force?: boolean } = {},
    ctx: AuditContext = {},
  ): Promise<BatchDeleteResult> {
    this.assertTrashRole(actorRole);
    const reason = this.reasonOf(opts.reason);
    const wantForce = opts.force === true;
    if (wantForce && actorRole !== 'admin') {
      throw new ForbiddenException(FORCE_REQUIRES_ADMIN_MESSAGE);
    }
    // 先在交易外挑出「這一批有哪些 id」。要鎖哪幾列得先知道 id,而這一段的結果
    // 只用來決定鎖的範圍 —— 真正的判定資料在鎖內重讀,鎖外這一份不參與任何決定。
    const candidates = await this.prisma.devCustomer.findMany({
      where: { importBatchId, deletedAt: null, ...ownerFilter(view) },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH_DELETE_MAX,
    });
    if (candidates.length === 0) {
      throw new NotFoundException('找不到這一批匯入的客戶,可能已經刪過或不在你的可見範圍');
    }

    /*
     * 整批刪除與單筆刪除走同一套列鎖,理由完全一樣。
     *
     * 原本這一支是「findMany 讀狀態 → groupBy 數互動與照片 → updateMany 落 deleted_at」
     * 三段各自獨立,中間沒有任何鎖,而 updateMany 的條件只有 deleted_at IS NULL,
     * 沒有「互動數仍然是 0」。同一個訪查人員同時送出整批刪除與一次打卡上傳時,
     * 只要打卡落在讀與寫之間,那筆帶著存證照片的客戶就會被當成空資料軟刪除 ——
     * 而單筆路徑刪同一筆需要 admin 帶 force:true。同一件事兩條路徑兩種門檻,
     * 且整批那條完全沒有痕跡可查。
     *
     * 這裡改成整段在一筆交易裡:開頭一次鎖住這一批(ORDER BY id,取鎖順序固定),
     * 鎖內重讀狀態與計數再判定,最後的 updateMany 仍然帶 deleted_at IS NULL。
     * 逐筆開交易也可以,但兩千筆就是兩千次往返,而且逐筆取鎖的順序由陣列決定,
     * 兩個整批操作的清單交錯時會反向互等。
     *
     * timeout 放寬的理由同 setup.service:一批上限兩千筆,預設的 5 秒在慢一點的
     * 機器上不夠,而這是使用者按下去等結果的動作,不是背景工作。
     */
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await lockCustomerRows(
          tx,
          candidates.map((c) => c.id),
        );
        // 鎖內重讀:鎖外到鎖內之間被別人刪掉的那幾筆,這裡就不在清單裡了,
        // matched 也跟著是鎖內看到的事實,不是幾毫秒前的快照
        const rows = await tx.devCustomer.findMany({
          where: { id: { in: candidates.map((c) => c.id) }, deletedAt: null },
          select: {
            id: true,
            companyName: true,
            stage: true,
            externalCaseRef: true,
            mergedIntoId: true,
          },
          orderBy: { createdAt: 'asc' },
        });
        if (rows.length === 0) {
          throw new NotFoundException('找不到這一批匯入的客戶,可能已經刪過或不在你的可見範圍');
        }
        const ids = rows.map((r) => r.id);
        // 互動與照片一次查回來,不要每筆各打兩次(三百筆就是六百次往返)
        const [interactionGroups, photoGroups] = await Promise.all([
          tx.devInteraction.groupBy({
            by: ['customerId'],
            where: { customerId: { in: ids }, ...humanInteractionWhere() },
            _count: { _all: true },
          }),
          tx.devVisitPhoto.groupBy({
            by: ['customerId'],
            where: { customerId: { in: ids } },
            _count: { _all: true },
          }),
        ]);
        const interactionOf = new Map(interactionGroups.map((g) => [g.customerId, g._count._all]));
        const photoOf = new Map(photoGroups.map((g) => [g.customerId, g._count._all]));

        const deletable: string[] = [];
        const blocked: BatchDeleteResult['blocked'] = [];
        for (const r of rows) {
          const facts: DeletableCustomerFacts = {
            merged: r.mergedIntoId !== null,
            alreadyDeleted: false,
            converted: r.stage === WON_STAGE_KEY || r.externalCaseRef !== null,
            humanInteractions: interactionOf.get(r.id) ?? 0,
            photos: photoOf.get(r.id) ?? 0,
          };
          const block = deleteBlockOf(facts);
          if (block === null || (block.forcible && wantForce)) {
            deletable.push(r.id);
            continue;
          }
          blocked.push({
            id: r.id,
            companyName: r.companyName,
            code: block.code,
            message: block.message,
          });
        }

        let deleted = 0;
        if (deletable.length) {
          const res = await tx.devCustomer.updateMany({
            where: { id: { in: deletable }, deletedAt: null },
            data: { deletedAt: new Date(), deletedById: actorUserId, deleteReason: reason },
          });
          deleted = res.count;
        }
        return { matched: rows.length, deleted, blocked };
      },
      { timeout: 30_000, maxWait: 20_000 },
    );

    await this.audit(
      DELETE_AUDIT_ACTIONS.batchDelete,
      actorUserId,
      {
        importBatchId,
        matched: outcome.matched,
        deleted: outcome.deleted,
        blocked: outcome.blocked.length,
        forced: wantForce,
        reason,
      },
      ctx,
    );
    return {
      importBatchId,
      matched: outcome.matched,
      deleted: outcome.deleted,
      blocked: outcome.blocked.slice(0, BLOCKED_SHOWN),
      blockedCount: outcome.blocked.length,
      forced: wantForce,
    };
  }

  /**
   * 最近幾次匯入的批次。
   *
   * 沒有這一支的話,「刪掉這一批」等於要使用者自己記住匯入當下畫面上那一串 uuid ——
   * 而需要用到它的時機(發現匯錯了)通常是幾小時甚至隔天,那時候畫面早就關了。
   * 這裡從還在的客戶身上把批次撈回來,每一批帶筆數與最早的建立時間,
   * 使用者用「今天下午那批 312 筆」就認得出是哪一個。
   */
  async recentImportBatches(
    view: ViewScope,
    role: string | null | undefined,
    limit = IMPORT_BATCH_LIST_TAKE,
  ): Promise<{ rows: ImportBatchRow[] }> {
    this.assertTrashRole(role);
    const take = Math.min(Math.max(1, limit), IMPORT_BATCH_LIST_TAKE);
    const grouped = await this.prisma.devCustomer.groupBy({
      by: ['importBatchId'],
      where: { importBatchId: { not: null }, deletedAt: null, ...ownerFilter(view) },
      _count: { _all: true },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: 'desc' } },
      take,
    });
    return {
      rows: grouped
        .filter((g): g is typeof g & { importBatchId: string } => g.importBatchId !== null)
        .map((g) => ({
          importBatchId: g.importBatchId,
          count: g._count._all,
          firstCreatedAt: g._min.createdAt ?? null,
        })),
    };
  }

  /** 回收桶是主管級功能:一般業務刪掉之後要找主管還原,這是刻意的 */
  private assertTrashRole(role: string | null | undefined): void {
    if (!isCrmManagerRole(role)) throw new ForbiddenException(TRASH_FORBIDDEN_MESSAGE);
  }

  /**
   * 回收桶清單。一律帶上限與可見範圍;最近刪的排前面。
   * 帶互動與照片數量,管理員才判斷得出「這一筆還原回去會拿回什麼」。
   */
  async listDeleted(
    view: ViewScope,
    role: string | null | undefined,
    opts: { importBatchId?: string; limit?: number } = {},
  ): Promise<{ rows: TrashRow[]; take: number; truncated: boolean }> {
    this.assertTrashRole(role);
    const take =
      Number.isFinite(opts.limit) && (opts.limit as number) > 0
        ? Math.min(opts.limit as number, TRASH_LIST_TAKE)
        : TRASH_LIST_TAKE;
    const rows = await this.prisma.devCustomer.findMany({
      where: {
        deletedAt: { not: null },
        ...(opts.importBatchId ? { importBatchId: opts.importBatchId } : {}),
        ...ownerFilter(view),
      },
      orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
      take: take + 1,
      select: {
        id: true,
        companyName: true,
        taxId: true,
        stage: true,
        ownerId: true,
        deletedAt: true,
        deletedById: true,
        deleteReason: true,
        importBatchId: true,
        owner: { select: { name: true } },
        _count: { select: { interactions: true, visitPhotos: true } },
      },
    });
    const truncated = rows.length > take;
    const page = truncated ? rows.slice(0, take) : rows;
    // 刪除者的名字另外查:deleted_by_id 刻意不設外鍵(刪帳號不該讓這一格失效),
    // 所以查不到人就顯示 null,由畫面說「帳號已不存在」
    const deleterIds = [...new Set(page.map((r) => r.deletedById).filter((v): v is string => !!v))];
    const deleters = deleterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: deleterIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(deleters.map((u) => [u.id, u.name]));
    return {
      take,
      truncated,
      rows: page.map((r) => ({
        id: r.id,
        companyName: r.companyName,
        taxId: r.taxId,
        stage: r.stage,
        ownerId: r.ownerId,
        ownerName: r.owner?.name ?? null,
        deletedAt: r.deletedAt,
        deletedById: r.deletedById,
        deletedByName: r.deletedById ? (nameOf.get(r.deletedById) ?? null) : null,
        deleteReason: r.deleteReason,
        importBatchId: r.importBatchId,
        interactions: r._count.interactions,
        photos: r._count.visitPhotos,
      })),
    };
  }

  /**
   * 還原。只清 deleted_at / deleted_by_id / delete_reason 三格,
   * 階段、負責人、互動、照片一格都不動(見 RESTORE_KEEPS_STAGE 的說明)。
   *
   * 整段在交易裡並且開頭先取列鎖,理由與 purge 是同一件事:讀到「這一筆在回收桶裡」
   * 到真的把 deleted_at 清掉之間如果放行別的請求,管理員按下的永久刪除可能剛好落在
   * 中間 —— 那一筆會先被還原成活的,再被硬刪連同互動與存證照片一起帶走。
   *
   * 還原前另外問兩件事(見 restoreStageMissingMessage / restoreCaseRefTakenMessage):
   * 這一筆的階段還在不在、案件編號有沒有被別人用走。還原不改客戶的任何一格,
   * 所以這兩種衝突只能在還原前擋,不然還原會「成功」但那筆客戶從看板上消失,
   * 或是兩筆活著的客戶掛同一個外部案件編號。
   */
  async restore(
    customerId: string,
    actorUserId: string,
    actorRole: string | null | undefined,
    view: ViewScope,
    ctx: AuditContext = {},
  ): Promise<{ ok: true; id: string }> {
    this.assertTrashRole(actorRole);
    const c = await this.runCatchingCaseRefClash(async () =>
      this.prisma.$transaction(async (tx) => {
        await lockCustomerRow(tx, customerId);
        const cur = await tx.devCustomer.findUnique({
          where: { id: customerId },
          select: {
            id: true,
            companyName: true,
            ownerId: true,
            deletedAt: true,
            importBatchId: true,
            stage: true,
            externalCaseRef: true,
          },
        });
        if (!cur || cur.deletedAt === null || !canSeeOwner(view, cur.ownerId)) {
          throw new NotFoundException(TRASH_NOT_FOUND_MESSAGE);
        }
        await this.assertRestorable(tx, cur, await this.loadStageStates(tx, [cur.stage]));
        const res = await tx.devCustomer.updateMany({
          where: { id: customerId, deletedAt: { not: null } },
          data: { deletedAt: null, deletedById: null, deleteReason: null },
        });
        if (res.count === 0) throw new NotFoundException(TRASH_NOT_FOUND_MESSAGE);
        return cur;
      }),
    );
    await this.audit(
      DELETE_AUDIT_ACTIONS.restore,
      actorUserId,
      { customerId, companyName: c.companyName, importBatchId: c.importBatchId },
      ctx,
    );
    return { ok: true, id: customerId };
  }

  /**
   * 把這些階段代碼的主檔狀態一次撈回來(還原前的階段檢查用)。
   *
   * 為什麼要有這一支:assertRestorable 原本自己打一次 devStage.findFirst,
   * 而整批還原是逐筆呼叫它的 —— 一批兩千筆就是兩千次往返,而且全部發生在
   * **同一筆已經握著兩千個列鎖的交易裡**,鎖被握住的時間跟著往返次數線性放大。
   * 階段主檔是一張小表、而且整批要問的 key 高度重複,迴圈外一次撈完就夠。
   * (整批刪除那一半算互動與照片時已經是這個做法:groupBy 一次撈完。)
   *
   * 讀不到就回 null 並記一行 log:這是一道保護,不該讓它自己變成
   * 「還原失敗」的新原因(語意與原本 try/catch 那一段一致)。
   */
  private async loadStageStates(
    tx: Pick<PrismaService, 'devStage'>,
    stageKeys: readonly string[],
  ): Promise<StageStateMap | null> {
    const keys = [...new Set(stageKeys)];
    if (keys.length === 0) return new Map();
    try {
      const rows = await tx.devStage.findMany({
        where: { key: { in: keys } },
        select: { key: true, label: true, isActive: true },
      });
      return new Map(rows.map((r) => [r.key, { label: r.label, isActive: r.isActive }]));
    } catch {
      this.logger.warn('[crm-delete] 還原前的階段檢查讀不到 dev_stages,略過這一道檢查');
      return null;
    }
  }

  /**
   * 還原之前的衝突檢查。
   *
   * 階段主檔的狀態由呼叫端先用 loadStageStates 撈好再傳進來(null = 讀不到,
   * 略過這一道)。案件編號那一段沒有這個退路 —— 讓兩筆活著的客戶掛同一個編號,
   * 比還原失敗嚴重得多,所以它仍然逐筆查。
   */
  private async assertRestorable(
    tx: Pick<PrismaService, 'devCustomer'>,
    cur: { id: string; stage: string; externalCaseRef: string | null },
    stages: StageStateMap | null,
    claimed?: ReadonlyMap<string, string>,
    /**
     * 案件編號 → 目前活著佔用它的那一筆(id 與公司名),整批還原時由呼叫端
     * 先用 loadCaseRefHolders 一次撈好。傳了就不再逐筆查資料庫。
     */
    holders?: CaseRefHolderMap,
  ): Promise<void> {
    // stages 是 null 表示階段主檔讀不到(loadStageStates 已經記過一行 log),
    // 這是一道保護,不該讓它自己變成「還原失敗」的新原因,所以整段略過。
    if (stages !== null) {
      const stage = stages.get(cur.stage);
      if (!stage) throw new BadRequestException(restoreStageMissingMessage(cur.stage));
      // 停用跟不存在的症狀一樣:看板沒有這一欄,還原回去的客戶安靜地不見。
      // 只問「查得到嗎」會讓停用的那一半漏掉,而漏掉的那一半沒有任何錯誤訊息。
      if (!stage.isActive) {
        throw new BadRequestException(restoreStageInactiveMessage(cur.stage, stage.label));
      }
    }
    if (!cur.externalCaseRef) return;
    // 同一批裡先被放行的那些也要算:它們的 deleted_at 要等迴圈跑完才一起清掉,
    // 在資料庫眼裡此刻仍是「已刪除」,下面那句 deletedAt: null 的查詢看不到它們。
    const takenInBatch = claimed?.get(cur.externalCaseRef);
    if (takenInBatch !== undefined) {
      throw new BadRequestException(
        restoreCaseRefDuplicateInBatchMessage(cur.externalCaseRef, takenInBatch),
      );
    }
    // 整批還原會把整批的佔用情形先撈好(holders),那條路徑不再逐筆查。
    // 單筆還原沒有這個必要,照舊查一次。
    if (holders) {
      const held = holders.get(cur.externalCaseRef);
      if (held && held.id !== cur.id) {
        throw new BadRequestException(
          restoreCaseRefTakenMessage(cur.externalCaseRef, held.companyName),
        );
      }
      return;
    }
    const clash = await tx.devCustomer.findFirst({
      where: { externalCaseRef: cur.externalCaseRef, deletedAt: null, id: { not: cur.id } },
      select: { companyName: true },
    });
    if (clash) {
      throw new BadRequestException(
        restoreCaseRefTakenMessage(cur.externalCaseRef, clash.companyName),
      );
    }
  }

  /**
   * 這一批的案件編號現在各被誰佔著(只算活著的那些)。
   *
   * 為什麼要有這一支:整批還原是在**一筆握著最多兩千個列鎖、timeout 30 秒的交易裡**
   * 逐筆呼叫 assertRestorable 的,而那一支裡有一句 findFirst。兩千筆就是兩千次
   * 往返,而且是在鎖被握住的時候 —— 交易時間跟著往返次數線性放大,撞到 30 秒
   * 就是整批回滾,而使用者只看到一個逾時。階段主檔那一半已經改成迴圈外一次撈完
   * (loadStageStates),案件編號這一半是剩下的另一半。
   *
   * 讀不到就回 null,呼叫端退回逐筆查 —— 這是效能改善,不該變成新的失敗原因。
   */
  private async loadCaseRefHolders(
    tx: Pick<PrismaService, 'devCustomer'>,
    refs: readonly (string | null)[],
  ): Promise<CaseRefHolderMap | null> {
    const wanted = [...new Set(refs.filter((r): r is string => !!r))];
    if (wanted.length === 0) return new Map();
    try {
      const rows = await tx.devCustomer.findMany({
        where: { externalCaseRef: { in: wanted }, deletedAt: null },
        select: { id: true, companyName: true, externalCaseRef: true },
      });
      const map = new Map<string, { id: string; companyName: string }>();
      for (const r of rows) {
        if (r.externalCaseRef) map.set(r.externalCaseRef, { id: r.id, companyName: r.companyName });
      }
      return map;
    } catch {
      this.logger.warn('[crm-delete] 整批還原讀不到案件編號佔用情形,退回逐筆檢查');
      return null;
    }
  }

  /**
   * 整批還原(誤刪整批的反向操作)。
   *
   * 與整批刪除同一套列鎖。有衝突(階段被刪掉、階段被停用、案件編號被佔走)的那幾筆
   * 跳過並回報,不要因為一筆還不回去就讓另外兩百九十九筆一起留在回收桶裡。
   *
   * 回應分兩格講被跳過的那些,與整批刪除的 blocked / blockedCount 同形狀:
   *   skipped       逐筆明細,最多 BLOCKED_SHOWN 筆(給人看原因)
   *   skippedCount  真實總數(給畫面印數字)
   * 合成一格的話,「那一批客戶所在的階段被停用」這種很日常的情況
   * (整批每一筆都被擋)會讓畫面上的數字停在 50,而回收桶裡還有 300 筆。
   */
  async restoreImportBatch(
    importBatchId: string,
    actorUserId: string,
    actorRole: string | null | undefined,
    view: ViewScope,
    ctx: AuditContext = {},
  ): Promise<{
    ok: true;
    importBatchId: string;
    restored: number;
    /** 被跳過的逐筆說明,最多回 BLOCKED_SHOWN 筆 */
    skipped: Array<{ id: string; companyName: string; message: string }>;
    /** 被跳過的**真實總數**(不受 BLOCKED_SHOWN 截斷影響) */
    skippedCount: number;
  }> {
    this.assertTrashRole(actorRole);
    // orderBy 與整批刪除那一支一致(createdAt asc)。一批超過 BATCH_DELETE_MAX 時
    // take 會切掉一部分,沒有 orderBy 的話「哪 2000 筆被還原」由資料庫當下的
    // 掃描順序決定 —— 同一個請求連按兩次可能處理到不同的兩千筆,
    // 使用者按第二次時看到的剩餘筆數會跳來跳去。
    const candidates = await this.prisma.devCustomer.findMany({
      where: { importBatchId, deletedAt: { not: null }, ...ownerFilter(view) },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH_DELETE_MAX,
    });
    if (candidates.length === 0) throw new NotFoundException(TRASH_NOT_FOUND_MESSAGE);
    const outcome = await this.runCatchingCaseRefClash(() =>
      this.prisma.$transaction(
        async (tx) => {
          await lockCustomerRows(
            tx,
            candidates.map((c) => c.id),
          );
          // orderBy 不是裝飾:同一批裡兩筆撞號時「誰被還原、誰被跳過」由順序決定,
          // 不指定的話同一個請求跑兩次可能還原到不同的那一筆,而使用者看到的訊息會換人。
          const rows = await tx.devCustomer.findMany({
            where: { id: { in: candidates.map((c) => c.id) }, deletedAt: { not: null } },
            select: { id: true, companyName: true, stage: true, externalCaseRef: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          if (rows.length === 0) throw new NotFoundException(TRASH_NOT_FOUND_MESSAGE);
          const ok: string[] = [];
          const skipped: Array<{ id: string; companyName: string; message: string }> = [];
          // 這一批裡已經放行的案件編號 → 佔用它的公司名。
          //
          // 少了這一份,assertRestorable 的撞號檢查在整批還原這條路徑上等於沒有:
          // 它查的是「還有沒有別人活著佔著同一個編號」,而同一批被還原的那些筆
          // 要等迴圈跑完的 updateMany 才變成活的,逐筆檢查時彼此都還看不見對方,
          // 於是兩筆一起被放行,還原完成之後同時活著並掛同一個編號 ——
          // 回應是成功、skipped 是空的,畫面只會寫「已還原 2 筆」。
          const claimed = new Map<string, string>();
          // 階段主檔在迴圈外一次撈完(見 loadStageStates):逐筆各打一次的話,
          // 兩千筆就是兩千次往返,而且是握著兩千個列鎖的時候。
          const stages = await this.loadStageStates(
            tx,
            rows.map((r) => r.stage),
          );
          // 案件編號的佔用情形同樣在迴圈外一次撈完(見 loadCaseRefHolders):
          // 少了這一句,兩千筆就是兩千次 findFirst,全部發生在握著兩千個列鎖的交易裡
          const holders = await this.loadCaseRefHolders(
            tx,
            rows.map((r) => r.externalCaseRef),
          );
          for (const r of rows) {
            try {
              await this.assertRestorable(tx, r, stages, claimed, holders ?? undefined);
              ok.push(r.id);
              if (r.externalCaseRef) claimed.set(r.externalCaseRef, r.companyName);
            } catch (err) {
              if (!(err instanceof BadRequestException)) throw err;
              skipped.push({ id: r.id, companyName: r.companyName, message: err.message });
            }
          }
          const res = ok.length
            ? await tx.devCustomer.updateMany({
                where: { id: { in: ok }, deletedAt: { not: null } },
                data: { deletedAt: null, deletedById: null, deleteReason: null },
              })
            : { count: 0 };
          return { restored: res.count, skipped };
        },
        { timeout: 30_000, maxWait: 20_000 },
      ),
    );
    await this.audit(
      DELETE_AUDIT_ACTIONS.restore,
      actorUserId,
      { importBatchId, restored: outcome.restored, skipped: outcome.skipped.length },
      ctx,
    );
    return {
      ok: true,
      importBatchId,
      restored: outcome.restored,
      skipped: outcome.skipped.slice(0, BLOCKED_SHOWN),
      skippedCount: outcome.skipped.length,
    };
  }

  /**
   * 永久刪除(硬刪)。只有系統管理員,而且只能對已經在回收桶裡的那些。
   *
   * 這一步會沿著外鍵帶走互動紀錄與存證照片(dev_interactions / dev_visit_photos
   * 都是 onDelete: Cascade),所以「帶走了多少」要在刪之前數 —— 刪完之後就沒有
   * 任何地方數得出來了。拜訪排程也一起清:它的外鍵不是 Cascade,留著會變成
   * 指向不存在客戶的孤兒列。
   *
   * ── 為什麼整段要在交易裡並且先取列鎖 ────────────────────────────
   * 原本是「交易外讀到 deleted_at 不為 null → 交易內 delete」,中間沒有鎖,
   * 而 delete 的條件只有 id。管理員按下永久刪除的同一刻主管按下還原(還原當時
   * 也沒有鎖),那一筆會先被還原成活的,再被這裡硬刪 —— 一筆正在使用中的客戶
   * 連同存證照片一起消失,而兩邊的回應都是成功。同一個窗口也讓稽核記下的
   * 「帶走了多少互動與照片」失真。
   * 現在:列鎖 → 鎖內重讀並確認仍在回收桶 → 數 → 刪(deleteMany 帶
   * deleted_at IS NOT NULL 的條件式,count 是 0 就當作已經被別人處理掉)。
   * 稽核在交易提交之後才寫,記的是真的發生過的事。
   *
   * 鎖的是「這一筆 + 所有 merged_into_id 指著它的客戶」,一句 SQL 照 id 序取完
   * (lockCustomerAndMergedSources)。只鎖自己再去動別人那幾列的話,取鎖順序由查詢
   * 回來的順序決定,與整批刪除 / 整批還原的 id 序交錯時可以成環;環被 Postgres 中止之後
   * 這一支原本沒有像查重合併那樣的 P2034 重試,使用者拿到的是 500。兩件事一起補。
   *
   * ── 懸空的 mergedIntoId ────────────────────────────────────────
   * 被硬刪的如果是一筆「合併保留筆」,之前併進它的那幾筆客戶身上還留著
   * merged_into_id 指著它,而那一欄沒有外鍵,不會被資料庫擋下來也不會被清掉。
   * 結果是那幾筆客戶從此只回一句「此客戶已合併到另一筆」,而那個「另一筆」
   * 已經不存在,點過去是 404,使用者沒有任何路徑看到自己的資料。
   * 所以這裡把指標清掉,並把實情寫進它們的備註(保留原本的備註內容),
   * 客戶卡打得開,而且上面寫得出「保留的那筆已被永久刪除」。
   */
  async purge(
    customerId: string,
    actorUserId: string,
    actorRole: string | null | undefined,
    view: ViewScope,
    ctx: AuditContext = {},
  ): Promise<{
    ok: true;
    id: string;
    interactions: number;
    photos: number;
    /** 原本併進這一筆、指標被清掉的客戶數 */
    unlinked: number;
  }> {
    if (actorRole !== 'admin') throw new ForbiddenException(PURGE_FORBIDDEN_MESSAGE);
    try {
      return await this.purgeOnce(customerId, actorUserId, view, ctx);
    } catch (err) {
      // 取鎖順序已經固定成 id 序(見 lockCustomerAndMergedSources),環構不成,
      // 但 Postgres 仍可能因為別條路徑的序列化衝突中止這一筆(Prisma 包成 P2034)。
      // 重跑一次會重新取鎖並重讀:該筆已經被別人硬刪掉的話,第二次會乾淨地回
      // 「回收桶裡找不到此客戶」,而不是把一個看不懂的 500 丟給管理員。
      // 做法與查重合併那一支一致。
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
        return this.purgeOnce(customerId, actorUserId, view, ctx);
      }
      throw err;
    }
  }

  private async purgeOnce(
    customerId: string,
    actorUserId: string,
    view: ViewScope,
    ctx: AuditContext,
  ): Promise<{
    ok: true;
    id: string;
    interactions: number;
    photos: number;
    unlinked: number;
  }> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await lockCustomerAndMergedSources(tx, customerId);
        const c = await tx.devCustomer.findUnique({
          where: { id: customerId },
          select: {
            id: true,
            companyName: true,
            ownerId: true,
            deletedAt: true,
            importBatchId: true,
          },
        });
        // 只能硬刪已經在回收桶裡的:要永久刪除就先軟刪除一次,
        // 中間那一步是刻意的,它讓「不小心按到」不會直接變成資料消失
        if (!c || c.deletedAt === null || !canSeeOwner(view, c.ownerId)) {
          throw new NotFoundException(TRASH_NOT_FOUND_MESSAGE);
        }
        const [interactions, photos] = await Promise.all([
          tx.devInteraction.count({ where: { customerId } }),
          tx.devVisitPhoto.count({ where: { customerId } }),
        ]);
        const unlinked = await this.unlinkMergedInto(tx, customerId, c.companyName);
        await tx.devVisitPlan.deleteMany({ where: { customerId } });
        const res = await tx.devCustomer.deleteMany({
          where: { id: customerId, deletedAt: { not: null } },
        });
        // 鎖內重讀之後這一句理論上一定刪得到;count 是 0 表示有人在鎖外把它換掉了,
        // 交易整個回滾比「回一個成功、但什麼都沒刪」好
        if (res.count === 0) throw new NotFoundException(TRASH_NOT_FOUND_MESSAGE);
        return { customer: c, interactions, photos, unlinked };
      },
      /*
       * timeout 放寬的理由與整批刪除 / 整批還原一致,而且這一支更需要:
       * unlinkMergedInto 最多逐筆 UPDATE 500 列(要保住各自原本的備註,updateMany
       * 只能寫同一個值),合併鏈長的時候 Prisma 預設的 5 秒會在中途撞破,
       * 整筆交易回滾,管理員看到的是一個看不懂的錯而不是「刪掉了」或「擋下來了」。
       */
      { timeout: 30_000, maxWait: 20_000 },
    );

    await this.audit(
      DELETE_AUDIT_ACTIONS.purge,
      actorUserId,
      {
        customerId,
        companyName: outcome.customer.companyName,
        importBatchId: outcome.customer.importBatchId,
        interactions: outcome.interactions,
        photos: outcome.photos,
        unlinked: outcome.unlinked,
      },
      ctx,
    );
    return {
      ok: true,
      id: customerId,
      interactions: outcome.interactions,
      photos: outcome.photos,
      unlinked: outcome.unlinked,
    };
  }

  /**
   * 把指向 survivorId 的 merged_into_id 清掉,並在那幾筆的備註上寫清楚發生了什麼。
   *
   * 逐筆更新是為了保住各自原本的備註(updateMany 只能寫同一個值)。
   * 一次先處理 UNLINK_NOTE_MAX 筆,剩下的用一句 updateMany 把指標清掉就好 ——
   * 指標懸空是會壞掉的部分,備註只是說明,不值得為它拖長一個交易。
   */
  private async unlinkMergedInto(
    tx: Pick<PrismaService, 'devCustomer'>,
    survivorId: string,
    survivorName: string,
  ): Promise<number> {
    const orphans = await tx.devCustomer.findMany({
      where: { mergedIntoId: survivorId },
      select: { id: true, note: true },
      take: UNLINK_NOTE_MAX,
    });
    for (const o of orphans) {
      const kept = (o.note ?? '').trim();
      await tx.devCustomer.update({
        where: { id: o.id },
        data: {
          mergedIntoId: null,
          note: `${purgedSurvivorNote(survivorName)}${kept ? `\n${kept}` : ''}`.slice(
            0,
            CUSTOMER_NOTE_MAX,
          ),
        },
      });
    }
    if (orphans.length < UNLINK_NOTE_MAX) return orphans.length;
    const rest = await tx.devCustomer.updateMany({
      where: { mergedIntoId: survivorId },
      data: { mergedIntoId: null },
    });
    return orphans.length + rest.count;
  }
}
