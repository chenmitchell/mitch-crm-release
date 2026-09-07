// ref:3687 mc/陳彥輔/米球®
/**
 * 資料匯出:客戶清單、互動紀錄、存證照片清單。
 *
 * ── 這一支存在的理由 ────────────────────────────────────────────
 * 「三年後我要換掉你,資料怎麼帶走。」在這之前這個問題答不出來:
 * 後端沒有任何一支端點會回附件,資料進得來出不去。一套沒有出口的系統,
 * 對導入的組織來說就是把自己鎖進去,採購那一關本來就該擋下來。
 *
 * ── 設計上的三個決定 ────────────────────────────────────────────
 * 1. **客戶匯出的前十欄,順序與匯入格式一模一樣。**
 *    匯入是位置式解析(見前端 lib/csv-import.ts 的 IMPORT_COLS),所以只要
 *    前十欄對齊,匯出的檔案就能直接改完再匯回來 —— 這是「批次修資料」
 *    在沒有工程師的組織裡唯一可行的做法。第十一欄之後是唯讀的補充欄位
 *    (承辦人員、階段代碼、建立時間 ... ),匯入端只看前十欄,不會被它們影響。
 *    補充欄位要加新的一律接在**最後面**,理由與匯入格式一樣:插在中間會讓
 *    所有既有檔案的後半段錯位。
 *    進度與分類匯出的是**中文名稱**而不是代碼:匯入端兩種都吃得下
 *    (見 CrmService.stageLabelMap / categoryKeyMap),而人要看的是中文。
 *
 * 2. **照片不打包成一個檔,只給清單。**
 *    照片存在資料庫的 bytes 欄位裡,一個組織跑一年就是幾 GB。
 *    在 Node 的記憶體裡組一個那麼大的 zip 會直接把後端打掛,
 *    而這件事的實際需求是「我要把證據帶走」,不是「我要一鍵下載」。
 *    所以匯出一份清單(照片 id、客戶、種類、拍攝時間、大小、SHA-256、下載網址),
 *    逐張下載走既有的 GET /api/admin/crm-checkin/photo/:photoId。
 *    整批搬移請直接對資料庫下 pg_dump,做法寫在 docs/安裝與部署.md。
 *
 * 3. **一定有筆數上限,而且截斷要說出來。**
 *    每一支都帶 limit 與 offset,回應的標頭會告訴呼叫端還有沒有下一批
 *    (X-Export-Truncated / X-Export-Next-Offset)。安靜截斷的匯出檔
 *    是最糟的結果:使用者以為自己拿到了全部,三年後才發現少了一半。
 *
 * 可見範圍一律吃 ViewScope:業務匯出自己的、主管匯出團隊的、管理員匯出全部。
 * 每一次匯出都寫一筆 audit_logs(誰、匯了什麼、幾筆),匯出是把資料帶出系統的
 * 動作,沒有稽核就等於沒有辦法回答「那份名單是誰拿走的」。
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgTimeService } from '../../settings/org-time.service';
import { StageCatalogService } from '../../app-settings/stage-catalog.service';
import { ownerFilter, type ViewScope } from '../../scope/view-scope';
import { auditContextColumns, type AuditContext } from '../../common/audit-context';
import { countableCustomerWhere, relatedLiveCustomerFilter } from '../crm-scope-filters';
import { exportFileName, toCsv } from './csv';
import { formatOrgDateTime, resolveTimeZone, LOOKUP_DEFAULT_LABEL } from '@mitchcrm/shared';
import { SettingsService } from '../../settings/settings.service';

/**
 * 一次匯出的筆數上限。
 *
 * 客戶與互動都在資料庫裡是一列一列的小資料,5000 筆組成的 CSV 大約幾 MB,
 * 在記憶體裡組得起來也傳得完。要更多就帶 offset 分批,不是把上限調大 ——
 * 上限調大只是把「什麼時候會爆」往後推,而爆掉的時候是整個後端一起。
 */
export const EXPORT_MAX_ROWS = 5000;

