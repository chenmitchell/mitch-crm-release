import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { ScopeModule } from '../scope/scope.module';

@Module({
  // SettingsModule:M365 同步回來的部門 / 辦公室存 system_settings id=4,
  // 使用者清單要一併顯示,才看得出來組織資料到底有沒有同步進來
  imports: [PrismaModule, SettingsModule, ScopeModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
export class UsersModule {}
