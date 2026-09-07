// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Module } from '@nestjs/common';
import { AccessScopeService } from './access-scope.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [AccessScopeService],
  exports: [AccessScopeService],
})
export class ScopeModule {}
