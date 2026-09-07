/**
 * 拜訪打卡存證服務:寫 visit 互動(伺服器時間)、算與客戶地址距離、假定位偵測、多張照片存證、
 * 補拍、依場所類型盤點缺少的存證類型、刪照片。
 * 存取範圍與 CrmService 一致:業務只能對自己的客戶(ownerId)打卡,訪查主管 / admin 看全部。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { canSeeOwner, type ViewScope } from '../../scope/view-scope';
import { createHash } from 'node:crypto';
import { formatOrgStamp, orgDayRange, orgToday, resolveTimeZone } from '@mitchcrm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { OrgTimeService } from '../../settings/org-time.service';
import { lockCustomerRow, lockUserUploadQuota } from '../lock';
import { relatedLiveCustomerFilter } from '../crm-scope-filters';
import { CUSTOMER_NOT_FOUND_MESSAGE, MERGED_CUSTOMER_MESSAGE } from '../crm-messages';
import { pickAddress } from '../map/crm-geo.service';
import { markVisitPlanDone } from '../visit-plans/visit-plan-done';
import type { AddPhotosDto, CheckinDto, CheckinPhotoDto } from './dto/checkin.dto';
import { PHOTO_MIMES } from './dto/checkin.dto';
import {
  PHOTOS_MAX_COUNT,
  PHOTOS_TOTAL_MAX_BYTES,
  PHOTO_MAX_BYTES,
  SUSPICIOUS_CLOCK_SKEW_MS,
  SUSPICIOUS_PREV_WINDOW_MS,
  ADDRESS_CHANGE_WINDOW_MS,
  SYSTEM_NOTE_PREFIX,
  appendCompareAddress,
  VISIT_PHOTO_KIND_LABEL,
  DEFAULT_PHOTO_CHECKLIST,
  type PhotoChecklist,
  customerPhotoQuotaError,
  customerPhotoOverQuota,
  customerPhotoOverQuotaNotice,
  CUSTOMER_PHOTOS_MAX_COUNT,
  CUSTOMER_PHOTOS_MAX_BYTES,
  userDailyUploadQuotaError,
  detectSuspicion,
  hasTimezone,
  haversineM,
  isTakenAtWithinRange,
  matchesMagic,
  missingPhotoKinds,
  noCoordinateVerdict,
  requiredPhotoKinds,
  stripBase64,
  systemPrefixBlockReason,
  type VisitPhotoKindValue,
} from './checkin-rules';
import { SETTINGS_KEY_PATTERN } from '../../app-settings/app-settings.view';
import {
  DEFAULT_STAGE_CATALOG,
  StageCatalogService,
  WON_STAGE_KEY,
  arrivalAdvanceOf,
} from '../../app-settings/stage-catalog.service';
import { VISIT_CHANNEL_KEY } from '@mitchcrm/shared';

export interface CheckinResult {
  interactionId: string;
  distanceM: number | null;
  suspicious: boolean;
  suspiciousReason: string | null;
  photoIds: string[];
  serverTime: string;
}

export interface RecentRow {
  id: string;
  customerId: string;
  companyName: string;
  userName: string;
  occurredAt: string;
  distanceM: number | null;
  gpsSuspicious: boolean;
  gpsSuspiciousReason: string | null;
  photoCount: number;
}

export interface PhotoListItem {
  id: string;
  kind: string;
  takenAt: string;
  interactionId: string;
  byName: string;
  sizeBytes: number;
}

/**
 * 這位客戶的存證照片配額現況,連同清單一起回給客戶卡。
 *
 * 為什麼要回:超額只可能來自查重合併(見 checkin-rules 的 customerPhotoOverQuota),
 * 而超額的客戶按下補拍才會被擋 —— 那時候才知道就太晚了。把現況與說明一起回來,
 * 客戶卡就能在照片區直接寫出「這一筆因為合併而超額,新的補拍會被擋下」。
 * notice 為 null 表示沒有超額,前端不顯示任何東西。
 */
export interface PhotoQuotaInfo {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
  over: boolean;
  overCount: number;
  overBytes: number;
  notice: string | null;
}

export interface PhotoListResult {
  premisesType: string | null;
  premisesTypeMissing: boolean;
  required: VisitPhotoKindValue[];
  photos: PhotoListItem[];
  missing: VisitPhotoKindValue[];
  quota: PhotoQuotaInfo;
}

interface ValidatedPhoto {
  kind: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
  takenAt: Date;
}

/**
 * 以組織時區顯示「YYYY-MM-DD HH:mm (GMT+8)」,給系統互動 note 用。
 * 帶時區標示是刻意的:存證紀錄跨時區時,只寫「14:30」看的人無從判斷是誰的 14:30。
 */