/** 照片清單一次的上限。它只帶中繼資料(不含 bytes),所以可以比客戶多一些 */
export const PHOTO_MANIFEST_MAX_ROWS = 10_000;

/** 稽核記錄的 action 代碼 */
export const EXPORT_AUDIT_ACTIONS = {
  customers: 'crm.export.customers',
  interactions: 'crm.export.interactions',
  photos: 'crm.export.photo_manifest',
} as const;

/**
 * 客戶匯出的欄位標題。
 *
 * ★ 前十欄的順序**就是**匯入格式,不要動。改順序等於讓所有既有的 CSV 錯位,
 *   而且匯入不會報錯,它只會把每一格照位置填進錯的欄位。
 *   對照 apps/frontend/src/lib/csv-import.ts 的 IMPORT_COLS。
 * 第一欄的名稱由後台設定決定(lookupLabel),所以標題是組出來的,不是常數。
 * 傳進來的是**已經決定好的**那個名字(見 identifierColumnLabel):
 * 外部查詢關掉時後台那一格存的可能是功能名而不是欄位名,不該原樣印在對外的檔案上。
 */
export function customerCsvHeaders(lookupLabel: string): string[] {
  return [
    lookupLabel,
    '公司名',
    '聯絡人',
    '電話',
    '分類',
    '進度',
    '備註',
    '實際營業地址',
    '登記地址',
    '聯絡地址',
    // 這裡之後都是唯讀欄位,匯入端不看。要加新欄位一律接在最後面。
    //
    // 「承辦人員」指的是這筆客戶在系統裡的 owner(出門做訪查的那個人),
    // 不是公司登記的負責人。後者是 representative,叫「公司負責人」,排在最後那一段。
    // 兩個都叫「負責人」的話,客戶要一份負責人清單,拿到的會是自己公司的人員名單。
    '承辦人員',
    '進度代碼',
    '場所類型',
    '下次跟進',
    '最近聯絡',
    '建立時間',
    '更新時間',
    '客戶編號',
    '匯入批次',
    // 以下五欄是後補的:客戶卡上看得到也編輯得了,匯出卻一直漏掉,
    // 使用者拿到的檔案等於少了五格資料而且沒有任何地方說明。接在最後面補齊。
    '公司負責人',
    '網站',
    '社群',
    '來源',
    '外部案件編號',
  ];
}

/** 互動紀錄匯出的欄位標題 */
export const INTERACTION_CSV_HEADERS = [
  '發生時間',
  '客戶名稱',
  '客戶編號',
  '管道',
  '內容',
  '下一步',
  '記錄者',
  '定位緯度',
  '定位經度',
  '距離公尺',
  '可疑定位',
  '互動編號',
] as const;

/** 存證照片清單的欄位標題 */
export const PHOTO_CSV_HEADERS = [
  '拍攝時間',
  '客戶名稱',
  '客戶編號',
  '照片種類',
  '檔案型態',
  '位元組',
  'SHA256',
  '照片編號',
  '下載路徑',
] as const;

export interface ExportPage {
  /** CSV 全文(含 BOM) */
  readonly csv: string;
  /** 建議的檔名 */
  readonly fileName: string;
  /** 這一批實際幾筆 */
  readonly count: number;
  /** 還有下一批嗎 */
  readonly truncated: boolean;
  /** 下一批的 offset(沒有下一批就是 null) */
  readonly nextOffset: number | null;
}

interface PageOpts {
  readonly limit?: number;
  readonly offset?: number;
}

@Injectable()
export class CrmExportService {
  private readonly logger = new Logger(CrmExportService.name);

