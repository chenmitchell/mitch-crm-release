// ref:3687 mc/陳彥輔/米球®
/**
 * 署名紀錄的命令列版。
 *
 * 實作在 src/setup/seed-attribution.ts,後端每次啟動也會跑同一支(見 src/main.ts),
 * 所以正常安裝不需要手動執行這裡。留著是為了救援:
 * 那一列被人刪掉、或是要在不重啟服務的情況下補寫時,直接跑
 *   pnpm --filter @mitchcrm/backend run seed:attribution
 *
 * idempotent:那一列已存在就跳過,不覆蓋、不重複寫入。
 */
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/common/env';
import { ATTRIBUTION_ROW_ID, seedAttribution } from '../src/setup/seed-attribution';

export {
  ATTRIBUTION_ROW_ID,
  buildAttributionRecord,
  seedAttribution,
} from '../src/setup/seed-attribution';

async function main(): Promise<void> {
  // 單獨跑這支時也要走同一條 env 路徑:loadEnv() 會先把 .env 併進 process.env
  // 再驗證,不然 PrismaClient 會拿不到 DATABASE_URL(路線 B 的部署就是這樣死的)。
  loadEnv();
  const prisma = new PrismaClient();
  try {
    const result = await seedAttribution(prisma);
    console.log(
      result === 'created'
        ? `[seed-attribution] 已寫入署名紀錄 system_settings#${ATTRIBUTION_ROW_ID}`
        : `[seed-attribution] system_settings#${ATTRIBUTION_ROW_ID} 已存在,略過`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed-attribution] failed:', err);
    process.exit(1);
  });
}
