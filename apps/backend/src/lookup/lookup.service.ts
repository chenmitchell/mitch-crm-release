// ref:3687 mc/陳彥輔/米球®
/**
 * 外部查詢帶入(可插拔)。
 *
 * 這支解決的問題:各地都有一組「輸入一個號碼就查得到這家店叫什麼、開在哪裡」的
 * 公開登記資料,但那個號碼叫什麼名字、要打哪個網址、回應長什麼樣子,每個國家
 * 都不一樣。所以這裡不內建任何一個資料源,而是把「打哪個網址、怎麼取值」
 * 做成後台設定,程式碼本身對地區完全無知。
 *
 * 五個設定值(system_settings id=1,見 settings.service.ts):
 *   lookupEnabled      沒開就整支不提供(回 404 並說明怎麼開)
 *   lookupLabel        這個識別碼在當地叫什麼,只影響畫面上的字
 *   lookupUrlTemplate  例:https://example.com/api?id={q}
 *   lookupFieldMap     {"name":"data.company_name","address":"data.addr"}
 *   lookupPattern      識別碼格式的正規表示式,空字串 = 不限制
 *
 * 安全邊界(這一支是「伺服器照著設定去打一個外部網址」,等於天生的 SSRF 面):
 *   1. 只准 https,不准帳號密碼寫在網址裡,不准指向內網 / 本機 / 保留位址。
 *      主機名先擋一次(lookup-url.ts),DNS 解析後對每一個回來的位址再擋一次 ——
 *      只擋主機名的話,一個解析到 127.0.0.1 的公開網域就繞過去了。
 *   2. 不跟隨轉址(redirect: 'error')。跟隨轉址等於讓上游決定我們去打哪裡,
 *      前面兩層檢查全部作廢。
 *   3. 逾時 8 秒,回應大小上限 64KB(先看 Content-Length,沒有就邊讀邊數)。
 *   4. 對外一律回通用訊息。上游的狀態碼、錯誤內容、網址一個字都不往外送 ——
 *      那些東西本身就是內網探測的結果。細節只寫進伺服器的 log。
 *   5. 端點上另外掛 @Throttle,避免有人拿這支當轉發器連打上游。
 */
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { SettingsService } from '../settings/settings.service';
import {
  applyFieldMap,
  buildLookupUrl,
  compileLookupPattern,
  isBlockedAddress,
  LOOKUP_QUERY_MAX,
  type LookupResult,
} from './lookup-url';

/** 外部服務的逾時。8 秒是「人還願意等」與「不要把連線卡住」的折衷 */
export const LOOKUP_TIMEOUT_MS = 8_000;

/** 回應大小上限。登記資料的一筆 JSON 只有幾 KB,超過就是異常,不讀完 */
export const LOOKUP_MAX_RESPONSE_BYTES = 64 * 1024;

/** 沒啟用時回的訊息。要講「怎麼開」,不是只講「沒有」(WCAG 3.3.3 的精神) */
export const LOOKUP_DISABLED_MESSAGE =
  '外部查詢帶入尚未啟用。請由系統管理員在系統設定的「外部查詢帶入」頁籤填好查詢網址後再使用,在那之前這個欄位請手動填寫';

/** 對外的通用失敗訊息。刻意不分「上游 500」「連不上」「回傳格式不對」 */
export const LOOKUP_UPSTREAM_MESSAGE = '外部查詢服務目前無法使用,請手動填寫';

/** 後台設定有問題(網址填錯之類)時對外的訊息。同樣不透露填了什麼 */
export const LOOKUP_MISCONFIGURED_MESSAGE =
  '外部查詢帶入的設定不完整或不正確,請通知系統管理員檢查系統設定的「外部查詢帶入」頁籤';

@Injectable()
export class LookupService {
  private readonly logger = new Logger(LookupService.name);

  /**
   * 對外的兩個接縫,預設就是真的 DNS 與真的 fetch。
   * 做成可覆寫的欄位,是為了讓安全性測試(私有位址、逾時、大小上限、
   * 不外洩上游細節)能在沒有網路的環境跑起來 —— 這幾條規則如果沒有測試釘住,
   * 日後任何一次重構都可能把它們拆掉而沒有人發現。
   */
  resolveAddresses: (hostname: string) => Promise<string[]> = async (hostname) => {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return records.map((r) => r.address);
  };
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(private readonly settings: SettingsService) {}

