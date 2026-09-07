// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 客戶階段與存證照片種類的出廠預設 —— 這裡只剩 seed SQL 的產生。
 *
 * 清單本身搬到 packages/shared(@mitchcrm/shared 的 dev-vocab.ts):
 * 前端在設定 API 還沒回來時要用同一份保底值,各留一份的結果是兩邊走散
 * (同一個 key 兩種標籤、兩種顏色),全新安裝時看板會先畫錯再跳掉。
 *
 * 這兩份清單是「第一次啟動要塞哪幾筆」,不是執行期的合法值來源 ——
 * 執行期一律以資料表為準(見 StageCatalogService),
 * 不然後台新增的階段會被程式碼裡的清單擋掉。
 *
 * key 一旦寫進 dev_customers.stage / dev_visit_photos.kind 就不可以再改:
 * 那是資料值,不是顯示文字。要改字請改 label。
 */
import {
  DEFAULT_CATEGORIES,
  DEFAULT_DEV_STAGES,
  DEFAULT_INTERACTION_CHANNELS,
  DEFAULT_PREMISES_TYPES,
  DEFAULT_VISIT_PHOTO_KINDS,
  type DefaultCategory,
  type DefaultDevStage,
  type DefaultInteractionChannel,
  type DefaultPremisesType,
  type DefaultVisitPhotoKind,
} from '@mitchcrm/shared';

export {
  DEFAULT_CATEGORIES,
  DEFAULT_DEV_STAGES,
  DEFAULT_INTERACTION_CHANNELS,
  DEFAULT_PREMISES_TYPES,
  DEFAULT_VISIT_PHOTO_KINDS,
};
export type {
  DefaultCategory,
  DefaultDevStage,
  DefaultInteractionChannel,
  DefaultPremisesType,
  DefaultVisitPhotoKind,
};

