// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Module } from '@nestjs/common';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ScopeModule } from '../scope/scope.module';

@Module({
  imports: [PrismaModule, ScopeModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
