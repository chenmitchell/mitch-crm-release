// ref:3687 mc/陳彥輔/米球®
/**
 * 客戶刪除與回收桶 API。
 *
 * 路徑前綴刻意用 admin/crm-trash 而不是掛在 CrmController 底下:
 * CrmController 有一支 `@Get(':id')` 帶 ParseUUIDPipe,任何 GET /admin/crm/deleted
 * 這種字面路徑都會先被它接走再因為不是 uuid 回 400,而畫面上看起來像「回收桶壞了」。
 * 同專案的打卡、查重、地圖也是同一個做法(各用獨立前綴)。
 *
 * 唯一的例外是單筆刪除 DELETE /admin/crm/:id ——
 * 它跟客戶卡是同一個資源,擺在別的前綴反而難找;method 不同不會撞到 GET :id。
 * 那一支在 CrmController 裡,呼叫的是這裡同一個 service。
 *
 * 權限:
 *   DELETE  admin/crm/:id                     CRM 角色 + 可見範圍;強制刪除要 admin
 *   GET     admin/crm-trash                   訪查主管 / admin
 *   GET     admin/crm-trash/import-batches    訪查主管 / admin
 *   POST    admin/crm-trash/import-batch/*    訪查主管 / admin(整批刪除與整批還原同一個門檻)
 *   POST    admin/crm-trash/:id/restore       訪查主管 / admin
 *   DELETE  admin/crm-trash/:id               admin(永久刪除)
 *
 * 速率限制:刪除與整批刪除比全域預設緊,理由是「手滑連按」與「腳本掃一整批」
 * 在這一支的後果都是資料不見,不是多打幾次 API 而已。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CrmDeletionService } from './crm-deletion.service';
import { DeleteImportBatchDto, RestoreImportBatchDto } from './dto/delete-customer.dto';
import type { JwtPayload } from '../../auth/auth.service';
import { AccessScopeService } from '../../scope/access-scope.service';
import { assertCrmManagerRole } from '../crm-roles';
import { UUID_RE } from '../../common/uuid';
import { requestAuditContext } from '../../common/audit-context';

type AuthedRequest = Request & { user: JwtPayload };

/** 刪除類端點:每 IP 每分鐘 20 次。連按與腳本掃批在這裡的後果是資料不見 */
export const DELETE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@Controller('admin/crm-trash')
@UseGuards(AuthGuard('jwt'))
export class CrmTrashController {
  constructor(
    private readonly svc: CrmDeletionService,
    private readonly access: AccessScopeService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: AuthedRequest) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /** 回收桶清單(可用 importBatchId 只看某一批) */
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('importBatchId') importBatchId?: string,
    @Query('limit') limit?: string,
  ) {
    assertCrmManagerRole(req.user.role);
    const n = Number(limit);
    return this.svc.listDeleted(await this.scopeOf(req), req.user.role, {
      // 格式不對就當成沒指定:uuid 欄位收到 'abc' 會讓 Prisma 在轉型時丟例外,
      // 那是輸入問題,不該變成 500 加一列 error_logs(同 CrmService.list 的做法)
      importBatchId: UUID_RE.test(importBatchId ?? '') ? importBatchId : undefined,
      limit: Number.isFinite(n) ? n : undefined,
    });
  }

  /**
   * 最近幾次匯入的批次(給「刪掉這一批」挑用)。
   * 與整批刪除 / 整批還原同一個門檻(訪查主管 / admin),範圍照 ViewScope。
   * 這一支原本是 CRM 角色都能看,而它是整批刪除的入口 —— 入口開著、
   * 回收桶與還原卻是 403,訪查人員手滑之後救不回來(見 service 檔頭)。
   */
  @Get('import-batches')
  async importBatches(@Req() req: AuthedRequest) {
    assertCrmManagerRole(req.user.role);
    return this.svc.recentImportBatches(await this.scopeOf(req), req.user.role);
  }

  /** 整批刪除:刪掉某一次匯入寫進來的全部客戶 */
  @Post('import-batch/delete')
  @Throttle(DELETE_THROTTLE)
  async deleteBatch(@Req() req: AuthedRequest, @Body() dto: DeleteImportBatchDto) {
    assertCrmManagerRole(req.user.role);
    return this.svc.deleteImportBatch(
      dto.importBatchId,
      req.user.sub,
      req.user.role,
      await this.scopeOf(req),
      { reason: dto.reason, force: dto.force },
      requestAuditContext(req),
    );
  }

  /**
   * 整批還原。
   * 200 不是 201:還原是把既有的那幾列改回來,沒有建立任何資源,
   * 也沒有 Location 可以指。Nest 對 @Post 的預設是 201,所以要明講。
   */
  @Post('import-batch/restore')
  @HttpCode(HttpStatus.OK)
  @Throttle(DELETE_THROTTLE)
  async restoreBatch(@Req() req: AuthedRequest, @Body() dto: RestoreImportBatchDto) {
    assertCrmManagerRole(req.user.role);
    return this.svc.restoreImportBatch(
      dto.importBatchId,
      req.user.sub,
      req.user.role,
      await this.scopeOf(req),
      requestAuditContext(req),
    );
  }

  /** 還原單筆。200 不是 201,理由同上 */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @Throttle(DELETE_THROTTLE)
  async restore(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    assertCrmManagerRole(req.user.role);
    return this.svc.restore(
      id,
      req.user.sub,
      req.user.role,
      await this.scopeOf(req),
      requestAuditContext(req),
    );
  }

  /** 永久刪除(硬刪,連互動與存證照片一起帶走)。只有系統管理員 */
  @Delete(':id')
  @Throttle(DELETE_THROTTLE)
  async purge(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    assertCrmManagerRole(req.user.role);
    return this.svc.purge(
      id,
      req.user.sub,
      req.user.role,
      await this.scopeOf(req),
      requestAuditContext(req),
    );
  }
}
