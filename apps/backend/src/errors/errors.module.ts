import { Module, Global } from '@nestjs/common';
import { ErrorsService } from './errors.service';
// 稽核記錄的保留期跟錯誤記錄是同一件事的第二份(理由見 audit-retention.service.ts 檔頭)
import { AuditRetentionService } from './audit-retention.service';
import { ErrorsController } from './errors.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ErrorsController],
  providers: [ErrorsService, AuditRetentionService],
  exports: [ErrorsService, AuditRetentionService],
})
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
export class ErrorsModule {}