function formatStamp(d: Date, tz: string): string {
  return formatOrgStamp(d, tz, { seconds: false });
}

/** 照片類型代碼的格式(與 app-settings 的 key 規則一致) */
/** 代碼格式與後台設定、前端用的是同一條規則(見 app-settings.view) */
const KIND_KEY_RE = SETTINGS_KEY_PATTERN;

@Injectable()
export class CrmCheckinService {
  /**
   * SettingsService 用 @Optional:既有單元測試直接 new CrmCheckinService(prisma),
   * 沒帶就退回 checkin-rules 的出廠檢查表,行為與可設定之前一致。
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly stageCatalog?: StageCatalogService,
    @Optional() private readonly orgTime?: OrgTimeService,
  ) {}

  /** 組織設定的時區;沒注入 OrgTimeService(單元測試直接 new)就退回出廠時區 */
  private async timeZone(): Promise<string> {
    return this.orgTime ? this.orgTime.timeZone() : resolveTimeZone(null);
  }

  /** 目前採用的照片存證檢查表:先看系統設定,讀不到就用出廠預設 */
  private async photoChecklist(): Promise<PhotoChecklist> {
    if (!this.settings) return DEFAULT_PHOTO_CHECKLIST;
    try {
      const s = await this.settings.get();
      const list = s.photoChecklist;
      if (list && typeof list === 'object') return list;
    } catch {
      // 讀不到設定就用出廠預設,不要讓打卡整個停掉
    }
    return DEFAULT_PHOTO_CHECKLIST;
  }

  /**
   * 照片類型必須是 visit_photo_kinds 裡啟用中的代碼。
   * 格式在 validatePhoto 已經擋過一次,這裡擋的是「格式對但沒這個類型」——
   * 不擋的話,打錯字的代碼會被存進去,而那張照片永遠不會被任何檢查表算到。
   */
  private async assertKindsExist(kinds: readonly string[]): Promise<void> {
    const uniq = [...new Set(kinds)];
    if (uniq.length === 0) return;
    const rows = await this.prisma.visitPhotoKind.findMany({
      where: { key: { in: uniq }, isActive: true },
      select: { key: true },
    });
    const known = new Set(rows.map((r: { key: string }) => r.key));
    const unknown = uniq.filter((k) => !known.has(k));
    if (unknown.length) {
      throw new BadRequestException(`照片類型不在允許清單內:${unknown.join('、')}`);
    }
  }