  /**
   * 查一組識別碼。回 { name?, address?, phone? },查不到任何一格就回空物件 ——
   * 空物件不是錯誤:那代表上游確實沒有這一筆,前端會提示手動填。
   */
  async lookupBusiness(rawQuery: string): Promise<LookupResult> {
    const settings = await this.settings.get();
    if (settings.lookupEnabled !== true) throw new NotFoundException(LOOKUP_DISABLED_MESSAGE);

    const label = (settings.lookupLabel ?? '').trim() || '識別碼';
    const q = rawQuery.trim();
    if (q === '') throw new BadRequestException(`請先輸入${label}`);
    if (q.length > LOOKUP_QUERY_MAX) {
      throw new BadRequestException(`${label}最長 ${LOOKUP_QUERY_MAX} 個字`);
    }

    const patternText = (settings.lookupPattern ?? '').trim();
    if (patternText !== '') {
      const re = compileLookupPattern(patternText);
      if (re === null) {
        // 後台填了一條編不起來的正規表示式。不擋使用者(那不是他的錯),
        // 但要在伺服器留下紀錄,不然這種設定錯誤永遠不會被發現。
        this.logger.warn('[lookup] 識別碼格式設定不是合法的正規表示式,這次略過格式檢查');
      } else if (!re.test(q)) {
        throw new BadRequestException(`${label}的格式不正確,請對照原始文件再確認一次`);
      }
    }

    const built = buildLookupUrl(settings.lookupUrlTemplate ?? '', q);
    if (!built.ok || !built.url) {
      this.logger.error(`[lookup] 查詢網址樣板不合法:${built.ok ? '未知' : built.message}`);
      throw new BadRequestException(LOOKUP_MISCONFIGURED_MESSAGE);
    }

    await this.assertResolvesToPublicAddress(built.url);
    const payload = await this.fetchUpstream(built.url);
    const fieldMap = settings.lookupFieldMap ?? {};
    return applyFieldMap(payload, fieldMap);
  }

  /**
   * DNS 那一層的 SSRF 防護。
   *
   * 主機名檢查擋得掉 https://127.0.0.1/ 這種明著來的;擋不掉的是
   * 一個看起來正常的網域被解析到 10.0.0.5。所以送出請求之前先解析一次,
   * 只要有**任何一個**回來的位址落在私有 / 回送 / 保留範圍就整個拒絕。
   *
   * 這不是完美的防護:解析與實際連線之間仍有一段時間差(DNS rebinding)。
   * 要完全關掉那個窗口得自己接管 socket 連線,代價遠高於這裡的收益;
   * 真正在意的部署應該把後端放在出站白名單的網路裡。
   */
  private async assertResolvesToPublicAddress(url: string): Promise<void> {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = await this.resolveAddresses(hostname);
    } catch {
      this.logger.warn('[lookup] 查詢網址的主機名無法解析');
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }
    if (addresses.length === 0) {
      this.logger.warn('[lookup] 查詢網址的主機名解析不到任何位址');
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }
    const blocked = addresses.filter((a) => isBlockedAddress(a));
    if (blocked.length > 0) {
      // 這一行是設定錯誤或攻擊的徵兆,要看得到;但對外只回通用訊息。
      this.logger.error('[lookup] 查詢網址解析到內部或保留位址,已拒絕送出請求');
      throw new BadRequestException(LOOKUP_MISCONFIGURED_MESSAGE);
    }
  }

  /**
   * 實際去打上游。任何失敗都只往外丟一句通用訊息,細節留在伺服器 log。
   * 回傳的是解析後的 JSON(unknown),取值交給 applyFieldMap。
   */
  private async fetchUpstream(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error', // 跟隨轉址等於讓上游決定我們去打哪裡
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`[lookup] 上游請求失敗:${(err as Error)?.name ?? 'Error'}`);
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }

    if (!res.ok) {
      // 上游的狀態碼不往外送:它本身就是內網探測的結果
      this.logger.warn(`[lookup] 上游回應狀態 ${res.status}`);
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }

    const declared = Number(res.headers?.get?.('content-length') ?? '');
    if (Number.isFinite(declared) && declared > LOOKUP_MAX_RESPONSE_BYTES) {
      this.logger.warn('[lookup] 上游回應超過大小上限(Content-Length),不讀 body');
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }

    let text: string;
    try {
      text = await this.readCapped(res);
    } catch (err) {
      this.logger.warn(`[lookup] 讀取上游回應失敗:${(err as Error)?.message ?? 'unknown'}`);
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      this.logger.warn('[lookup] 上游回應不是合法的 JSON');
      throw new BadGatewayException(LOOKUP_UPSTREAM_MESSAGE);
    }
  }

  /**
   * 邊讀邊數,超過上限就中斷。
   *
   * 為什麼不能只信 Content-Length:那個 header 是上游自己填的,可以不填,
   * 也可以填一個小數字然後送 500MB 過來。沒有這一段的話,一個惡意或壞掉的
   * 上游就能把後端的記憶體吃光。
   */
  private async readCapped(res: Response): Promise<string> {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      // 測試替身或沒有 stream 的環境:退回一次讀完,但仍然檢查長度
      const whole = await res.text();
      if (Buffer.byteLength(whole, 'utf8') > LOOKUP_MAX_RESPONSE_BYTES) {
        throw new Error('回應超過大小上限');
      }
      return whole;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > LOOKUP_MAX_RESPONSE_BYTES) {
          throw new Error('回應超過大小上限');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
}
