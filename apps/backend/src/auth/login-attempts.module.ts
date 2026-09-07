// ref:3687 mc/陳彥輔/米球®
/**
 * LoginAttemptsService 的容身之處,與 SessionUserModule 同樣做成 @Global。
 *
 * 理由一樣:狀態在記憶體裡,只有「大家拿到同一個實例」才有意義。
 * 登入(AuthModule)寫入計數,使用者管理(UsersModule)的解鎖與重設密碼要清掉它,
 * 各自 new 一份的話,管理員按了解鎖而那個人還是進不來,畫面上看不出任何原因。
 */
import { Global, Module } from '@nestjs/common';
import { LoginAttemptsService } from './login-attempts.service';

@Global()
@Module({
  providers: [LoginAttemptsService],
  exports: [LoginAttemptsService],
})
export class LoginAttemptsModule {}
