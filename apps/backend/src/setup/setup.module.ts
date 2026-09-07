// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Module } from '@nestjs/common';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { AppSettingsModule } from '../app-settings/app-settings.module';

@Module({
  imports: [PrismaModule, SettingsModule, AppSettingsModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