  /** 解碼、驗大小、驗 mime 白名單與 magic bytes、拍攝時間落在伺服器 ±24 小時內;不符一律 400 中文訊息 */
  private validatePhoto(p: CheckinPhotoDto, idx: number, serverTime: Date): ValidatedPhoto {
    const at = `第 ${idx + 1} 張`;
    if (!KIND_KEY_RE.test(p.kind)) {
      throw new BadRequestException(`${at}照片類型代碼格式錯誤`);
    }
    if (!(PHOTO_MIMES as readonly string[]).includes(p.mime)) {
      throw new BadRequestException(`${at}照片格式僅接受 JPEG、WebP 或 PNG`);
    }
    const b64 = stripBase64(p.base64);
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new BadRequestException(`${at}照片資料不是有效的 base64`);
    }
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) throw new BadRequestException(`${at}照片內容是空的`);
    if (bytes.length > PHOTO_MAX_BYTES) {
      throw new BadRequestException(`${at}照片超過大小上限(600KB),請在手機端縮圖後再上傳`);
    }
    if (!matchesMagic(p.mime, bytes)) {
      throw new BadRequestException(`${at}照片檔頭與宣告的格式不符,請重新拍照上傳`);
    }
    if (!hasTimezone(p.takenAt)) throw new BadRequestException(`${at}照片拍攝時間必須含時區`);
    const takenAt = new Date(p.takenAt);
    if (Number.isNaN(takenAt.getTime())) throw new BadRequestException(`${at}照片拍攝時間格式錯誤`);
    if (!isTakenAtWithinRange(takenAt, serverTime)) {
      throw new BadRequestException(`${at}照片拍攝時間異常,與伺服器時間相差超過 24 小時`);
    }
    return {
      kind: p.kind,
      mime: p.mime,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      takenAt,
    };
  }

  /** 整批驗:張數、每張、總量 */
  private validatePhotos(list: CheckinPhotoDto[] | undefined, serverTime: Date): ValidatedPhoto[] {
    if (!list || list.length === 0) return [];
    if (list.length > PHOTOS_MAX_COUNT) {
      throw new BadRequestException(`一次最多上傳 ${PHOTOS_MAX_COUNT} 張照片`);
    }
    const out = list.map((p, i) => this.validatePhoto(p, i, serverTime));
    const total = out.reduce((s, p) => s + p.bytes.length, 0);
    if (total > PHOTOS_TOTAL_MAX_BYTES) {
      throw new BadRequestException('照片總量超過 3MB,請減少張數或縮圖後再上傳');
    }
    return out;
  }

  /** 交易內先把客戶列鎖住(FOR UPDATE),同一客戶的打卡 / 補拍 / 刪照片 / 標記成交就會排隊;實作在 ../lock.ts,與 CrmService 共用 */
  private lockCustomerRow(tx: Pick<PrismaService, '$queryRaw'>, customerId: string): Promise<void> {
    return lockCustomerRow(tx, customerId);
  }

  /**
   * 客戶累計照片配額:count + aggregate(sizeBytes)決定能不能寫,超過回 400 中文。
   * 呼叫端要先在同一交易內 lockCustomerRow,兩個請求才不會同時通過檢查後各自寫入。
   */
  private async assertCustomerPhotoQuota(
    tx: Pick<PrismaService, 'devVisitPhoto'>,
    customerId: string,
    photos: ValidatedPhoto[],
  ): Promise<void> {
    if (photos.length === 0) return;
    const [count, agg] = await Promise.all([
      tx.devVisitPhoto.count({ where: { customerId } }),
      tx.devVisitPhoto.aggregate({ where: { customerId }, _sum: { sizeBytes: true } }),
    ]);
    const err = customerPhotoQuotaError(
      { count, bytes: agg._sum.sizeBytes ?? 0 },
      { count: photos.length, bytes: photos.reduce((s, p) => s + p.bytes.length, 0) },
    );
    if (err) throw new BadRequestException(err);
  }

  /**
   * 每位使用者每天(組織時區的日曆日)的累計上傳位元組。
   *
   * 為什麼客戶配額不夠:那三層全部以客戶為單位,而建客戶只吃預設的請求額度。
   * 一個帳號一直建新客戶、每個各塞 20MB,總量就沒有上限 —— 上傳端點每分鐘 10 次
   * 乘每次 3MB,一分鐘穩定寫入 30MB,約 43GB/天。照片存在 Postgres,
   * 而刪除路徑對已結案客戶是擋住的,清理要 DBA 進場。
   *
   * 算法:照片本身沒有上傳者欄位,但每一張都掛在一筆互動上,互動有記錄者(userId),
   * 所以直接沿著關聯算。時間邊界用組織時區的「今天」,與逾期、日報、
   * 地圖的「今天要拜訪」同一個口徑(裝置時區不算數)。
   *
   * 併發:呼叫端要先在同一交易內 lockUserUploadQuota(tx, userId)。
   * 只靠 lockCustomerRow 是不夠的 —— 那把鎖以客戶為單位,同一個人同時對兩個
   * 不同客戶上傳時,兩筆交易鎖的是兩列不同的客戶,各自讀到「今天還沒超過」
   * 而各自寫入,總量因此可以超出上限。
   */
  private async assertUserDailyUploadQuota(
    tx: Pick<PrismaService, 'devVisitPhoto'>,
    userId: string,
    photos: ValidatedPhoto[],
  ): Promise<void> {
    if (photos.length === 0) return;
    const { start, endExclusive } = orgDayRange(new Date(), await this.timeZone());
    const agg = await tx.devVisitPhoto.aggregate({
      where: { interaction: { userId }, createdAt: { gte: start, lt: endExclusive } },
      _sum: { sizeBytes: true },
    });
    const err = userDailyUploadQuotaError(
      agg._sum.sizeBytes ?? 0,
      photos.reduce((sum, p) => sum + p.bytes.length, 0),
    );
    if (err) throw new BadRequestException(err);
  }

  /** 找客戶並套用可見範圍;不存在與無權限都回 404,不洩漏客戶是否存在;已合併的回 400 並帶保留筆 id */
  private async loadCustomer(customerId: string, userId: string, view: ViewScope) {
    const customer = await this.prisma.devCustomer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        ownerId: true,
        stage: true,
        lat: true,
        lng: true,
        createdAt: true,
        mergedIntoId: true,
        deletedAt: true,
        premisesType: true,
        actualAddress: true,
        registeredAddress: true,
        contactAddress: true,
      },
    });
    // 已刪除的客戶跟不存在一樣回 404:它不在任何清單上,也不該還能被打卡 / 補拍。
    // 要救回來請管理員到回收桶還原(見 crm/deletion)。
    if (!customer || customer.deletedAt || !canSeeOwner(view, customer.ownerId)) {
      throw new NotFoundException(CUSTOMER_NOT_FOUND_MESSAGE);
    }
    if (customer.mergedIntoId) {
      // 這一支是「要打卡 / 要拍照」的入口,不是客戶卡:使用者要的是換一筆客戶,
      // 不是跳到保留的那一筆去看資料,所以這裡只回訊息不帶 id。
      // 客戶卡(CrmService.get)才會帶 mergedIntoId,口徑寫在 crm-messages.ts。
      throw new BadRequestException(MERGED_CUSTOMER_MESSAGE);
    }
    return customer;
  }

  async checkin(
    customerId: string,
    userId: string,
    view: ViewScope,
    dto: CheckinDto,
  ): Promise<CheckinResult> {
    const serverTime = new Date();
    // 打卡屬於組織時區的哪一天(排程核銷要用);設定讀不到就退回出廠時區
    const checkinDay = orgToday(serverTime, await this.timeZone());
    const customer = await this.loadCustomer(customerId, userId, view);

    if (!hasTimezone(dto.clientTime)) throw new BadRequestException('打卡時間必須含時區');
    const clientTime = new Date(dto.clientTime);
    if (Number.isNaN(clientTime.getTime())) throw new BadRequestException('打卡時間格式錯誤');
    if (dto.nextFollowUpAt && !hasTimezone(dto.nextFollowUpAt)) {
      throw new BadRequestException('下次追蹤時間必須含時區');
    }
    const nextFollowUpAt = dto.nextFollowUpAt ? new Date(dto.nextFollowUpAt) : null;
    if (nextFollowUpAt && Number.isNaN(nextFollowUpAt.getTime())) {
      throw new BadRequestException('下次追蹤時間格式錯誤');
    }
    // 備註前綴規則與手動互動共用(去零寬字元與空白後不可以【開頭)
    const noteBlocked = systemPrefixBlockReason(dto.note);
    if (noteBlocked) throw new BadRequestException(noteBlocked);

    // 照片先驗完再寫 DB,避免半筆資料
    const photos = this.validatePhotos(dto.photos, serverTime);
    await this.assertKindsExist(photos.map((p) => p.kind));

    const hasCoordinate = typeof customer.lat === 'number' && typeof customer.lng === 'number';
    const distanceM = hasCoordinate
      ? haversineM(customer.lat as number, customer.lng as number, dto.lat, dto.lng)
      : null;

    // 同一使用者最近一次有座標的拜訪(channel=visit 且 gpsLat / gpsLng 不為 null,2 小時內)→ 換算移動速度。
    // channel=visit 只有打卡流程會寫(手動互動擋 visit),所以不用再看 gpsAccuracy;補拍是 note 也不會混進來。
    const prev = await this.prisma.devInteraction.findFirst({
      where: {
        userId,
        channel: VISIT_CHANNEL_KEY,
        gpsLat: { not: null },
        gpsLng: { not: null },
        occurredAt: { gte: new Date(serverTime.getTime() - SUSPICIOUS_PREV_WINDOW_MS) },
      },
      orderBy: { occurredAt: 'desc' },
      select: { gpsLat: true, gpsLng: true, occurredAt: true },
    });

    // 24 小時規則(不看 geocodedAt):客戶 24 小時內有【地址變更】或【合併】互動時,
    // 這次打卡的距離比對不可信,標可疑並寫理由。地址是不是剛被改成打卡地點,主管看時間軸就能對。
    // 「建檔不到 24 小時且尚無座標」那一條已經拿掉(地理編碼出廠不啟用,新客戶必然沒有座標,
    // 等於每一位新客戶的第一次到訪都亮紅燈),理由見 checkin-rules 的 NOTE_NO_COORDINATE。
    const recentSystemNotes = await this.prisma.devInteraction.findMany({
      where: {
        customerId,
        occurredAt: { gte: new Date(serverTime.getTime() - ADDRESS_CHANGE_WINDOW_MS) },
        OR: [
          { note: { startsWith: `${SYSTEM_NOTE_PREFIX}地址變更】` } },
          { note: { startsWith: `${SYSTEM_NOTE_PREFIX}合併】` } },
        ],
      },
      select: { note: true },
    });
    const coordVerdict = noCoordinateVerdict({
      hasCoordinate,
      createdAt: customer.createdAt,
      addressChangedRecently: recentSystemNotes.some((r) =>
        (r.note ?? '').startsWith(`${SYSTEM_NOTE_PREFIX}地址變更】`),
      ),
      mergedRecently: recentSystemNotes.some((r) =>
        (r.note ?? '').startsWith(`${SYSTEM_NOTE_PREFIX}合併】`),
      ),
      serverTime,
    });

    const verdict = detectSuspicion({
      lat: dto.lat,
      lng: dto.lng,
      accuracy: dto.accuracy,
      clientTime,
      serverTime,
      prev:
        prev && typeof prev.gpsLat === 'number' && typeof prev.gpsLng === 'number'
          ? { lat: prev.gpsLat, lng: prev.gpsLng, occurredAt: prev.occurredAt }
          : null,
      distanceM,
    });
    const suspicious = verdict.suspicious || coordVerdict.suspicious;
    const reasonParts = [...(verdict.reason ? [verdict.reason] : []), ...coordVerdict.notes];
    const suspiciousReason = reasonParts.length ? reasonParts.join(',') : null;

    // 打卡當下拿來比對距離的地址(pickAddress 正規化後)附在 note 最後一行「比對地址:…」,
    // 事後地址再被改也能回溯這次是跟哪個地址比的(DevInteraction 沒有獨立欄位)
    const note = appendCompareAddress(dto.note, pickAddress(customer));

    // 到訪之後要把客戶推到哪一階(以及哪些階段該被推),先在交易外問一次階段目錄:
    // 交易裡再查會把查詢時間算進客戶列鎖的持有時間。
    // 沒有目錄服務(單元測試直接 new)就用出廠階段推,行為與可設定之前一致。
    const arrival = this.stageCatalog
      ? await this.stageCatalog.arrivalAdvance()
      : arrivalAdvanceOf(DEFAULT_STAGE_CATALOG);

    const { interactionId, photoIds } = await this.prisma.$transaction(async (tx) => {
      // 每人每日上傳配額是以「使用者」為單位算的,客戶列鎖擋不住同一個人
      // 同時對兩個不同客戶上傳,所以先拿這一把(順序理由見 lockUserUploadQuota)
      if (photos.length > 0) await lockUserUploadQuota(tx, userId);
      // 再鎖客戶列(不管有沒有照片),同一客戶的打卡與補拍序列化
      await this.lockCustomerRow(tx, customerId);
      await this.assertCustomerPhotoQuota(tx, customerId, photos);
      await this.assertUserDailyUploadQuota(tx, userId, photos);
      const it = await tx.devInteraction.create({
        data: {
          customerId,
          userId,
          channel: VISIT_CHANNEL_KEY,
          note,
          occurredAt: serverTime,
          nextAction: dto.nextAction?.trim() || null,
          gpsLat: dto.lat,
          gpsLng: dto.lng,
          gpsAccuracy: dto.accuracy,
          distanceM,
          gpsSuspicious: suspicious,
          gpsSuspiciousReason: suspiciousReason ? suspiciousReason.slice(0, 300) : null,
        },
        select: { id: true },
      });

      const ids = await this.insertPhotos(tx, it.id, customerId, photos);

      await tx.devCustomer.update({
        where: { id: customerId },
        data: {
          lastContactAt: serverTime,
          ...(nextFollowUpAt ? { nextFollowUpAt } : {}),
        },
      });
      // stage 升級用條件式 updateMany:只有「此刻仍停在到訪階段之前」才往前推,
      // 避免讀 stage 與寫入之間被別的請求改掉(例如已成交)又被這裡蓋回去。
      //
      // 哪一階算「到訪」、哪些算「到訪之前」,由 dev_stages 的排序決定(見 StageCatalogService),
      // 不寫死 lead / contacted / visited:後台把階段改名或插一階之後,寫死的清單就對不上了,
      // 症狀是打卡完階段沒動,而畫面上沒有任何錯誤。
      if (arrival) {
        await tx.devCustomer.updateMany({
          where: { id: customerId, stage: { in: arrival.from } },
          data: { stage: arrival.target },
        });
      }

      // 這家客戶今天(組織時區)如果有排程且還是 planned,打卡就當作核銷:標 done 並掛這次的互動 id。
      // 「今天」在交易外先算好(要讀設定),交易內只做寫入。
      // 沒排程就什麼都不做(updateMany 影響 0 筆),不會因此讓打卡失敗。
      await markVisitPlanDone(tx, customerId, it.id, checkinDay);

      return { interactionId: it.id, photoIds: ids };
    });

    return {
      interactionId,
      distanceM,
      suspicious,
      suspiciousReason,
      photoIds,
      serverTime: serverTime.toISOString(),
    };
  }

  /** 在交易內逐張寫入,回 id 陣列(順序同輸入) */
  private async insertPhotos(
    tx: Pick<PrismaService, 'devVisitPhoto'>,
    interactionId: string,
    customerId: string,
    photos: ValidatedPhoto[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const p of photos) {
      const row = await tx.devVisitPhoto.create({
        data: {
          interactionId,
          customerId,
          kind: p.kind,
          mime: p.mime,
          bytes: p.bytes,
          sizeBytes: p.bytes.length,
          sha256: p.sha256,
          takenAt: p.takenAt,
        },
        select: { id: true },
      });
      ids.push(row.id);
    }
    return ids;
  }

  /**
   * 純補拍:建一筆 channel=note 的互動掛照片。有座標就照打卡一樣寫 GPS 欄位(含與客戶地址距離),
   * 但不跑速度 / 距離等假定位規則、不改 stage、不動 lastContactAt。
   * clientTime 有給就拿來算與伺服器的時鐘偏差:超過 5 分鐘標 gpsSuspicious 並寫理由(只標記不阻擋)。
   */
  async addPhotos(
    customerId: string,
    userId: string,
    view: ViewScope,
    dto: AddPhotosDto,
  ): Promise<{ interactionId: string; photoIds: string[] }> {
    const serverTime = new Date();
    const customer = await this.loadCustomer(customerId, userId, view);

    const photos = this.validatePhotos(dto.photos, serverTime);
    await this.assertKindsExist(photos.map((p) => p.kind));
    if (photos.length === 0) throw new BadRequestException('請至少上傳一張照片');

    const hasGps = typeof dto.lat === 'number' && typeof dto.lng === 'number';
    const distanceM =
      hasGps && typeof customer.lat === 'number' && typeof customer.lng === 'number'
        ? haversineM(customer.lat, customer.lng, dto.lat as number, dto.lng as number)
        : null;

    // 手機時間與伺服器的偏差(clientTime 沒給就不判;格式錯回 400)
    let skewReason: string | null = null;
    if (dto.clientTime !== undefined) {
      if (!hasTimezone(dto.clientTime)) throw new BadRequestException('補拍時間必須含時區');
      const clientTime = new Date(dto.clientTime);
      if (Number.isNaN(clientTime.getTime())) throw new BadRequestException('補拍時間格式錯誤');
      const skewMs = Math.abs(serverTime.getTime() - clientTime.getTime());
      if (skewMs > SUSPICIOUS_CLOCK_SKEW_MS) {
        skewReason = `手機時間與伺服器相差 ${Math.round(skewMs / 60000)} 分鐘`;
      }
    }

    // note:「【存證照片】補拍 N 張:門牌、招牌」(類型去重、依上傳順序)
    const kindLabels = Array.from(new Set(photos.map((p) => p.kind))).map(
      (k) => VISIT_PHOTO_KIND_LABEL[k] ?? k,
    );
    const note = `【存證照片】補拍 ${photos.length} 張:${kindLabels.join('、')}`;

    return this.prisma.$transaction(async (tx) => {
      // 同上:使用者鎖要在客戶列鎖之前
      if (photos.length > 0) await lockUserUploadQuota(tx, userId);
      await this.lockCustomerRow(tx, customerId);
      await this.assertCustomerPhotoQuota(tx, customerId, photos);
      await this.assertUserDailyUploadQuota(tx, userId, photos);
      const it = await tx.devInteraction.create({
        data: {
          customerId,
          userId,
          channel: 'note',
          note,
          occurredAt: serverTime,
          ...(hasGps
            ? {
                gpsLat: dto.lat,
                gpsLng: dto.lng,
                gpsAccuracy: typeof dto.accuracy === 'number' ? dto.accuracy : null,
                distanceM,
              }
            : {}),
          ...(skewReason ? { gpsSuspicious: true, gpsSuspiciousReason: skewReason } : {}),
        },
        select: { id: true },
      });
      const photoIds = await this.insertPhotos(tx, it.id, customerId, photos);
      return { interactionId: it.id, photoIds };
    });
  }

  /** 客戶的存證照片清單(不含 bytes)+ 依場所類型算必備與缺少 */
  async listPhotos(customerId: string, userId: string, view: ViewScope): Promise<PhotoListResult> {
    const customer = await this.loadCustomer(customerId, userId, view);
    const rows = await this.prisma.devVisitPhoto.findMany({
      where: { customerId },
      orderBy: [{ takenAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        kind: true,
        takenAt: true,
        interactionId: true,
        sizeBytes: true,
        interaction: { select: { user: { select: { name: true } } } },
      },
    });
    const premisesType = customer.premisesType ?? null;
    const checklist = await this.photoChecklist();
    const photos: PhotoListItem[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      takenAt: r.takenAt.toISOString(),
      interactionId: r.interactionId,
      byName: r.interaction.user.name,
      sizeBytes: r.sizeBytes,
    }));
    // 配額現況直接從這一批列算,不另外查一次:清單本來就是這位客戶的全部照片。
    const usedBytes = rows.reduce((sum: number, r: { sizeBytes: number }) => sum + r.sizeBytes, 0);
    const over = customerPhotoOverQuota({ count: rows.length, bytes: usedBytes });
    return {
      premisesType,
      premisesTypeMissing: premisesType === null,
      required: requiredPhotoKinds(premisesType, checklist),
      photos,
      missing: missingPhotoKinds(
        premisesType,
        photos.map((p) => p.kind),
        checklist,
      ),
      quota: {
        count: rows.length,
        bytes: usedBytes,
        maxCount: CUSTOMER_PHOTOS_MAX_COUNT,
        maxBytes: CUSTOMER_PHOTOS_MAX_BYTES,
        ...over,
        notice: customerPhotoOverQuotaNotice({ count: rows.length, bytes: usedBytes }),
      },
    };
  }

  /**
   * 取照片 bytes;授權:該照片的客戶要在呼叫者的可見範圍內,而且**沒有在回收桶裡**。
   *
   * deletedAt 這一段不是為了少回幾張圖。同一支服務的 listPhotos、打卡與補拍都經過
   * loadCustomer()(那裡有擋),只有這一支與 deletePhoto 各自查照片列,漏掉之後
   * 「刪掉的客戶真的看不見」在存證照片這一面是不成立的:客戶卡打不開、清單查不到,
   * 舊的照片網址卻照樣把圖吐出來。
   */
  async getPhoto(
    photoId: string,
    userId: string,
    view: ViewScope,
  ): Promise<{ mime: string; bytes: Buffer }> {
    const p = await this.prisma.devVisitPhoto.findUnique({
      where: { id: photoId },
      select: {
        mime: true,
        bytes: true,
        customer: { select: { ownerId: true, deletedAt: true } },
      },
    });
    // 沒權限、不存在、在回收桶裡都回 404,不洩漏照片是否存在
    if (!p || p.customer.deletedAt || !canSeeOwner(view, p.customer.ownerId)) {
      throw new NotFoundException('找不到此拜訪照片');
    }
    return { mime: p.mime, bytes: Buffer.from(p.bytes) };
  }

  /**
   * 這位客戶「現在」的照片張數 / 總量,以及有沒有超過上限。
   * 呼叫端要先在同一交易內 lockCustomerRow,讀到的才是這一刻的真值。
   */
  private async customerPhotoOverQuotaNow(
    tx: Pick<PrismaService, 'devVisitPhoto'>,
    customerId: string,
  ): Promise<{
    over: boolean;
    overCount: number;
    overBytes: number;
    count: number;
    bytes: number;
  }> {
    const [count, agg] = await Promise.all([
      tx.devVisitPhoto.count({ where: { customerId } }),
      tx.devVisitPhoto.aggregate({ where: { customerId }, _sum: { sizeBytes: true } }),
    ]);
    const bytes = agg._sum.sizeBytes ?? 0;
    return { ...customerPhotoOverQuota({ count, bytes }), count, bytes };
  }

  /**
   * 刪照片:只允許照片所屬互動的記錄者本人,或看得到別人資料的主管 / admin,
   * 且客戶尚未成交:stage 是 converted「或」外部案件編號已有值,任一成立都擋(成交後不可刪存證)。
   * 看不到的照片(非 owner 的客戶)回 404;看得到但不是記錄者回 403。
   * 刪除成功時在同一交易內補一筆 channel=note 的系統互動:
   * 「【存證照片刪除】<類型> <拍攝時間> 由 <姓名> 刪除」,留下稽核軌跡(前綴「【」只有系統會寫)。
   *
   * ── 已結案客戶的唯一例外:超額 ──────────────────────────────────
   * 「已結案不可刪」與「超過上限請先刪」原本會互相咬死:查重合併把兩筆各 30 張
   * 的客戶併成 60 張之後,補拍被擋成「請先刪除不需要的照片」,而那位客戶如果
   * 已經結案,刪除又被擋成「已結案,存證照片不可刪除」—— 使用者兩邊都走不通,
   * 只能找 DBA。所以已結案 **且** 目前超額時開一個口:允許刪,直到刪回上限以內。
   * 這個口開得很窄:沒有超額的已結案客戶維持原樣一張都不能刪,而例外刪除會在
   * 時間軸上寫明「為什麼這一張被允許刪」,不是安靜地放行。
   */
  async deletePhoto(photoId: string, userId: string, view: ViewScope): Promise<{ ok: true }> {
    const p = await this.prisma.devVisitPhoto.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        kind: true,
        takenAt: true,
        customerId: true,
        customer: {
          select: { ownerId: true, stage: true, externalCaseRef: true, deletedAt: true },
        },
        interaction: { select: { userId: true } },
      },
    });
    // deletedAt 要在這裡就擋掉,理由跟 getPhoto 不同而且更重:這一支是硬刪,bytes 刪掉就回不來。
    // 回收桶那一列上寫著「還原會拿回 N 張照片」,那是主管決定要不要永久刪除的依據,
    // 而漏掉這一段的話,權限最低的角色可以在主管做決定之前把那個數字抽乾 ——
    // 主管看不到回收桶裡的客戶(403),卻救不回已經被刪掉的存證。
    if (!p || p.customer.deletedAt || !canSeeOwner(view, p.customer.ownerId)) {
      throw new NotFoundException('找不到此拜訪照片');
    }
    if (!view.viewAll && view.ownerIds.length <= 1 && p.interaction.userId !== userId) {
      throw new ForbiddenException('只有拍攝這張照片的訪查人員或主管可以刪除');
    }
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    // 種類名稱查主檔:後台新增或改名過的種類,系統紀錄要寫得出中文,不是寫出英文代碼
    const kindRow = await this.prisma.visitPhotoKind.findUnique({
      where: { key: p.kind },
      select: { label: true },
    });
    const kindLabel = kindRow?.label ?? VISIT_PHOTO_KIND_LABEL[p.kind] ?? p.kind;
    const baseNote = `【存證照片刪除】${kindLabel} ${formatStamp(p.takenAt, await this.timeZone())} 由 ${actor?.name ?? '(未知)'} 刪除`;
    await this.prisma.$transaction(async (tx) => {
      // 先鎖客戶列再檢查已成交,避免與標記成交同時發生時把已成交客戶的存證刪掉
      await this.lockCustomerRow(tx, p.customerId);
      const cust = await tx.devCustomer.findUnique({
        where: { id: p.customerId },
        select: { stage: true, externalCaseRef: true },
      });
      if (!cust) throw new BadRequestException('客戶已結案,存證照片不可刪除');
      const closed = cust.stage === WON_STAGE_KEY || cust.externalCaseRef !== null;
      // 超額與否要在鎖之後、同一個交易裡算:在鎖之外算的話,兩個人同時刪最後幾張,
      // 兩邊都讀到「還超額」而各自放行,已結案客戶會被刪到低於上限。
      const over = closed ? await this.customerPhotoOverQuotaNow(tx, p.customerId) : null;
      if (closed && !over?.over) {
        throw new BadRequestException('客戶已結案,存證照片不可刪除');
      }
      // 例外放行要寫在時間軸上,而且要寫得出「為什麼這一張被允許刪」,
      // 不然事後看只會看到一筆「已結案客戶的存證被刪掉了」。
      const note = over?.over
        ? `${baseNote}(客戶已結案,因查重合併後存證照片超過上限而例外開放刪除;刪除前 ${over.count} 張${
            over.bytes > 0 ? `、共 ${(over.bytes / (1024 * 1024)).toFixed(1)}MB` : ''
          })`
        : baseNote;
      await tx.devVisitPhoto.delete({ where: { id: photoId } });
      await tx.devInteraction.create({
        data: { customerId: p.customerId, userId, channel: 'note', note, occurredAt: new Date() },
        select: { id: true },
      });
    });
    return { ok: true };
  }

  /**
   * 最近 N 天的 visit 互動(呼叫者可見範圍),主管用來看可疑打卡。
   *
   * 用 relatedLiveCustomerFilter 不用裸的 relatedOwnerFilter:客戶被刪進回收桶之後,
   * 清單、看板、秒查、查重、統計、地圖、排程、最近聯絡全都回 0 筆,只有這一張表
   * 還列著那位客戶的公司名,而點進去是 404。兩個條件都掛在 customer 這個鍵上,
   * 分開展開會互相覆寫(那正是 relatedLiveCustomerFilter 存在的理由)。
   */
  async recent(userId: string, view: ViewScope, days: number): Promise<RecentRow[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.devInteraction.findMany({
      where: {
        channel: VISIT_CHANNEL_KEY,
        occurredAt: { gte: since },
        ...relatedLiveCustomerFilter(view),
      },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      select: {
        id: true,
        customerId: true,
        occurredAt: true,
        distanceM: true,
        gpsSuspicious: true,
        gpsSuspiciousReason: true,
        customer: { select: { companyName: true } },
        user: { select: { name: true } },
        _count: { select: { photos: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      companyName: r.customer.companyName,
      userName: r.user.name,
      occurredAt: r.occurredAt.toISOString(),
      distanceM: r.distanceM,
      gpsSuspicious: r.gpsSuspicious,
      gpsSuspiciousReason: r.gpsSuspiciousReason,
      photoCount: r._count.photos,
    }));
  }
}