/** SQL 字串常值的跳脫(單引號加倍)。只給這份常數檔產生 seed 用,不對外。 */
function sqlText(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * 「這一筆出廠值被管理員刻意刪掉了」的墓碑表名。
 *
 * 為什麼需要它:五張主檔的 seed 是 `INSERT ... ON CONFLICT (key) DO NOTHING`,
 * 每次開機都跑。資料庫上沒有任何地方記著「這個 key 是被刪掉的,不是還沒建」,
 * 所以管理員刪掉的出廠階段(例如「報價中」)在下一次重啟時 ON CONFLICT 不命中,
 * 整列會用出廠的 label / color / sort_order / is_active=true 重新長回來 ——
 * 存檔成功、畫面正確,某天重啟之後看板自己多一欄,沒有錯誤訊息也沒有日誌。
 *
 * 修法有兩種,這裡選墓碑而不是「表空的時候才 seed」:
 *   - 「表空才 seed」最小,但會讓「日後新增一個出廠值」這條升級路徑整個失效
 *     (既有安裝的表永遠不是空的,新出廠值再也進不去),而這個 repo 的遷移
 *     機制正是靠純新增往後疊的。
 *   - 墓碑逐 key 記錄,seed 照舊往下疊,只跳過被刪掉的那幾個 key。
 *     管理員自己把同一個 key 加回來時墓碑會被清掉,行為回到出廠狀態。
 */
export const SEED_TOMBSTONE_TABLE = 'dev_seed_tombstones';

/** 五張可由後台增減的主檔。墓碑表用這個值分辨是哪一張表的 key */
export type SeedCatalog = 'stage' | 'photoKind' | 'channel' | 'premises' | 'category';

/**
 * ── seed 一定要自己填的那幾欄(2026-09-05 修)────────────────────────────
 *
 * 擋的錯誤:五張主檔有兩條建表路徑,而**兩條建出來的欄位預設值不一樣**。
 *
 *   路徑 A  表由 startup-migrations 的 `CREATE TABLE IF NOT EXISTS` 建
 *           → 每一欄都寫了 `DEFAULT`(id 是 gen_random_uuid()、兩個時間是 now())
 *   路徑 B  表由 `prisma db push` 建(deploy/backend-entrypoint.sh 的實際順序:
 *           db push 先跑,所以**正式安裝走的是這一條**)
 *           → `@updatedAt` 與 `@default(uuid())` 由 Prisma 在 client 端填值,
 *             資料庫上就是 `NOT NULL` 而**沒有** DEFAULT
 *
 * seed 是純 SQL 的 `INSERT`,不經過 Prisma client,所以在路徑 B 上,
 * 任何一欄沒寫進欄位清單就是 null,整句被 NOT NULL 擋掉:
 *
 *   ERROR:  null value in column "updated_at" of relation "dev_stages"
 *           violates not-null constraint
 *
 * 而 runStartupMigrations 是「失敗只記錄不中斷啟動」的,所以症狀是:開機日誌有
 * 五行警告、五張主檔一筆都沒有,系統退回程式裡的出廠清單照常運作,
 * 畫面上看起來完全正常,後台卻改不到任何一個階段、分類或場所類型。
 * 這正是「後台控制前台」第一條要防的事,而唯一看得出來的地方是那五行警告。
 *
 * 修法是兩層,缺一不可:
 *   1. 這裡把那幾欄明確寫進 INSERT(不依賴資料庫有沒有預設值,兩條路徑都會成功)
 *   2. startup-migrations 另有一組 `ALTER COLUMN ... SET DEFAULT` 把路徑 B 的表
 *      補成跟路徑 A 一樣(見 SEED_COLUMN_DEFAULT_STEPS)——
 *      那一層顧的是日後任何一支手寫 SQL、任何一個 DBA 手動補資料
 *
 * created_at 在 schema 上是 `@default(now())`,Prisma 會把它建成資料庫預設值,
 * 照理不必寫。仍然寫進來的理由是:這個 bug 本身就是「以為 Prisma 會建預設值」
 * 造成的,seed 不該再賭第二次。多寫一欄的代價是零。
 */
const SEED_GENERATED_COLUMNS: ReadonlyArray<readonly [column: string, expression: string]> = [
  ['id', 'gen_random_uuid()'],
  ['created_at', 'now()'],
  ['updated_at', 'now()'],
];

/** seed 會自己填值的欄位名(startup-migrations 與規格都讀這一份,不要各抄一份) */
export const SEED_GENERATED_COLUMN_NAMES: readonly string[] = SEED_GENERATED_COLUMNS.map(
  ([column]) => column,
);

/**
 * 產生「不存在才插入、而且跳過被刪掉的出廠代碼」的 seed SQL。
 *
 * 兩道守衛缺一不可:
 *   NOT EXISTS(墓碑) 擋的是「管理員刪過的出廠值不要再長回來」;
 *   ON CONFLICT DO NOTHING 擋的是「已經在的那一列不要被出廠值蓋掉」
 *   (後台改過的名稱、顏色、排序都在那一列上)。
 *
 * 這句 SQL 引用 SEED_TOMBSTONE_TABLE,所以建墓碑表那一步一定要排在所有 seed 之前
 * (見 startup-migrations.ts 的 SEED_TOMBSTONE_STEPS)—— PostgreSQL 在剖析階段就要
 * 解析得到這張表,用 to_regclass 之類的執行期判斷是繞不過去的。
 */
function seedInsertSql(
  table: string,
  columns: readonly string[],
  catalog: SeedCatalog,
  rows: readonly string[],
): string {
  // VALUES 那一段只放「每一筆都不一樣」的資料欄;id 與兩個時間是每一列各自算出來的,
  // 所以放在 SELECT 清單裡,不放進 VALUES(不然出廠清單每一筆都要自己抄一個 uuid)
  const valueCols = columns.join(', ');
  const cols = [...SEED_GENERATED_COLUMN_NAMES, ...columns].join(', ');
  const picked = [
    ...SEED_GENERATED_COLUMNS.map(([, expression]) => expression),
    ...columns.map((c) => `v.${c}`),
  ].join(', ');
  return `INSERT INTO ${table} (${cols})
    SELECT ${picked}
      FROM (VALUES
      ${rows.join(',\n      ')}
      ) AS v(${valueCols})
     WHERE NOT EXISTS (
       SELECT 1 FROM ${SEED_TOMBSTONE_TABLE} t
        WHERE t.catalog = ${sqlText(catalog)} AND t.key = v.key
     )
    ON CONFLICT (key) DO NOTHING`;
}

/** 產生「不存在才插入」的 seed SQL:重複執行不會改到後台已經調過的值 */
export function devStagesSeedSql(): string {
  return seedInsertSql(
    'dev_stages',
    ['key', 'label', 'color', 'sort_order', 'is_active', 'is_terminal'],
    'stage',
    DEFAULT_DEV_STAGES.map(
      (s) =>
        `(${sqlText(s.key)}, ${sqlText(s.label)}, ${sqlText(s.color)}, ${s.sortOrder}, true, ${s.isTerminal})`,
    ),
  );
}

export function visitPhotoKindsSeedSql(): string {
  return seedInsertSql(
    'visit_photo_kinds',
    ['key', 'label', 'sort_order', 'is_active'],
    'photoKind',
    DEFAULT_VISIT_PHOTO_KINDS.map(
      (k) => `(${sqlText(k.key)}, ${sqlText(k.label)}, ${k.sortOrder}, true)`,
    ),
  );
}

/** 互動管道的 seed。同樣是「不存在才插入」,後台改過的名稱不會被蓋回去 */
export function interactionChannelsSeedSql(): string {
  return seedInsertSql(
    'dev_interaction_channels',
    ['key', 'label', 'sort_order', 'is_active'],
    'channel',
    DEFAULT_INTERACTION_CHANNELS.map(
      (c) => `(${sqlText(c.key)}, ${sqlText(c.label)}, ${c.sortOrder}, true)`,
    ),
  );
}

/** 場所類型的 seed */
export function premisesTypesSeedSql(): string {
  return seedInsertSql(
    'dev_premises_types',
    ['key', 'label', 'sort_order', 'is_active'],
    'premises',
    DEFAULT_PREMISES_TYPES.map(
      (p) => `(${sqlText(p.key)}, ${sqlText(p.label)}, ${p.sortOrder}, true)`,
    ),
  );
}

/** 商業分類的 seed。同樣是「不存在才插入」,後台改過的名稱不會被蓋回去 */
export function categoriesSeedSql(): string {
  return seedInsertSql(
    'dev_categories',
    ['key', 'label', 'sort_order', 'is_active'],
    'category',
    DEFAULT_CATEGORIES.map((c) => `(${sqlText(c.key)}, ${sqlText(c.label)}, ${c.sortOrder}, true)`),
  );
}

/**
 * 表名 → 那一張主檔的 seed SQL。
 *
 * 為什麼要有這份對照:startup-migrations 要照這五張表產生「補上資料庫預設值」的步驟,
 * 規格也要照這五張表比對「seed 的欄位清單有沒有涵蓋不可為 null 又沒有預設值的欄位」。
 * 兩邊各自手抄一份表名清單的話,日後新增第六張主檔時漏抄的那一邊不會有任何地方紅,
 * 症狀又回到這次的樣子:seed 安靜地失敗,系統退回寫死的清單。
 */
export const SEED_SQL_BY_TABLE: Readonly<Record<string, () => string>> = {
  dev_stages: devStagesSeedSql,
  visit_photo_kinds: visitPhotoKindsSeedSql,
  dev_interaction_channels: interactionChannelsSeedSql,
  dev_premises_types: premisesTypesSeedSql,
  dev_categories: categoriesSeedSql,
};
