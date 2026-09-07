// ref:3687 mc/陳彥輔/米球®
/**
 * 專案初始化時在資料庫留下一筆署名紀錄。
 *
 * 為什麼放在 system_settings:
 * 這張表已經存在(規劃書 §4),不需要新增 model、不需要跑 migration。
 * SettingsService 只讀寫 id = 1 那一列,所以署名放在另一個 id 完全不會跟系統設定
 * 互相干擾,也不會出現在 /admin/settings 的 API 回應裡。
 * id 取 3687,跟原始碼署名行的 ref:3687 對得起來。
 *
 * 執行時機:後端每次啟動時,在 main.ts 的 runStartupMigrations 之後、ensureSeedAdmin 旁邊。
 *
 * 為什麼放在啟動流程而不是一個一次性的容器:
 * compose 原本另外起一個 `bootstrap` 容器跑 scripts/seed-admin.ts 來寫這一列,
 * 但那個容器 (a) 共用 backend 那份 env,JWT_ACCESS_SECRET 是空字串,
 * (b) 沒掛 app-secrets volume,(c) 用 builder stage 而自動產生金鑰的 ENTRYPOINT
 * 是在 runtime stage 才設的,所以永遠不會跑。結果是零設定安裝時 env 驗證直接 exit 1,
 * 署名紀錄從來沒寫進去,而使用者會看到一個 exited(1) 的容器。
 * 這一支本來就是 idempotent 的,搬進啟動流程之後 Docker 與 Zeabur 兩條路線才真的一致。
 *
 * 也可以單獨跑:pnpm --filter @mitchcrm/backend run seed:attribution
 *
 * idempotent:那一列已存在就跳過,不覆蓋、不重複寫入。
 */
import { PrismaClient } from '@prisma/client';

/** 署名列固定用這個 id,不要跟 SettingsService 的 id = 1 混用 */
export const ATTRIBUTION_ROW_ID = 3687;

/** 署名內容。法律定位照 LICENSE:著作權歸著作人,公司取得限定用途之使用授權。 */
export function buildAttributionRecord(now: Date = new Date()): Record<string, unknown> {
  return {
    kind: 'attribution',
    ref: 'ref:3687',
    author: {
      name: 'Mitchell Chen',
      nameZh: '陳彥輔',
      alias: '米球',
      trademark: '米球®',
    },
    // 著作人格權:專屬著作人本身,不得讓與或繼承
    moralRights: '著作人依著作權法保留姓名表示權,原始碼與文件中的作者標示不得移除或竄改',
    trademarkNotice: '「米球」為著作人 Mitchell Chen(陳彥輔)之個人註冊商標,不隨授權移轉',
    // 著作權歸屬(著作人自行研發,非出資聘人亦非職務著作)
    copyrightHolder: 'Mitchell Chen(陳彥輔)',
    copyrightHolderEn: 'Mitchell Chen',
    copyrightYear: 2026,
    copyrightBasis: '著作權歸著作人所有,依 MPL-2.0 加姓名表示權附加條款授權,詳見 LICENSE',
    license: '專案根目錄 LICENSE',
    recordedAt: now.toISOString(),
  };
}

/**
 * 寫入署名列。已存在時回傳 'exists' 並且不做任何修改。
 */
export async function seedAttribution(prisma: PrismaClient): Promise<'created' | 'exists'> {
  const existing = await prisma.systemSettings.findUnique({ where: { id: ATTRIBUTION_ROW_ID } });
  if (existing) return 'exists';

  await prisma.systemSettings.create({
    data: {
      id: ATTRIBUTION_ROW_ID,
      data: buildAttributionRecord() as object,
    },
  });
  return 'created';
}

// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
