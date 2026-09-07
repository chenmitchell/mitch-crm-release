// ref:3687 mc/陳彥輔/米球®
/**
 * 資料匯出 API(獨立前綴 admin/crm-export,避免被 CrmController 的 GET :id 吃掉)。
 *
 * 三支都回 CSV 附件:
 *   GET admin/crm-export/customers      客戶清單(前十欄對齊匯入格式)
 *   GET admin/crm-export/interactions   互動紀錄
 *   GET admin/crm-export/photos         存證照片清單(不是照片本身,見 service 檔頭)
 *
 * 權限:CRM 角色都能匯出,範圍照 ViewScope(業務只匯得到自己的)。
 * 「只有管理員能匯出」這個選項考慮過但否決了:業務本來就看得到自己的客戶,
 * 攔在匯出這一關不會讓資料更安全,只會讓人改用複製貼上,而那一種沒有稽核紀錄。
 *
 * 速率限制比全域預設緊:匯出是一次把大量資料帶出系統的動作,
 * 連續打等於慢速把整個資料庫抓走,而每一次都要組一份 CSV,也是後端最貴的請求。
 * 每一次匯出都寫 audit_logs(在 service 裡),所以「誰在什麼時候帶走了什麼」查得到。
 */
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CrmExportService, type ExportPage } from './crm-export.service';
import { csvResponseHeaders } from './csv';
import {
  EXPORT_COUNT_HEADER,
  EXPORT_NEXT_OFFSET_HEADER,
  EXPORT_TOTAL_BYTES_HEADER,
  EXPORT_TRUNCATED_HEADER,
} from './export-headers';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
import { SettingsService } from '../../settings/settings.service';
import { LOOKUP_DEFAULT_LABEL } from '../../app-settings/app-settings.view';
import { assertCrmRole } from '../crm-roles';
import { requestAuditContext } from '../../common/audit-context';

type AuthedRequest = Request & { user: JwtPayload };

/**
 * 匯出端點:每 IP 每分鐘 6 次。
 * 這個數字要能讓人用 offset 連續抓幾批(一批 5000 筆),又不至於變成
 * 「開一個 for 迴圈把整個資料庫慢慢搬走」的順暢路徑。
 */
const EXPORT_THROTTLE = { default: { limit: 6, ttl: 60_000 } };

@Controller('admin/crm-export')
@UseGuards(AuthGuard('jwt'))
export class CrmExportController {
  constructor(
    private readonly svc: CrmExportService,
    private readonly access: AccessScopeService,
    private readonly settings: SettingsService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: AuthedRequest) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /** 識別碼欄位在各地叫什麼由後台設定決定;讀不到就用通用說法 */
  private async lookupLabel(): Promise<string> {
    try {
      const configured = (await this.settings.get())?.lookupLabel?.trim();
      return configured || LOOKUP_DEFAULT_LABEL;
    } catch {
      return LOOKUP_DEFAULT_LABEL;
    }
  }

  /**
   * 把產好的 CSV 寫進回應。
   *
   * Content-Length 用位元組數而不是字串長度:CSV 裡都是中文,
   * 用 .length 會少算一大截,瀏覽器會在檔案下載到一半時認為結束了。
   * 截斷與下一批的位置用自訂標頭交代,不寫進檔案內容 ——
   * 寫進內容的話,那一行會被當成一筆客戶匯回系統。
   */
  private send(res: Response, page: ExportPage): void {
    const body = Buffer.from(page.csv, 'utf8');
    const headers = csvResponseHeaders(page.fileName);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('Content-Length', String(body.byteLength));
    // 標頭名稱一律用 export-headers 的常數:main.ts 的 CORS exposedHeaders 用的是
    // 同一份,兩邊各寫一份字串時,少打一個的症狀是跨網域下前端安靜地讀不到。
    res.setHeader(EXPORT_COUNT_HEADER, String(page.count));
    res.setHeader(EXPORT_TRUNCATED_HEADER, page.truncated ? 'true' : 'false');
    if (page.nextOffset !== null) res.setHeader(EXPORT_NEXT_OFFSET_HEADER, String(page.nextOffset));
    res.status(200).end(body);
  }

  /** 客戶清單 CSV。前十欄與匯入格式一致,改完可以直接匯回來 */
  @Get('customers')
  @Throttle(EXPORT_THROTTLE)
  async customers(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    assertCrmRole(req.user.role);
    const page = await this.svc.customersCsv(
      req.user.sub,
      await this.scopeOf(req),
      await this.lookupLabel(),
      { limit: Number(limit), offset: Number(offset) },
      requestAuditContext(req),
    );
    this.send(res, page);
  }

  /** 互動紀錄 CSV。days 可以只匯最近 N 天,不帶就是全部(仍受筆數上限) */
  @Get('interactions')
  @Throttle(EXPORT_THROTTLE)
  async interactions(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('days') days?: string,
  ) {
    assertCrmRole(req.user.role);
    const page = await this.svc.interactionsCsv(
      req.user.sub,
      await this.scopeOf(req),
      {
        limit: Number(limit),
        offset: Number(offset),
        days: Number(days),
      },
      requestAuditContext(req),
    );
    this.send(res, page);
  }

  /**
   * 存證照片清單 CSV(照片本身逐張走 GET /api/admin/crm-checkin/photo/:photoId)。
   * 回應另外帶 X-Export-Total-Bytes,讓人在下載之前先知道這一批總共多大。
   */
  @Get('photos')
  @Throttle(EXPORT_THROTTLE)
  async photos(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    assertCrmRole(req.user.role);
    const page = await this.svc.photoManifestCsv(
      req.user.sub,
      await this.scopeOf(req),
      { limit: Number(limit), offset: Number(offset) },
      requestAuditContext(req),
    );
    res.setHeader(EXPORT_TOTAL_BYTES_HEADER, String(page.totalBytes));
    this.send(res, page);
  }
}
