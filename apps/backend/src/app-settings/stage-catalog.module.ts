// ref:3687 mc/陳彥輔/米球®
/**
 * 階段目錄模組。單獨一支是為了讓 CRM 各服務拿得到 StageCatalogService,
 * 又不必為了問一句「哪些階段是終止的」把整個後台設定模組(含 admin 端點)拉進來。
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StageCatalogService } from './stage-catalog.service';

@Module({
  imports: [PrismaModule],
  providers: [StageCatalogService],
  exports: [StageCatalogService],
})
export class StageCatalogModule {}
