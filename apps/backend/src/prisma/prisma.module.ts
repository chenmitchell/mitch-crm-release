import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
export class PrismaModule {}
