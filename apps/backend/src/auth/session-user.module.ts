// ref:3687 mc/陳彥輔/米球®
/**
 * SessionUserService 的容身之處,刻意做成 @Global。
 *
 * 授權判斷(JwtStrategy)與「會讓授權失效的寫入點」(users、auth 的改密碼)
 * 分屬不同模組,而快取只有同一個實例才有意義:各模組各自 new 一份的話,
 * 使用者管理那邊按了停用,JwtStrategy 那一份快取完全不知情。
 * 全域註冊一次,大家拿到的是同一個物件。
 */
import { Global, Module } from '@nestjs/common';
import { SessionUserService } from './session-user.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [SessionUserService],
  exports: [SessionUserService],
})
export class SessionUserModule {}
// ref:3687 mc/陳彥輔/米球®
