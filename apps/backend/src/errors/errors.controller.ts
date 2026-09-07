import { Controller, Get, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ErrorsService } from './errors.service';
import type { JwtPayload } from '../auth/auth.service';

@Controller('admin/errors')
@UseGuards(AuthGuard('jwt'))
export class ErrorsController {
  constructor(private readonly errors: ErrorsService) {}

  @Get()
  async list(@Req() req: Request & { user: JwtPayload }, @Query('limit') limitStr?: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException('僅系統管理員可看');
    const limit = Math.min(Math.max(parseInt(limitStr ?? '100', 10) || 100, 1), 500);
    return this.errors.list(limit);
  }
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
