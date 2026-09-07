// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 組織部門 API。讀取與寫入都是 admin(組織樹是可見範圍的依據,而且只有管理員
 * 設得了誰屬於哪一個部門),守衛在 DepartmentsService 裡,
 * controller 只把 JWT 的角色傳下去。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import type { JwtPayload } from '../auth/auth.service';

type Authed = Request & { user: JwtPayload };

@Controller('admin/departments')
@UseGuards(AuthGuard('jwt'))
export class DepartmentsController {
  constructor(private readonly svc: DepartmentsService) {}

  @Get()
  async list(@Req() req: Authed) {
    return { departments: await this.svc.list(req.user.role) };
  }

  @Post()
  async create(@Req() req: Authed, @Body() dto: CreateDepartmentDto) {
    return { department: await this.svc.create(req.user.role, dto) };
  }

  @Patch(':id')
  async update(
    @Req() req: Authed,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return { department: await this.svc.update(req.user.role, id, dto) };
  }

  @Delete(':id')
  async remove(@Req() req: Authed, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.remove(req.user.role, id);
  }
}
