import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CrmService } from './crm.service';
import { CreateDevCustomerDto } from './dto/create-dev-customer.dto';
import { CreateInteractionDto } from './dto/create-interaction.dto';
import { ImportRowsDto } from './dto/import-rows.dto';
import { TransferDto } from './dto/transfer.dto';
import { TransferBatchDto } from './dto/transfer-batch.dto';
import { ConvertDto } from './dto/convert.dto';
import { DeleteCustomerDto } from './deletion/dto/delete-customer.dto';
import { CrmDeletionService } from './deletion/crm-deletion.service';
import { DELETE_THROTTLE } from './deletion/crm-deletion.controller';
import type { JwtPayload } from '../auth/auth.service';
import { AccessScopeService } from '../scope/access-scope.service';
// 角色守衛七個 controller 共用一份(見 crm/crm-roles.ts),角色清單與拒絕訊息都不在這裡各寫一次
import { assertCrmRole, assertCrmManagerRole } from './crm-roles';
import { requestAuditContext } from '../common/audit-context';

/**
 * 客戶管理 CRM API。可用角色:業務 / 訪查主管 / 系統管理員。
 * 可見範圍由 AccessScopeService 一處算出來(業務看自己、主管看團隊與部門子樹、
 * 系統管理員看全部),各 service 依它組 where,見 ../scope/view-scope.ts。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
@Controller('admin/crm')
@UseGuards(AuthGuard('jwt'))
export class CrmController {
  constructor(
    private readonly crm: CrmService,
    private readonly access: AccessScopeService,
    private readonly deletion: CrmDeletionService,
  ) {}

  /** 這個人看得到誰的客戶。一律從 JWT 算,不接受 query 覆寫 */
  private scopeOf(req: Request & { user: JwtPayload }) {
    return this.access.resolve(req.user.sub, req.user.role);
  }

  /**
   * 客戶清單。一定有筆數上限,要更多就帶 cursor(用上一頁回的 nextCursor)往下翻;
   * nextCursor 為 null 代表沒有下一頁。回應不含 note(清單不顯示它,見 CUSTOMER_LIST_SELECT)。
   *
   * q 是秒查關鍵字(公司名 / 識別碼 / 聯絡人 / 電話),在資料庫裡查。
   * 沒有這個參數的話,前端只能把清單整批撈回去自己過濾,而清單有上限,
   * 結果是超過上限的客戶用秒查永遠找不到,畫面上也不會說少了什麼。
   */
  @Get()
  async list(
    @Req() req: Request & { user: JwtPayload },
    @Query('stage') stage?: string,
    @Query('ownerId') ownerId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    assertCrmRole(req.user.role);
    const view = await this.scopeOf(req);
    const n = Number(limit);
    return this.crm.list(req.user.sub, view, {
      stage,
      ownerId,
      q: typeof q === 'string' ? q : undefined,
      limit: Number.isFinite(n) ? n : undefined,
      cursor: cursor || undefined,
    });
  }

  @Get('board')
  async board(@Req() req: Request & { user: JwtPayload }) {
    assertCrmRole(req.user.role);
    return this.crm.board(req.user.sub, await this.scopeOf(req));
  }

  @Get('report')
  async report(
    @Req() req: Request & { user: JwtPayload },
    @Query('range') range?: string,
    @Query('scope') scope?: string,
  ) {
    assertCrmRole(req.user.role);
    const r = range === 'today' ? 'today' : 'week';
    const sc = scope === 'team' ? 'team' : 'me';
    return this.crm.report(req.user.sub, await this.scopeOf(req), r, sc);
  }

  @Get('by-sales')
  async bySales(@Req() req: Request & { user: JwtPayload }) {
    assertCrmManagerRole(req.user.role);
    return { rows: await this.crm.bySales(await this.scopeOf(req)) };
  }

  // 移交下拉的資料來源。要傳 scope:不然主管會拿到全公司名冊,也能把客戶轉給團隊外的人
  @Get('sales-users')
  async salesUsers(@Req() req: Request & { user: JwtPayload }) {
    assertCrmManagerRole(req.user.role);
    return { rows: await this.crm.salesUsers(await this.scopeOf(req)) };
  }

  @Get(':id')
  async get(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    assertCrmRole(req.user.role);
    return this.crm.get(id, req.user.sub, await this.scopeOf(req));
  }

  @Post()
  async create(@Req() req: Request & { user: JwtPayload }, @Body() dto: CreateDevCustomerDto) {
    assertCrmRole(req.user.role);
    return this.crm.create(req.user.sub, dto as unknown as Record<string, unknown>);
  }

  @Patch(':id')
  async update(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateDevCustomerDto,
  ) {
    assertCrmRole(req.user.role);
    return this.crm.update(
      id,
      req.user.sub,
      await this.scopeOf(req),
      dto as unknown as Record<string, unknown>,
    );
  }

  @Post(':id/interactions')
  async addInteraction(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateInteractionDto,
  ) {
    assertCrmRole(req.user.role);
    return this.crm.addInteraction(
      id,
      req.user.sub,
      await this.scopeOf(req),
      dto as unknown as Record<string, unknown>,
    );
  }

  /**
   * 批次移交。路徑是固定字串 transfer-batch(一段),跟 :id/transfer(兩段)不會互相吃掉。
   *
   * 為什麼要有這一支:匯入一律把客戶歸在匯入者名下,而 :id/transfer 一次只能一筆。
   * 一份 2000 筆的名單要分給 26 個人,沒有它就只能開 2000 張客戶卡。
   * 權限、可見範圍、客戶列鎖全部走跟單筆同一份程式(見 CrmService.transferMany)。
   */
  @Post('transfer-batch')
  async transferBatch(@Req() req: Request & { user: JwtPayload }, @Body() dto: TransferBatchDto) {
    assertCrmManagerRole(req.user.role);
    return this.crm.transferMany(
      dto.customerIds,
      dto.toUserId,
      req.user.sub,
      await this.scopeOf(req),
    );
  }

  @Post(':id/transfer')
  async transfer(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TransferDto,
  ) {
    assertCrmManagerRole(req.user.role);
    // 移交跟 get / update 一樣要吃可見範圍:少了它,主管可以把別的團隊的客戶搶過來,
    // 而且搶完連客戶卡與拜訪排程都跟著換人,原團隊看不到也救不回。
    return this.crm.transfer(id, dto.toUserId, req.user.sub, await this.scopeOf(req));
  }

  // 成交前預檢(唯讀):按下「標記為成交」之前先問,被擋就不送出
  @Get(':id/convert-check')
  async convertCheck(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    assertCrmRole(req.user.role);
    return this.crm.convertCheck(id, req.user.sub, await this.scopeOf(req));
  }

  @Post(':id/convert')
  async convert(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConvertDto,
  ) {
    assertCrmRole(req.user.role);
    return this.crm.markConverted(id, req.user.sub, await this.scopeOf(req), dto?.externalRef);
  }

  // body 一定要用 DTO class:型別註記(interface / 行內型別)不會產生 class-validator
  // metadata,全域 ValidationPipe 就等於沒作用
  // 匯入要吃可見範圍:查重比對的是「這個人看得到的客戶」而不是「自己名下的客戶」。
  // 只比自己名下的話,管理員與主管各匯一次同一份名單就會產生兩套完整重複的客戶。
  @Post('import')
  async importList(@Req() req: Request & { user: JwtPayload }, @Body() dto: ImportRowsDto) {
    assertCrmRole(req.user.role);
    // 批次識別碼由前端整次匯入產生一次並隨每一批帶進來,沒帶才由 service 自己生。
    // 大檔會被切成好幾次 POST,不共用同一個 id 的話「刪掉這一批」只收得回其中一批。
    return this.crm.importRows(req.user.sub, await this.scopeOf(req), dto.rows, dto.importBatchId);
  }

  /**
   * 刪除前預檢(唯讀)。按下刪除之前先問,畫面才說得出
   * 「這一筆有 12 筆互動與 4 張照片」,而不是按下去才被打回來。
   */
  @Get(':id/delete-check')
  async deleteCheck(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    assertCrmRole(req.user.role);
    return this.deletion.deleteCheck(id, await this.scopeOf(req));
  }

  /**
   * 刪除客戶(軟刪除)。刪掉的客戶會從清單、看板、秒查、查重、統計與地圖消失,
   * 但列還在,訪查主管與系統管理員可以在回收桶(admin/crm-trash)看到並還原。
   *
   * 有互動紀錄、有存證照片、已成交的客戶預設擋下並說明理由,
   * 系統管理員可以帶 force: true 強制,那一次會寫進稽核紀錄。
   * 規則與理由見 deletion/crm-deletion-rules.ts。
   */
  @Delete(':id')
  @Throttle(DELETE_THROTTLE)
  async remove(
    @Req() req: Request & { user: JwtPayload },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DeleteCustomerDto,
  ) {
    assertCrmRole(req.user.role);
    return this.deletion.softDelete(
      id,
      req.user.sub,
      req.user.role,
      await this.scopeOf(req),
      { reason: dto?.reason, force: dto?.force },
      requestAuditContext(req),
    );
  }
}