  // SettingsService 用 @Optional:單元測試直接 new CrmExportService(prisma, orgTime, catalog)
  // 不必再多帶一個假物件;沒有它就照呼叫端給的欄位名走(行為與加這一層之前相同)
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgTime: OrgTimeService,
    private readonly stageCatalog: StageCatalogService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /** 這一批要幾筆、從第幾筆開始。超過上限就壓到上限,負數當 0 */
  private page(opts: PageOpts, max: number): { take: number; skip: number } {
    const rawLimit = Number(opts.limit);
    const take = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, max) : max;
    const rawOffset = Number(opts.offset);
    const skip = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    return { take, skip };
  }

  /** 檔名用的時間戳:組織時區的當地時間,不是 UTC 也不是伺服器時間 */
  private async stamp(now = new Date()): Promise<string> {
    const tz = await this.timeZone();
    // 2026-09-05 14:30:00 → 20260905-1430
    const s = formatOrgDateTime(now, tz, { seconds: false });
    return `${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11).replace(':', '')}`;
  }

  private async timeZone(): Promise<string> {
    try {
      return await this.orgTime.timeZone();
    } catch {
      return resolveTimeZone(null);
    }
  }

  /** 匯出的時間欄位一律寫當地時間字串,不是 ISO:這份檔案是給人看的 */
  private fmt(dt: Date | null | undefined, tz: string): string {
    return dt ? formatOrgDateTime(dt, tz) : '';
  }

  /**
   * 寫一筆稽核(含來源 IP 與 User-Agent)。失敗只記 log:稽核寫不進去不該讓已經產好的檔案吐不出去,
   * 但一定要在日誌上看得見,不然「沒有稽核紀錄」會被誤讀成「沒有人匯出過」。
   */
  private async audit(
    action: string,
    userId: string,
    metadata: Record<string, unknown>,
    ctx?: AuditContext,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        // ip 與 user_agent 一起寫。匯出是「一次把大量客戶資料帶出系統」的動作,
        // 事後要回答的問題是「那份名單是誰在哪裡帶走的」,只有 user_id 答不出後半句
        data: { userId, action, metadata: metadata as object, ...auditContextColumns(ctx) },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.warn(`[crm-export] 稽核紀錄寫入失敗(${name}),匯出本身已完成:${action}`);
    }
  }

  /** 階段代碼轉中文名稱的對照;讀不到主檔就原樣輸出代碼,不要讓匯出整支失敗 */
  private async stageLabels(): Promise<Map<string, string>> {
    try {
      const rows = await this.stageCatalog.all();
      return new Map(rows.map((s) => [s.key, s.label]));
    } catch {
      return new Map();
    }
  }

  /** 商業分類代碼轉中文名稱;同上,讀不到就原樣輸出 */
  private async categoryLabels(): Promise<Map<string, string>> {
    try {
      const rows = await this.prisma.devCategory.findMany({ select: { key: true, label: true } });
      return new Map(rows.map((c) => [c.key, c.label]));
    } catch {
      return new Map();
    }
  }

  /**
   * 匯出檔第一欄的標題。
   *
   * 那一欄放的是客戶識別碼,平常用後台設定的 lookupLabel 當名字,讓每個地方叫得跟
   * 當地的說法一樣。問題在於外部查詢**關掉**的時候:那一格是跟著查詢功能一起設的,
   * 管理員常常填的是功能的名字(「統編查詢」)而不是欄位的名字,功能關掉之後那個字
   * 仍然被印在一份會寄出去、會匯進別的系統的檔案上,而系統裡已經沒有那個功能了。
   *
   * 所以查詢功能關著就退回通用名稱(LOOKUP_DEFAULT_LABEL)。
   *
   * 匯出檔匯得回來這件事不受影響:匯入是**位置式**解析(見前端 lib/csv-import.ts 的
   * IMPORT_COLS),第一欄叫什麼都對得上,不是拿標題文字當 key。
   *
   * 讀不到設定就照呼叫端給的名字走:一格設定讀不到不該讓整份匯出失敗。
   */
  private async identifierColumnLabel(lookupLabel: string): Promise<string> {
    try {
      const configured = await this.settings?.get();
      if (configured && configured.lookupEnabled !== true) return LOOKUP_DEFAULT_LABEL;
    } catch {
      // 讀不到設定不該讓匯出整支掛掉
    }
    return lookupLabel;
  }

  /**
   * 客戶清單匯出。
   *
   * 已刪除與已合併的客戶不匯出(countableCustomerWhere):匯出的是「現在的客戶」,
   * 把回收桶裡的東西一起吐出去,換到新系統的第一天就多一批垃圾。
   * 要看回收桶請走 GET /api/admin/crm-trash。
   */
  async customersCsv(
    userId: string,
    view: ViewScope,
    lookupLabel: string,
    opts: PageOpts = {},
    ctx: AuditContext = {},
  ): Promise<ExportPage> {
    const { take, skip } = this.page(opts, EXPORT_MAX_ROWS);
    const where = { ...countableCustomerWhere(), ...ownerFilter(view) };
    const rows = await this.prisma.devCustomer.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip,
      // 多讀一筆判斷還有沒有下一批,不必另外 count(大表上的 count 是全掃)
      take: take + 1,
      select: {
        id: true,
        taxId: true,
        companyName: true,
        contactName: true,
        contactPhone: true,
        category: true,
        stage: true,
        note: true,
        actualAddress: true,
        registeredAddress: true,
        contactAddress: true,
        premisesType: true,
        nextFollowUpAt: true,
        lastContactAt: true,
        createdAt: true,
        updatedAt: true,
        importBatchId: true,
        representative: true,
        website: true,
        social: true,
        source: true,
        externalCaseRef: true,
        owner: { select: { name: true } },
      },
    });
    const truncated = rows.length > take;
    const page = truncated ? rows.slice(0, take) : rows;
    const [tz, stageLabel, categoryLabel] = await Promise.all([
      this.timeZone(),
      this.stageLabels(),
      this.categoryLabels(),
    ]);
    const body = page.map((c) => [
      c.taxId ?? '',
      c.companyName,
      c.contactName ?? '',
      c.contactPhone ?? '',
      c.category ? (categoryLabel.get(c.category) ?? c.category) : '',
      stageLabel.get(c.stage) ?? c.stage,
      c.note ?? '',
      c.actualAddress ?? '',
      c.registeredAddress ?? '',
      c.contactAddress ?? '',
      c.owner?.name ?? '',
      c.stage,
      c.premisesType ?? '',
      this.fmt(c.nextFollowUpAt, tz),
      this.fmt(c.lastContactAt, tz),
      this.fmt(c.createdAt, tz),
      this.fmt(c.updatedAt, tz),
      c.id,
      c.importBatchId ?? '',
      c.representative ?? '',
      c.website ?? '',
      c.social ?? '',
      c.source ?? '',
      c.externalCaseRef ?? '',
    ]);
    const csv = toCsv(customerCsvHeaders(await this.identifierColumnLabel(lookupLabel)), body);
    await this.audit(
      EXPORT_AUDIT_ACTIONS.customers,
      userId,
      { count: page.length, offset: skip, truncated },
      ctx,
    );
    return {
      csv,
      fileName: exportFileName('customers', await this.stamp()),
      count: page.length,
      truncated,
      nextOffset: truncated ? skip + page.length : null,
    };
  }

  /**
   * 互動紀錄匯出。
   *
   * 系統紀錄(【客戶移交】【已成交】那一類)**照樣匯出**,跟統計不一樣:
   * 統計要的是「這位訪查人員做了多少事」,搬家要的是「這筆客戶身上發生過什麼」,
   * 系統紀錄正是後者最重要的部分。
   */
  async interactionsCsv(
    userId: string,
    view: ViewScope,
    opts: PageOpts & { days?: number } = {},
    ctx: AuditContext = {},
  ): Promise<ExportPage> {
    const { take, skip } = this.page(opts, EXPORT_MAX_ROWS);
    const days = Number(opts.days);
    const since =
      Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;
    const rows = await this.prisma.devInteraction.findMany({
      where: {
        ...(since ? { occurredAt: { gte: since } } : {}),
        // 客戶已刪除的互動不匯出,口徑與清單一致
        ...relatedLiveCustomerFilter(view),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      skip,
      take: take + 1,
      select: {
        id: true,
        occurredAt: true,
        channel: true,
        note: true,
        nextAction: true,
        gpsLat: true,
        gpsLng: true,
        distanceM: true,
        gpsSuspicious: true,
        customerId: true,
        customer: { select: { companyName: true } },
        user: { select: { name: true } },
      },
    });
    const truncated = rows.length > take;
    const page = truncated ? rows.slice(0, take) : rows;
    const tz = await this.timeZone();
    const body = page.map((it) => [
      this.fmt(it.occurredAt, tz),
      it.customer?.companyName ?? '',
      it.customerId,
      it.channel,
      it.note ?? '',
      it.nextAction ?? '',
      it.user?.name ?? '',
      it.gpsLat ?? '',
      it.gpsLng ?? '',
      it.distanceM ?? '',
      it.gpsSuspicious ? '是' : '',
      it.id,
    ]);
    const csv = toCsv([...INTERACTION_CSV_HEADERS], body);
    await this.audit(
      EXPORT_AUDIT_ACTIONS.interactions,
      userId,
      {
        count: page.length,
        offset: skip,
        truncated,
        // days 一定要記:同樣是「匯出 5000 筆互動」,對方匯的是最近七天還是
        // 從頭到尾全部,是完全不同的兩件事,而沒有這一格就分不出來。
        // 記的是實際生效的值(不合法或沒帶就是 null,表示不限期間)
        days: since ? days : null,
      },
      ctx,
    );
    return {
      csv,
      fileName: exportFileName('interactions', await this.stamp()),
      count: page.length,
      truncated,
      nextOffset: truncated ? skip + page.length : null,
    };
  }

  /**
   * 存證照片清單(不是照片本身)。
   *
   * 每一列帶一個 downloadPath,照著逐張抓就能把全部照片帶走;
   * SHA-256 一起給,拿到之後可以驗證檔案沒有在搬運途中被改掉 ——
   * 存證照片的價值就在「它沒有被動過」,少了雜湊,搬過去的照片沒有人敢主張。
   */
  async photoManifestCsv(
    userId: string,
    view: ViewScope,
    opts: PageOpts = {},
    ctx: AuditContext = {},
  ): Promise<ExportPage & { totalBytes: number }> {
    const { take, skip } = this.page(opts, PHOTO_MANIFEST_MAX_ROWS);
    const rows = await this.prisma.devVisitPhoto.findMany({
      where: {
        customer: {
          ...countableCustomerWhere(),
          ...(ownerFilter(view) as Record<string, unknown>),
        },
      },
      orderBy: [{ takenAt: 'desc' }, { id: 'asc' }],
      skip,
      take: take + 1,
      // 刻意不 select bytes:一萬列的照片本體會直接把後端的記憶體吃光,
      // 而這份檔案要的只是「有哪些照片、去哪裡拿」
      select: {
        id: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        sha256: true,
        takenAt: true,
        customerId: true,
        customer: { select: { companyName: true } },
      },
    });
    const truncated = rows.length > take;
    const page = truncated ? rows.slice(0, take) : rows;
    const tz = await this.timeZone();
    let totalBytes = 0;
    const body = page.map((p) => {
      totalBytes += p.sizeBytes;
      return [
        this.fmt(p.takenAt, tz),
        p.customer?.companyName ?? '',
        p.customerId,
        p.kind,
        p.mime,
        p.sizeBytes,
        p.sha256,
        p.id,
        `/api/admin/crm-checkin/photo/${p.id}`,
      ];
    });
    const csv = toCsv([...PHOTO_CSV_HEADERS], body);
    await this.audit(
      EXPORT_AUDIT_ACTIONS.photos,
      userId,
      { count: page.length, offset: skip, truncated, totalBytes },
      ctx,
    );
    return {
      csv,
      fileName: exportFileName('photos', await this.stamp()),
      count: page.length,
      truncated,
      nextOffset: truncated ? skip + page.length : null,
      totalBytes,
    };
  }
}
