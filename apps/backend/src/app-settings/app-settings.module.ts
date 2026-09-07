// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { Module } from '@nestjs/common';
import { AppSettingsController } from './app-settings.controller';
import { AppSettingsService } from './app-settings.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { StageCatalogModule } from './stage-catalog.module';

@Module({
  imports: [PrismaModule, SettingsModule, StageCatalogModule],
  controllers: [AppSettingsController],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class AppSettingsModule {}
