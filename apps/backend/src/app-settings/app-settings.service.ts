// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 應用程式設定。
 *
 * 這一支是「不要 hardcode」的落點:公司名稱、標誌文字、時區、地區、預設語言、
 * 對外聯絡資訊、地圖服務設定,全部從 system_settings id=1 讀;
 * 客戶階段、照片存證種類、互動管道與場所類型則各有自己的主檔表
 * (dev_stages / visit_photo_kinds / dev_interaction_channels / dev_premises_types),
 * 因為它們是多筆、要排序、要擋刪除的資料,塞進 JSON 會失去這些性質。
 *
 * 授權集中在這裡而不是 controller:改設定一律只有系統管理員能做,
 * 分散在 controller 的話,新增一支端點很容易忘了補守衛。
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StageCatalogService } from './stage-catalog.service';
import { SettingsService, type SystemSettingsData } from '../settings/settings.service';
import { DEFAULT_PLACE_TYPES, RESERVED_CHANNEL_KEYS, RESERVED_STAGE_KEYS } from '@mitchcrm/shared';
import { type SeedCatalog } from './app-settings.constants';
// 「已刪除的不算數」的條件寫成一份,誰要數客戶就套同一份(見 crm-scope-filters 的說明)
import { notDeletedWhere } from '../crm/crm-scope-filters';
import {
  checkLookupPatternSafety,
  checkLookupUrlTemplate,
  compileLookupPattern,
} from '../lookup/lookup-url';
import {
  KEY_FORMAT_MESSAGE,
  SETTINGS_KEY_PATTERN,
  toAppSettingsView,
  toPhotoChecklistMap,
  toSettingsPatch,
  type AppSettingsPatch,
  type AppSettingsView,
  type PhotoCheckItemView,
  type PhotoKindRow,
  type StageRow,
  type StageView,
  type VocabItemView,
  type VocabRow,
} from './app-settings.view';

/**
 * 後台存檔的 advisory lock。與安裝精靈的 SETUP_LOCK_KEY 是同一套做法,
 * 不同的鍵值:兩者互不相干,共用一把只會讓安裝精靈與後台存檔互相等。
 * xact 版,交易結束自動釋放。
 */
export const APP_SETTINGS_LOCK_KEY = 3687_0002;

/** 一份設定裡的階段 / 管道 / 場所類型至少要留一項。訊息會原樣顯示給使用者 */
export function emptyListMessage(what: string): string {
  return `至少要保留一個${what}。全部刪掉的話,系統會退回出廠預設,而畫面上看不出原因`;
}

