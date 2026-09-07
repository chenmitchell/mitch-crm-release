/**
 * 業務邀請模組。要在 app.module.ts 的 imports 加上 InvitesModule 才會生效。
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { Module } from '@nestjs/common';
import { InvitesAdminController, InvitesPublicController } from './invites.controller';
import { InvitesService } from './invites.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [InvitesAdminController, InvitesPublicController],
  providers: [InvitesService],
})
export class InvitesModule {}