/** 存證照片種類的對外形狀(getAll 用;逐筆 CRUD 那組端點已經拿掉,見 controller 檔頭)*/
export interface VisitPhotoKindView {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * 後台設定頁的完整回應。
 *
 * settings 是前端 AppSettings 的形狀(見 app-settings.view),不是資料庫那五處的原樣:
 * 形狀對應規則只寫在 app-settings.view 一個地方,GET 與 PATCH 共用同一組轉換。
 *
 * stageUsage / channelUsage / premisesTypeUsage 是「每一筆目前有幾份資料在用」。
 * 後台的刪除鈕靠它決定按不按得下去 —— 少了它,使用者只能按下去、吃到 409、再回來改,
 * 而那時候他已經把畫面上那一筆刪掉了。
 */
export interface AdminAppSettingsResponse {
  settings: AppSettingsView;
  /** 階段代碼 → 目前停在該階段的客戶數 */
  stageUsage: Record<string, number>;
  /** 管道代碼 → 已經有幾筆互動用了它 */
  channelUsage: Record<string, number>;
  /** 場所類型代碼 → 已經有幾位客戶用了它 */
  premisesTypeUsage: Record<string, number>;
  /** 商業分類代碼 → 已經有幾位客戶用了它 */
  categoryUsage: Record<string, number>;
}

/**
 * key 的格式與訊息一律引用 app-settings.view 的那一份 —— 前端用的是同一條規則,
 * 各寫一份的話,後台建得起來的代碼前端會整筆丟掉,而且畫面上沒有任何錯誤。
 */
export { KEY_FORMAT_MESSAGE };

/**
 * 階段還有人在用時的訊息。前端會原樣顯示,所以句子本身要講清楚
 * 「哪一個階段、還有幾位客戶、可以怎麼辦」,不要只說「無法刪除」。
 */
export function stageInUseMessage(label: string, count: number): string {
  return `還有 ${count} 位客戶停在「${label}」這個階段,不能刪除。請先把這些客戶改到其他階段,或改成停用保留歷史`;
}

/** 補齊照片檢查表項目的可省略欄位,再交給對照表換算 */
function normalizeItems(
  items: ReadonlyArray<Partial<PhotoCheckItemView> & { key: string }>,
): PhotoCheckItemView[] {
  return items.map((p) => ({
    key: p.key.trim(),
    label: (p.label ?? '').trim() || p.key.trim(),
    required: p.required ?? false,
    placeTypes: Array.isArray(p.placeTypes) ? [...p.placeTypes] : [],
  }));
}

export function photoKindInUseMessage(label: string, count: number): string {
  return `已經有 ${count} 張照片屬於「${label}」這個種類,不能刪除。請改成停用保留歷史`;
}

export function channelInUseMessage(label: string, count: number): string {
  return `已經有 ${count} 筆互動紀錄用了「${label}」這個管道,不能刪除。請改成停用保留歷史`;
}

export function premisesTypeInUseMessage(label: string, count: number): string {
  return `已經有 ${count} 位客戶是「${label}」這個場所類型,不能刪除。請先改掉那些客戶,或改成停用保留歷史`;
}

export function categoryInUseMessage(label: string, count: number): string {
  return `已經有 ${count} 位客戶是「${label}」這個商業分類,不能刪除。請先改掉那些客戶,或改成停用保留歷史`;
}

/** 保留管道不准刪。打卡與系統紀錄寫的就是它們,刪掉之後那些紀錄會指向不存在的管道 */
export function reservedChannelMessage(key: string): string {
  return `「${key}」是系統保留的互動管道(到訪打卡與系統紀錄會用到),不能刪除。可以改名稱與排序`;
}

/**
 * 保留階段不准刪,理由與保留管道同一條:它們綁著一段流程,不只是清單上的一列。
 *
 * 沒有這道守衛時最糟的一種情形是「全新安裝、還沒有客戶」:客戶數是 0,
 * 上面的引用檢查會放行,converted 與 dropped 被整組換掉。之後標記成交
 * (crm.service)與查重合併(crm-duplicates.service)照樣寫這兩個字面值進
 * dev_customers.stage,而 dev_stages 已經沒有對應的列 —— 那幾位客戶從看板消失、
 * 表單下拉也選不回來,而且不會有任何錯誤訊息。
 * 想換成自己行業的流程,把這兩個階段改名稱、改顏色、改排序都可以,刪不行。
 */
export function reservedStageMessage(key: string): string {
  return `「${key}」是系統保留的階段(標記成交與查重合併會寫入這個代碼),不能刪除。可以改名稱、顏色與排序`;
}

/**
 * 這一支在交易裡用得到的 Prisma 介面。用 Parameters 取 $transaction 回呼的參數型別,
 * 不自己列一份 model 清單 —— 列一份的話,加一張表就要記得回來補。
 */
type SettingsTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * 五張「可由後台增減」的主檔表。共用同一組讀寫,見 AppSettingsService.table。
 * 直接沿用墓碑表的 catalog 值:兩邊各寫一份字面值的話,漏改一個就會變成
 * 「刪了有記墓碑,但 seed 用另一個 catalog 查,所以照樣長回來」。
 */
type VocabTable = SeedCatalog;

/**
 * 四張主檔共通的讀寫介面。
 *
 * 為什麼要自己寫一份而不是直接用 Prisma 的 delegate 聯集:四個 delegate 的泛型簽章
 * 互不相容,聯集起來 TypeScript 判定「沒有一個簽章對得上」而整個不能呼叫。
 * 這裡只宣告這一支用得到的兩個動作與共通欄位,型別安全的邊界收在 table() 那一次轉型。
 */
interface VocabDelegate {
  findMany(args: {
    select: { key: true; label: true };
  }): Promise<Array<{ key: string; label: string }>>;
  upsert(args: {
    where: { key: string };
    create: { key: string; label: string; sortOrder: number; isActive: boolean };
    update: { label: string; sortOrder: number; isActive: boolean };
  }): Promise<unknown>;
}

@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);

  /**
   * StageCatalogService 用 @Optional:既有單元測試直接 new AppSettingsService(prisma, settings),
   * 沒帶就跳過快取清除(目錄自己有一秒的 TTL,行為與接上之前一致)。
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Optional() private readonly stageCatalog?: StageCatalogService,
  ) {}

  /**
   * 階段主檔剛被寫過,叫階段目錄下一次讀一定去查資料表。
   *
   * 為什麼需要:這一支改階段是直接寫 prisma,而 StageCatalogService 自己有一份
   * 短時快取。少了這一行,後台按下儲存之後那一秒內的請求(前端存完馬上重讀就是)
   * 拿到的還是舊的階段清單 —— 症狀是「存好了,畫面卻沒變」,重新整理又好了,
   * 沒有人查得出原因。TTL 只有一秒不代表這一行沒有用:它把「一定看得到自己剛存的東西」
   * 從碰運氣變成保證。
   */
  private invalidateStageCatalog(): void {
    this.stageCatalog?.invalidate();
  }

  private assertAdmin(role: string | null | undefined): void {
    if (role !== 'admin') throw new ForbiddenException('只有系統管理員可以修改系統設定');
  }

  private assertKey(key: string): string {
    const k = (key ?? '').trim();
    if (!SETTINGS_KEY_PATTERN.test(k)) throw new BadRequestException(KEY_FORMAT_MESSAGE);
    return k;
  }

  /** 完整設定(需登入即可讀:前端要拿階段清單畫看板) */
  async getAll(): Promise<AdminAppSettingsResponse> {
    const [
      settings,
      stages,
      photoKinds,
      channels,
      premisesTypes,
      categories,
      stageUsage,
      channelUsage,
      premisesTypeUsage,
      categoryUsage,
    ] = await Promise.all([
      this.settings.get(),
      this.listStageRows(),
      this.listPhotoKinds(),
      this.listVocabRows('channel'),
      this.listVocabRows('premises'),
      this.listVocabRows('category'),
      this.stageUsage(),
      this.channelUsage(),
      this.premisesTypeUsage(),
      this.categoryUsage(),
    ]);
    return {
      settings: toAppSettingsView(settings, stages, photoKinds, {
        channels,
        premisesTypes,
        categories,
      }),
      stageUsage,
      channelUsage,
      premisesTypeUsage,
      categoryUsage,
    };
  }

  /** 管道代碼 → 互動筆數。理由同 stageUsage:給刪除鈕當提示,真正的防線在存檔那段 */
  async channelUsage(): Promise<Record<string, number>> {
    try {
      const rows = (await this.prisma.devInteraction.groupBy({
        by: ['channel'],
        _count: { _all: true },
      } as never)) as unknown as Array<{ channel: string; _count: { _all: number } }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.channel] = r._count._all;
      return out;
    } catch {
      return {};
    }
  }

  /** 場所類型代碼 → 客戶數 */
  async premisesTypeUsage(): Promise<Record<string, number>> {
    try {
      const rows = (await this.prisma.devCustomer.groupBy({
        by: ['premisesType'],
        // 回收桶裡的不算「還有幾筆在用」:使用者把匯錯的三百筆整批刪掉之後,
        // 系統設定頁不該還寫著「還有 300 位客戶在用」,那句話跟畫面上其他地方都對不起來
        where: notDeletedWhere(),
        _count: { _all: true },
      } as never)) as unknown as Array<{ premisesType: string | null; _count: { _all: number } }>;
      const out: Record<string, number> = {};
      for (const r of rows) if (r.premisesType) out[r.premisesType] = r._count._all;
      return out;
    } catch {
      return {};
    }
  }

  /** 商業分類代碼 → 客戶數。分類欄位存的是文字,對不上主檔的舊值也照樣統計得到 */
  async categoryUsage(): Promise<Record<string, number>> {
    try {
      const rows = (await this.prisma.devCustomer.groupBy({
        by: ['category'],
        // 回收桶裡的不算「還有幾筆在用」:使用者把匯錯的三百筆整批刪掉之後,
        // 系統設定頁不該還寫著「還有 300 位客戶在用」,那句話跟畫面上其他地方都對不起來
        where: notDeletedWhere(),
        _count: { _all: true },
      } as never)) as unknown as Array<{ category: string | null; _count: { _all: number } }>;
      const out: Record<string, number> = {};
      for (const r of rows) if (r.category) out[r.category] = r._count._all;
      return out;
    } catch {
      return {};
    }
  }

  /**
   * 每個階段目前有幾位客戶。查不到就回空物件 ——
   * 這只是「刪除鈕能不能按」的提示,真正的防線在 updateAppSettings 交易裡的引用檢查。
   */
  async stageUsage(): Promise<Record<string, number>> {
    try {
      const rows = (await this.prisma.devCustomer.groupBy({
        by: ['stage'],
        // 回收桶裡的不算「還有幾筆在用」:使用者把匯錯的三百筆整批刪掉之後,
        // 系統設定頁不該還寫著「還有 300 位客戶在用」,那句話跟畫面上其他地方都對不起來
        where: notDeletedWhere(),
        _count: { _all: true },
      } as never)) as unknown as Array<{ stage: string; _count: { _all: number } }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.stage] = r._count._all;
      return out;
    } catch {
      return {};
    }
  }

  /**
   * 後台存檔:前端送整包 AppSettings 進來,這裡拆成五處寫入
   * (dev_stages、visit_photo_kinds、dev_interaction_channels、dev_premises_types、
   * system_settings id=1)。
   *
   * **整段在同一筆交易裡,而且交易開頭先取 advisory lock。** 兩件事缺一不可:
   *
   *   沒有交易:五處寫入各自成一筆,中間任何一句失敗(連線斷、值被擋下來),
   *   使用者只會看到一則錯誤,而資料庫留著「階段改了、照片種類還是舊的、
   *   檢查表根本沒寫」的中間狀態,從畫面上完全看不出來。
   *
   *   沒有鎖:刪除檢查是 check-then-act。管理員刪「報價中」的同一秒,
   *   業務把客戶拖進報價中 —— 檢查時 count=0 放行,刪除照樣成功,
   *   那位客戶的 stage 從此對不到任何一列,看板上直接消失。
   *   dev_customers.stage 與 dev_stages.key 之間沒有外鍵,資料庫不會幫忙擋。
   *   鎖只擋得住同樣走這條路徑的併發存檔,擋不住「別人正在改客戶」,
   *   所以刪除前的重查一定要在交易內做(見 assertRemovable)。
   */
  async updateAppSettings(
    role: string | null | undefined,
    userId: string,
    view: AppSettingsPatch,
  ): Promise<AdminAppSettingsResponse> {
    this.assertAdmin(role);
    this.assertLookupSettings(view);
    this.assertMapTileUrl(view.mapTileUrl);

    const stages = view.stages;
    const photoItems = view.photoChecklist;
    const channels = view.channels;
    const premisesTypes = view.premisesTypes;
    const categories = view.categories;

    // 純輸入檢查(不碰資料庫)先做完,明顯寫錯的請求不用開交易也不用排隊等鎖
    if (stages)
      this.assertUniqueKeys(
        stages.map((s) => this.assertKey(s.key)),
        '客戶階段',
      );
    if (photoItems)
      this.assertUniqueKeys(
        photoItems.map((p) => this.assertKey(p.key)),
        '照片種類',
      );
    if (channels)
      this.assertUniqueKeys(
        channels.map((c) => this.assertKey(c.key)),
        '互動管道',
      );
    if (premisesTypes) {
      this.assertUniqueKeys(
        premisesTypes.map((p) => this.assertKey(p.key)),
        '場所類型',
      );
    }
    if (categories) {
      this.assertUniqueKeys(
        categories.map((c) => this.assertKey(c.key)),
        '商業分類',
      );
    }
    // 空清單不是「清空」,是「把系統打回出廠預設而且畫面上看不出來」:
    // 後端讀不到任何一列時會退回出廠那幾筆,使用者看到的是「我刪光了怎麼又回來」。
    if (stages && stages.length === 0) throw new BadRequestException(emptyListMessage('客戶階段'));
    if (channels && channels.length === 0)
      throw new BadRequestException(emptyListMessage('互動管道'));
    if (premisesTypes && premisesTypes.length === 0) {
      throw new BadRequestException(emptyListMessage('場所類型'));
    }
    if (categories && categories.length === 0) {
      throw new BadRequestException(emptyListMessage('商業分類'));
    }

    await this.prisma.$transaction(
      async (tx) => {
        // 同一時間只有一個後台存檔進得來;交易結束自動釋放
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APP_SETTINGS_LOCK_KEY}::bigint)`;

        // ── 刪除檢查,全部在鎖內重查 ────────────────────────
        const removedStages = stages ? await this.rowsToRemove(tx, 'stage', stages) : [];
        for (const st of removedStages) {
          // 保留字先擋。客戶數為 0 時引用檢查會放行,所以這一句不能放在後面
          if (RESERVED_STAGE_KEYS.includes(st.key)) {
            throw new ConflictException(reservedStageMessage(st.key));
          }
          const used = await tx.devCustomer.count({
            where: { stage: st.key, ...notDeletedWhere() },
          });
          if (used > 0) throw new ConflictException(stageInUseMessage(st.label, used));
        }
        const removedKinds = photoItems ? await this.rowsToRemove(tx, 'photoKind', photoItems) : [];
        for (const k of removedKinds) {
          const used = await tx.devVisitPhoto.count({ where: { kind: k.key } });
          if (used > 0) throw new ConflictException(photoKindInUseMessage(k.label, used));
        }
        const removedChannels = channels ? await this.rowsToRemove(tx, 'channel', channels) : [];
        for (const c of removedChannels) {
          if (RESERVED_CHANNEL_KEYS.includes(c.key)) {
            throw new ConflictException(reservedChannelMessage(c.key));
          }
          const used = await tx.devInteraction.count({ where: { channel: c.key } });
          if (used > 0) throw new ConflictException(channelInUseMessage(c.label, used));
        }
        const removedPremises = premisesTypes
          ? await this.rowsToRemove(tx, 'premises', premisesTypes)
          : [];
        for (const p of removedPremises) {
          const used = await tx.devCustomer.count({
            where: { premisesType: p.key, ...notDeletedWhere() },
          });
          if (used > 0) throw new ConflictException(premisesTypeInUseMessage(p.label, used));
        }
        const removedCategories = categories
          ? await this.rowsToRemove(tx, 'category', categories)
          : [];
        for (const c of removedCategories) {
          const used = await tx.devCustomer.count({
            where: { category: c.key, ...notDeletedWhere() },
          });
          if (used > 0) throw new ConflictException(categoryInUseMessage(c.label, used));
        }

        // ── 開始寫 ──────────────────────────────────────────
        // 每一組都是「留下來的清掉墓碑 → 寫入 → 記墓碑 → 刪除」。
        // 記墓碑那一步不能省:出廠 seed 每次開機都跑,沒有墓碑的話這裡刪掉的
        // 出廠代碼會在下一次重啟時原樣長回來(見 markSeedTombstones)。
        if (stages) {
          await this.clearSeedTombstones(
            tx,
            'stage',
            stages.map((x) => x.key.trim()),
          );
          await this.syncStages(tx, stages);
        }
        await this.markSeedTombstones(
          tx,
          'stage',
          removedStages.map((r) => r.key),
        );
        for (const st of removedStages) await tx.devStage.delete({ where: { key: st.key } });
        if (photoItems) {
          await this.clearSeedTombstones(
            tx,
            'photoKind',
            photoItems.map((x) => x.key.trim()),
          );
          await this.syncPhotoKinds(tx, photoItems);
        }
        await this.markSeedTombstones(
          tx,
          'photoKind',
          removedKinds.map((r) => r.key),
        );
        for (const k of removedKinds) await tx.visitPhotoKind.delete({ where: { key: k.key } });
        if (channels) {
          await this.clearSeedTombstones(
            tx,
            'channel',
            channels.map((x) => x.key.trim()),
          );
          await this.syncVocab(tx, 'channel', channels);
        }
        await this.markSeedTombstones(
          tx,
          'channel',
          removedChannels.map((r) => r.key),
        );
        for (const c of removedChannels) {
          await tx.devInteractionChannel.delete({ where: { key: c.key } });
        }
        if (premisesTypes) {
          await this.clearSeedTombstones(
            tx,
            'premises',
            premisesTypes.map((x) => x.key.trim()),
          );
          await this.syncVocab(tx, 'premises', premisesTypes);
        }
        await this.markSeedTombstones(
          tx,
          'premises',
          removedPremises.map((r) => r.key),
        );
        for (const p of removedPremises) await tx.devPremisesType.delete({ where: { key: p.key } });
        if (categories) {
          await this.clearSeedTombstones(
            tx,
            'category',
            categories.map((x) => x.key.trim()),
          );
          await this.syncVocab(tx, 'category', categories);
        }
        await this.markSeedTombstones(
          tx,
          'category',
          removedCategories.map((r) => r.key),
        );
        for (const c of removedCategories) await tx.devCategory.delete({ where: { key: c.key } });

        const patch = toSettingsPatch(view);
        // 檢查表的對照表由清單重算,不接受前端直接送 —— 兩種形狀只有一個寫入點。
        // 「所有場所」要展開成哪幾個,以這一刻交易裡的場所類型主檔為準。
        //
        // 只改場所類型(沒送 photoChecklist)也要重算:不重算的話,新增的場所類型
        // 在對照表裡連 key 都沒有,而成交守衛看到「這個場所查不到必拍清單」時
        // 會擋下來並要求先設定 —— 使用者的感受是「我明明加好了卻結不了案」。
        // 重算的來源是既有的照片種類設定(每一項要在哪些場所拍),所以不會覆寫任何人的勾選。
        const checklistItems =
          photoItems ?? (premisesTypes ? await this.photoCheckItems(tx) : null);
        if (checklistItems) {
          patch.photoChecklist = toPhotoChecklistMap(
            normalizeItems(checklistItems),
            await this.placeTypeKeys(tx),
          );
        }
        // 傳 tx 進去:設定寫入與上面那幾張表在同一條連線、同一筆交易,
        // 失敗時一起回滾,也不會多借一條連線去卡連線池
        await this.settings.update(true, userId, patch, tx);
      },
      { timeout: 30_000, maxWait: 20_000 },
    );

    this.invalidateStageCatalog();
    this.logger.log(`[app-settings] 設定已更新 by ${userId},欄位 ${Object.keys(view).length} 項`);
    return this.getAll();
  }

  /**
   * 「所有場所」展開成哪幾個場所類型。以 dev_premises_types 為準,
   * 讀不到(遷移還沒跑完)才退回出廠那兩個 —— 這裡回空陣列的話,
   * 必拍設定會被算成一片空白,結案檢查等於整個關掉。
   */
  /**
   * 目前的照片存證檢查表清單形狀(代碼、名稱、要在哪些場所拍)。
   *
   * 只改場所類型時要拿它重算對照表。來源是 visit_photo_kinds 主檔加上
   * 目前的 photoChecklist:兩者合起來就是後台那一頁看到的樣子,
   * 所以重算的結果與使用者剛才看到的勾選一致。
   */
  private async photoCheckItems(tx: SettingsTx): Promise<PhotoCheckItemView[]> {
    const [kinds, settings] = await Promise.all([
      tx.visitPhotoKind.findMany({
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true, label: true, sortOrder: true, isActive: true },
      }),
      this.settings.get(),
    ]);
    const checklist = settings.photoChecklist ?? {};
    return (kinds as PhotoKindRow[])
      .filter((k) => k.isActive)
      .map((k) => {
        const placeTypes = Object.entries(checklist)
          .filter(([, list]) => Array.isArray(list) && list.includes(k.key))
          .map(([place]) => place)
          .sort();
        return { key: k.key, label: k.label, required: placeTypes.length > 0, placeTypes };
      });
  }

  private async placeTypeKeys(tx: SettingsTx): Promise<string[]> {
    try {
      const rows = await tx.devPremisesType.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        select: { key: true },
      });
      if (rows.length > 0) return rows.map((r: { key: string }) => r.key);
    } catch {
      // 讀不到主檔就用出廠預設
    }
    return [...DEFAULT_PLACE_TYPES];
  }

  /**
   * 外部查詢帶入的設定檢查。
   *
   * 網址樣板是**伺服器**待會要去打的位址,所以它的合法性是安全邊界而不是欄位格式:
   * 只准 https、不准帶帳號密碼、不准指向本機或私有網段(見 lookup/lookup-url.ts)。
   * 擋在存檔這一刻,而不是等到有人按查詢才失敗 —— 後者的症狀是
   * 「後台存好了,但業務按查詢一直說查詢失敗」,從畫面上看不出原因。
   *
   * 只在「這次要打開查詢」或「這次有送網址樣板」時檢查:
   * 關著的時候允許把樣板留空,不然一個沒設定過的系統連存別的設定都會被擋下來。
   */
  private assertLookupSettings(view: AppSettingsPatch): void {
    const template = view.lookupUrlTemplate;
    if (template !== undefined && template.trim() !== '') {
      const check = checkLookupUrlTemplate(template);
      if (!check.ok) throw new BadRequestException(check.message);
    }
    if (view.lookupEnabled === true && template !== undefined && template.trim() === '') {
      throw new BadRequestException('要啟用外部查詢帶入,必須先填查詢網址樣板');
    }
    const pattern = view.lookupPattern;
    if (pattern !== undefined && pattern.trim() !== '') {
      // 先看安全性再看語法:安全性不過的訊息說得出「為什麼不行」,
      // 而它在語法上是合法的,先跑 compile 只會通過然後放行一條會卡死服務的式子。
      const safety = checkLookupPatternSafety(pattern);
      if (!safety.ok) throw new BadRequestException(safety.message);
      if (compileLookupPattern(pattern) === null) {
        throw new BadRequestException(
          '識別碼格式不是合法的正規表示式。留空代表不限制格式,例如八位數字請填 \\d{8}',
        );
      }
    }
  }

  /**
   * 地圖圖磚網址。留空 = 用出廠的公共圖磚,所以空字串一律放行。
   *
   * 有填就要真的是一條圖磚樣板:三個座標佔位符缺一個,地圖上就是整片灰底,
   * 而畫面不會有任何錯誤 —— 圖磚是使用者的瀏覽器去要的,後端看不到那些 404。
   * 協定限 http / https:這一格會原樣變成 <img> 的來源,javascript: 與 data:
   * 不該進得來。
   */
  private assertMapTileUrl(url: string | undefined): void {
    if (url === undefined) return;
    const value = url.trim();
    if (value === '') return;
    if (!/^https?:\/\//i.test(value)) {
      throw new BadRequestException('地圖圖磚網址要以 http:// 或 https:// 開頭,留空則用預設圖磚');
    }
    const missing = ['{z}', '{x}', '{y}'].filter((token) => !value.includes(token));
    if (missing.length > 0) {
      throw new BadRequestException(
        `地圖圖磚網址少了座標佔位符 ${missing.join('、')},例如 https://tile.example.com/{z}/{x}/{y}.png`,
      );
    }
  }

  private assertUniqueKeys(keys: readonly string[], what: string): void {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) throw new BadRequestException(`${what}的代碼重複:${k}`);
      seen.add(k);
    }
  }

  /**
   * 記下「這幾個代碼是被刻意刪掉的」。
   *
   * 為什麼一定要記:五張主檔的出廠 seed 每次開機都跑,而且是
   * `INSERT ... ON CONFLICT (key) DO NOTHING` —— 對「已經被刪掉」的 key 來說
   * ON CONFLICT 不會命中,整列會用出廠值重新插回來。少了這一格,
   * 管理員刪掉的階段(例如「報價中」)在下一次平台重啟之後自己回到看板上,
   * 存檔那一刻完全正常,也不會有任何錯誤訊息或日誌可以循線找原因。
   *
   * 呼叫順序刻意排在真正的 delete 之前:兩者之間出事時,
   * 「有墓碑但列還在」是無害的(seed 本來就會因為 ON CONFLICT 跳過那一列),
   * 「列刪掉了但沒有墓碑」才是這個 bug 本身。
   *
   * 自己新增的代碼寫進墓碑也沒有副作用:seed 裡沒有那個 key,查了也不會用到。
   */
  private async markSeedTombstones(
    db: Pick<SettingsTx, 'seedTombstone'>,
    catalog: SeedCatalog,
    keys: readonly string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    await db.seedTombstone.createMany({
      data: keys.map((key) => ({ catalog, key })),
      skipDuplicates: true,
    });
  }

  /**
   * 把墓碑清掉。管理員自己把同一個代碼加回來(或這次送來的清單裡還有它)時要做,
   * 不然那個 key 會永遠被排除在出廠 seed 之外 —— 對已經存在的列來說看不出差別,
   * 但之後真的又刪掉一次時,「刪了還原、還原再刪」的狀態就跟墓碑對不上了。
   */
  private async clearSeedTombstones(
    db: Pick<SettingsTx, 'seedTombstone'>,
    catalog: SeedCatalog,
    keys: readonly string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    await db.seedTombstone.deleteMany({ where: { catalog, key: { in: [...keys] } } });
  }

  /**
   * 資料庫上有、這次送來的清單裡沒有的那幾列 = 這次要刪掉的。
   *
   * 一定要用交易客戶端讀:鎖外讀的那一份可能已經被別的存檔改掉,
   * 而接下來的刪除是照這一份清單做的。
   */
  private async rowsToRemove(
    tx: SettingsTx,
    which: VocabTable,
    next: ReadonlyArray<{ key: string }>,
  ): Promise<Array<{ key: string; label: string }>> {
    const keep = new Set(next.map((s) => s.key.trim()));
    const rows = await this.table(tx, which).findMany({ select: { key: true, label: true } });
    return rows.filter((r) => !keep.has(r.key));
  }

  /**
   * 四張主檔表共用同一組讀寫。分開寫四份的話,加一張表就多一份會走散的邏輯 ——
   * 而這正是「互動管道」當初沒被做成設定的原因。
   */
  private table(tx: SettingsTx, which: VocabTable): VocabDelegate {
    switch (which) {
      case 'stage':
        return tx.devStage as unknown as VocabDelegate;
      case 'photoKind':
        return tx.visitPhotoKind as unknown as VocabDelegate;
      case 'channel':
        return tx.devInteractionChannel as unknown as VocabDelegate;
      case 'premises':
        return tx.devPremisesType as unknown as VocabDelegate;
      case 'category':
        return tx.devCategory as unknown as VocabDelegate;
    }
  }

  /**
   * 把清單寫進 dev_stages。排序照清單順序(看板由左到右就是這個順序),
   * key 已存在就只改顯示欄位 —— key 是客戶資料裡的值,永遠不動。
   */
  private async syncStages(
    tx: SettingsTx,
    stages: ReadonlyArray<Partial<StageView> & { key: string }>,
  ): Promise<void> {
    for (const [index, s] of stages.entries()) {
      const key = this.assertKey(s.key);
      const data = {
        label: (s.label ?? '').trim() || key,
        color: (s.color ?? '').trim() || null,
        sortOrder: (index + 1) * 10,
        isActive: true,
        isTerminal: s.terminal ?? false,
        showOnBoard: s.board ?? true,
        showInForm: s.form ?? true,
      };
      await tx.devStage.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    }
  }

  private async syncPhotoKinds(
    tx: SettingsTx,
    items: ReadonlyArray<Partial<PhotoCheckItemView> & { key: string }>,
  ): Promise<void> {
    for (const [index, p] of items.entries()) {
      const key = this.assertKey(p.key);
      const data = {
        label: (p.label ?? '').trim() || key,
        sortOrder: (index + 1) * 10,
        isActive: true,
      };
      await tx.visitPhotoKind.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    }
  }

  /**
   * 互動管道 / 場所類型寫回主檔。排序照清單順序,key 已存在就只改名稱。
   * key 不動的理由同階段:它是已經寫進 dev_interactions.channel 與
   * dev_customers.premises_type 的資料值,改了那些列就指向不存在的一筆。
   */
  private async syncVocab(
    tx: SettingsTx,
    which: VocabTable,
    items: ReadonlyArray<Partial<VocabItemView> & { key: string }>,
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      const key = this.assertKey(item.key);
      const data = {
        label: (item.label ?? '').trim() || key,
        sortOrder: (index + 1) * 10,
        isActive: true,
      };
      await this.table(tx, which).upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    }
  }

  /** 主檔的原始列(給 view 轉換與後台清單用) */
  private async listVocabRows(which: 'channel' | 'premises' | 'category'): Promise<VocabRow[]> {
    const args = {
      orderBy: [{ sortOrder: 'asc' as const }, { key: 'asc' as const }],
      select: {
        key: true as const,
        label: true as const,
        sortOrder: true as const,
        isActive: true as const,
      },
    };
    try {
      const rows =
        which === 'channel'
          ? await this.prisma.devInteractionChannel.findMany(args)
          : which === 'premises'
            ? await this.prisma.devPremisesType.findMany(args)
            : await this.prisma.devCategory.findMany(args);
      return rows as VocabRow[];
    } catch {
      return [];
    }
  }

  /** 階段主檔的原始列(給 view 轉換用,含顯示開關) */
  private async listStageRows(): Promise<StageRow[]> {
    const rows = await this.prisma.devStage.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      select: {
        key: true,
        label: true,
        color: true,
        sortOrder: true,
        isActive: true,
        isTerminal: true,
        showOnBoard: true,
        showInForm: true,
      },
    });
    return rows as StageRow[];
  }

  /** 寫入設定(admin only)。只覆蓋帶進來的欄位,其餘原封不動 */
  async updateSettings(
    role: string | null | undefined,
    userId: string,
    patch: Partial<SystemSettingsData>,
  ): Promise<SystemSettingsData> {
    this.assertAdmin(role);
    if (patch.photoChecklist !== undefined) {
      await this.assertChecklistValid(patch.photoChecklist);
    }
    return this.settings.update(true, userId, patch);
  }

  /**
   * 檢查表裡的照片類型代碼必須真的存在而且啟用中。
   *
   * 不擋的話,打錯一個字就會產生一個永遠補不齊的必備項目:業務怎麼拍都拍不到那一種,
   * 客戶就永遠結不了案,而畫面上只顯示「還缺 xxx」,看不出來是設定打錯字。
   */
  private async assertChecklistValid(checklist: Record<string, string[]>): Promise<void> {
    // 先驗場所代碼:只驗照片代碼的話,對照表可以留下一個已經刪掉的場所,
    // 而那一列永遠不會有人看到,也永遠不會被清掉。
    // 「存在的場所在對照表裡沒有 key」則由兩個地方一起顧:updateAppSettings 只改
    // 場所類型時會重算對照表,成交守衛看到查不到清單一律擋下(見 convertBlockReason)。
    const places = Object.keys(checklist);
    for (const place of places) {
      if (!SETTINGS_KEY_PATTERN.test(place)) {
        throw new BadRequestException(`照片存證檢查表裡的場所代碼格式錯誤:${String(place)}`);
      }
    }
    const knownPlaces = await this.prisma.devPremisesType.findMany({
      where: { isActive: true },
      select: { key: true },
    });
    const activePlaces = new Set(knownPlaces.map((r: { key: string }) => r.key));
    if (activePlaces.size > 0) {
      const unknownPlaces = places.filter((p) => !activePlaces.has(p));
      if (unknownPlaces.length) {
        throw new BadRequestException(
          `照片存證檢查表用到不存在或已停用的場所類型:${unknownPlaces.join('、')}`,
        );
      }
    }

    const wanted = [...new Set(Object.values(checklist).flat())];
    if (wanted.length === 0) return;
    for (const key of wanted) {
      if (typeof key !== 'string' || !SETTINGS_KEY_PATTERN.test(key)) {
        throw new BadRequestException(`照片存證檢查表裡的代碼格式錯誤:${String(key)}`);
      }
    }
    const rows = await this.prisma.visitPhotoKind.findMany({
      where: { key: { in: wanted }, isActive: true },
      select: { key: true },
    });
    const known = new Set(rows.map((r: { key: string }) => r.key));
    const unknown = wanted.filter((k) => !known.has(k));
    if (unknown.length) {
      throw new BadRequestException(
        `照片存證檢查表用到不存在或已停用的照片種類:${unknown.join('、')}`,
      );
    }
  }

  // ── 存證照片種類 ──────────────────────────────────────────

  async listPhotoKinds(): Promise<VisitPhotoKindView[]> {
    return this.prisma.visitPhotoKind.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      select: { id: true, key: true, label: true, sortOrder: true, isActive: true },
    });
  }
}
