/**
 * 啟動時套用的資料庫遷移(additive-only)。
 *
 * 為什麼要有這支:部署平台的網頁終端機不一定能用(貼上失效、面板渲染不出來),
 * 而「程式已經上線但資料表還沒建」是最糟的中間狀態 —— 使用者一點就報錯。
 * 所以把這一批純新增的 DDL 放進啟動流程,部署完成即生效,不必有人手動連進資料庫。
 *
 * 規則:
 * 1. 只放 additive 的敘述(ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX
 *    IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING / DO 區塊包住的 constraint 與 enum),
 *    絕不放 DROP TABLE、DROP COLUMN、UPDATE、DELETE。
 *
 *    兩個例外(★ 這兩個例外對公開版本的安裝來說永遠是空轉,見 PRE_DB_PUSH_STEPS
 *    上方的說明。維護者不需要為它們做任何事,新的結構變更一律走純新增規則):
 *    (a)「列舉欄位改成文字欄位」那四步(dev_customers.stage、dev_visit_photos.kind、
 *        dev_interactions.channel、dev_customers.premises_type)。
 *        階段、照片種類、互動管道與場所類型都要能由後台增減,就不能繼續是 pg 的 enum 型別。那幾步用
 *        `USING <欄位>::text` 轉,值一個字都不會變,而且用 information_schema 判斷
 *        「還是 enum 才做」,跑幾次都只會生效一次。
 *        ★ 這幾步**本身**不刪列舉型別,但別誤會成「型別會一直留著所以隨時回得去」——
 *          schema.prisma 已經沒有 DevStage / VisitPhotoKind 了,下一次成功的
 *          `prisma db push` 會把這兩個型別 DROP 掉。要回滾到還在用 enum 的舊版程式,
 *          必須自己先把型別建回來。
 *    (b) 欄位改名 converted_application_id → external_case_ref(RENAME,資料不動)。
 *    這兩個例外同時列在 PRE_DB_PUSH_STEPS,由 entrypoint 在 db push 之前先跑一次,
 *    理由見該常數的說明。
 * 2. 每一句都要能重複執行,啟動幾次跑幾次都不會壞。
 * 3. 一句一句送。Prisma 走 extended protocol,一次一句;DO 區塊本身算一句。
 * 4. 失敗只記錄不中斷啟動:遷移沒過頂多是新功能不能用,把整個服務擋下來反而更糟。
 *
 * 想手動執行的部署方可以把每一步的 SQL 直接抄出來跑,內容一模一樣。
 *
 * ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
 */
import { Logger } from '@nestjs/common';
import {
  devStagesSeedSql,
  interactionChannelsSeedSql,
  categoriesSeedSql,
  premisesTypesSeedSql,
  visitPhotoKindsSeedSql,
  SEED_GENERATED_COLUMN_NAMES,
  SEED_SQL_BY_TABLE,
} from '../app-settings/app-settings.constants';

export interface StartupMigrationStep {
  /** 記錄用的名字,失敗時看得出是哪一句 */
  readonly name: string;
  readonly sql: string;
  /**
   * 這一步失敗會讓「後台控制前台」整條斷掉(目前只有五張主檔的出廠 seed)。
   *
   * 為什麼要分等級:失敗只記錄不中斷啟動是對的(擋下整個服務更糟),但**不是每一種
   * 失敗的後果都一樣**。少一個索引是慢一點;五張主檔一筆都沒進去,則是整套業務語彙
   * 退回程式裡寫死的清單 —— 畫面上完全正常,後台卻改不到任何一個階段、分類或場所類型,
   * 而唯一的線索是開機日誌裡一行跟其他警告長得一模一樣的 WARN。
   * 標了這一格的步驟失敗時另外走 logger.error,並且把後果寫成人看得懂的一句話。
   */
  readonly critical?: boolean;
}

/**
 * ── 必須在 `prisma db push` **之前**執行的那幾步 ──────────────────────────
 *
 * ★ 先講結論:公開版本(0.1.0 起)的安裝跑不到這幾步的實際動作。
 * 全新建立的資料庫一開始就是新形狀(schema.prisma 裡沒有 enum、欄位叫
 * external_case_ref),而每一步都先問 information_schema「還是舊形狀嗎」,
 * 答案永遠是否,所以它們只是空轉。留著的唯一理由,是讓作者自己那套 0.1.0
 * 之前的內部舊部署升得上來 —— 公開版本沒有任何一個 tag 有過 enum 型別或
 * converted_application_id 這個欄位名。維護這個 repo 的人不必把下面描述的
 * 升級情境當成自己要面對的事,也不要把新的結構變更加進這一組。
 *
 * 為什麼要獨立成一組:容器的啟動順序是
 *   deploy/backend-entrypoint.sh → prisma db push → node dist/main.js → runStartupMigrations()
 * 也就是 db push 跑在 Node 之前。而 schema.prisma 已經把 DevStage / VisitPhotoKind /
 * DevChannel / PremisesType 四個 enum 整個刪掉了,對「還是 enum 的舊資料庫」來說,db push 要做的是
 * enum 欄位改成 varchar —— PostgreSQL 對這種轉型要求顯式的 `USING`,
 * db push 在非互動模式下不會加,整包 push 因此失敗。
 * entrypoint 只記一行警告就繼續,接著 Node 這邊才用正確的 `USING ::text` 轉掉。
 *
 * 結果是:**任何只寫在 schema.prisma、沒有寫進 startup-migrations 的結構變更,
 * 在升級的那一輪不會生效**,要等第二次重啟 db push 才會成功。
 * converted_application_id 改名 external_case_ref 也是同一種情形(db push 看到的是
 * 「要丟掉一個有資料的欄位」)。
 *
 * 所以把這幾步提到 db push 之前跑(entrypoint 呼叫 dist/prisma/run-pre-push-migrations.js)。
 * 跑完之後資料庫的形狀已經跟 schema.prisma 對得上,db push 第一次就會成功。
 *
 * 這幾步同時仍然留在 ALL_STARTUP_MIGRATION_STEPS 裡(位置沒變),
 * 因為不是每種部署都會經過 entrypoint:MITCHCRM_SKIP_DB_PUSH=true、
 * 或直接 `node dist/main.js` 的部署方式一樣要能轉型。
 * 每一步都用 information_schema 判斷「還是舊形狀才做」,跑兩次的第二次是 no-op。
 */
export const ENUM_TO_TEXT_STEPS: readonly StartupMigrationStep[] = [
  {
    // 只有在欄位還是列舉型別時才動;轉完之後這一步每次啟動都是 no-op。
    // 值以 ::text 原樣保留。
    // 註:列舉型別本身這裡不刪,但 schema.prisma 已經沒有它們了,
    // 所以下一次成功的 db push 會把型別 DROP 掉 —— 舊註解寫的「留著才回得去」
    // 在 schema 刪掉 enum 之後就不成立了,不要再依賴那個說法。
    // 真的要回滾舊版程式,得自己先把 enum 型別建回來。
    name: 'dev_customers.stage 改為文字欄位',
    sql: `DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dev_customers' AND column_name = 'stage' AND data_type = 'USER-DEFINED'
      ) THEN
        ALTER TABLE dev_customers ALTER COLUMN stage DROP DEFAULT;
        ALTER TABLE dev_customers ALTER COLUMN stage TYPE varchar(40) USING stage::text;
        ALTER TABLE dev_customers ALTER COLUMN stage SET DEFAULT 'lead';
      END IF;
    END $$`,
  },
  {
    name: 'dev_visit_photos.kind 改為文字欄位',
    sql: `DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dev_visit_photos' AND column_name = 'kind' AND data_type = 'USER-DEFINED'
      ) THEN
        ALTER TABLE dev_visit_photos ALTER COLUMN kind DROP DEFAULT;
        ALTER TABLE dev_visit_photos ALTER COLUMN kind TYPE varchar(40) USING kind::text;
        ALTER TABLE dev_visit_photos ALTER COLUMN kind SET DEFAULT 'other';
      END IF;
    END $$`,
  },
  {
    // 互動管道要能由後台增減,同樣不能繼續是 pg 的列舉型別。轉法與上面兩步一樣。
    name: 'dev_interactions.channel 改為文字欄位',
    sql: `DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dev_interactions' AND column_name = 'channel' AND data_type = 'USER-DEFINED'
      ) THEN
        ALTER TABLE dev_interactions ALTER COLUMN channel DROP DEFAULT;
        ALTER TABLE dev_interactions ALTER COLUMN channel TYPE varchar(40) USING channel::text;
        ALTER TABLE dev_interactions ALTER COLUMN channel SET DEFAULT 'note';
      END IF;
    END $$`,
  },
  {
    // 場所類型同理。這一欄可為 null,所以不設 DEFAULT。
    name: 'dev_customers.premises_type 改為文字欄位',
    sql: `DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dev_customers' AND column_name = 'premises_type' AND data_type = 'USER-DEFINED'
      ) THEN
        ALTER TABLE dev_customers ALTER COLUMN premises_type DROP DEFAULT;
        ALTER TABLE dev_customers ALTER COLUMN premises_type TYPE varchar(40) USING premises_type::text;
      END IF;
    END $$`,
  },
];

/**
 * 舊欄位名改成中性的 external_case_ref。同樣要在 db push 之前做,理由見上面。
 * 公開版本的資料庫從來沒有 converted_application_id 這個欄位,所以這一步永遠是 no-op。
 */
export const COLUMN_RENAME_STEP: StartupMigrationStep = {
  name: 'dev_customers.external_case_ref 欄位改名',
  sql: `DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dev_customers' AND column_name = 'converted_application_id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dev_customers' AND column_name = 'external_case_ref'
      ) THEN
        ALTER TABLE dev_customers RENAME COLUMN converted_application_id TO external_case_ref;
      END IF;
    END $$`,
};

/**
 * entrypoint 在 `prisma db push` 之前會跑的那一組(順序有意義:先改名再轉型,
 * 兩者互不相干,但固定順序才讓 log 讀起來一致)。
 */
export const PRE_DB_PUSH_STEPS: readonly StartupMigrationStep[] = [
  COLUMN_RENAME_STEP,
  ...ENUM_TO_TEXT_STEPS,
];

/** 2026-09-03 客戶管理 CRM 第三階段:團隊歸屬、邀請連結、拜訪排程 */
export const CRM_PHASE3_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'users.manager_id 欄位',
    sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id uuid NULL',
  },
  {
    name: 'users.manager_id 外鍵',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_manager_id_fkey') THEN
        ALTER TABLE users ADD CONSTRAINT users_manager_id_fkey
          FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$`,
  },
  {
    name: 'users.manager_id 索引',
    sql: 'CREATE INDEX IF NOT EXISTS users_manager_id_idx ON users(manager_id)',
  },
  {
    name: 'dev_invites 資料表',
    sql: `CREATE TABLE IF NOT EXISTS dev_invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash varchar(64) NOT NULL UNIQUE,
      created_by_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      role "UserRole" NOT NULL DEFAULT 'sales',
      expires_at timestamptz NOT NULL,
      used_at timestamptz NULL,
      used_by_user_id uuid NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'dev_invites 索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_invites_created_by_id_created_at_idx ON dev_invites(created_by_id, created_at)',
  },
  {
    name: 'VisitPlanStatus 列舉型別',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisitPlanStatus') THEN
        CREATE TYPE "VisitPlanStatus" AS ENUM ('planned','done','missed','cancelled');
      END IF;
    END $$`,
  },
  {
    name: 'dev_visit_plans 資料表',
    sql: `CREATE TABLE IF NOT EXISTS dev_visit_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES dev_customers(id) ON DELETE CASCADE ON UPDATE CASCADE,
      owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      planned_date date NOT NULL,
      status "VisitPlanStatus" NOT NULL DEFAULT 'planned',
      interaction_id uuid NULL,
      note varchar(200) NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (customer_id, planned_date)
    )`,
  },
  {
    name: 'dev_visit_plans 負責人與日期索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_visit_plans_owner_id_planned_date_idx ON dev_visit_plans(owner_id, planned_date)',
  },
  {
    name: 'dev_visit_plans 日期與狀態索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_visit_plans_planned_date_status_idx ON dev_visit_plans(planned_date, status)',
  },
];

/**
 * 2026-09-04 通用化第一階段:可設定的客戶階段 / 照片種類、組織部門、初始化精靈。
 *
 * 順序有意義:先把主檔表建好並 seed,再把 dev_customers.stage 從列舉換成文字。
 * 反過來的話,轉型完成到 seed 完成之間,看板會查不到任何階段定義。
 *
 * 註:走容器 entrypoint 的部署,轉型那兩步在 `prisma db push` 之前就已經做完了
 * (見 PRE_DB_PUSH_STEPS),所以這裡跑到的是 no-op。那個時間點服務還沒開始 listen,
 * 上面說的空窗期在使用者面前不存在。
 */
export const APP_SETTINGS_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_stages 資料表',
    sql: `CREATE TABLE IF NOT EXISTS dev_stages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(40) NOT NULL UNIQUE,
      label varchar(40) NOT NULL,
      color varchar(20) NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      is_terminal boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'dev_stages 排序索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_stages_sort_order_idx ON dev_stages(sort_order)',
  },
  {
    name: 'dev_stages 預設階段',
    sql: devStagesSeedSql(),
    // 失敗等於整套業務語彙退回寫死的清單,後台改不到(見 StartupMigrationStep.critical)
    critical: true,
  },
  {
    name: 'visit_photo_kinds 資料表',
    sql: `CREATE TABLE IF NOT EXISTS visit_photo_kinds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(40) NOT NULL UNIQUE,
      label varchar(40) NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'visit_photo_kinds 排序索引',
    sql: 'CREATE INDEX IF NOT EXISTS visit_photo_kinds_sort_order_idx ON visit_photo_kinds(sort_order)',
  },
  {
    name: 'visit_photo_kinds 預設種類',
    sql: visitPhotoKindsSeedSql(),
    // 失敗等於整套業務語彙退回寫死的清單,後台改不到(見 StartupMigrationStep.critical)
    critical: true,
  },
  {
    name: 'departments 資料表',
    sql: `CREATE TABLE IF NOT EXISTS departments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(100) NOT NULL,
      parent_id uuid NULL REFERENCES departments(id) ON DELETE SET NULL ON UPDATE CASCADE,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'departments 上層索引',
    sql: 'CREATE INDEX IF NOT EXISTS departments_parent_id_idx ON departments(parent_id)',
  },
  {
    name: 'departments 排序索引',
    sql: 'CREATE INDEX IF NOT EXISTS departments_sort_order_idx ON departments(sort_order)',
  },
  {
    name: 'users.department_id 欄位',
    sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id uuid NULL',
  },
  {
    name: 'users.department_id 外鍵',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_department_id_fkey') THEN
        ALTER TABLE users ADD CONSTRAINT users_department_id_fkey
          FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$`,
  },
  {
    name: 'users.department_id 索引',
    sql: 'CREATE INDEX IF NOT EXISTS users_department_id_idx ON users(department_id)',
  },
  ...ENUM_TO_TEXT_STEPS,
];

/**
 * 2026-09-04 通用化第二階段:看板欄位與表單下拉的顯示開關。
 *
 * 前端的階段設定有「出現在看板」與「出現在表單下拉」兩個勾選,原本後端沒有對應的
 * 欄位可存 —— 存不下去的結果是使用者改了、存檔成功、重整之後又變回去。
 * 兩欄都預設 true,既有部署套用之後行為不變。
 */
export const STAGE_DISPLAY_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_stages.show_on_board 欄位',
    sql: 'ALTER TABLE dev_stages ADD COLUMN IF NOT EXISTS show_on_board boolean NOT NULL DEFAULT true',
  },
  {
    name: 'dev_stages.show_in_form 欄位',
    sql: 'ALTER TABLE dev_stages ADD COLUMN IF NOT EXISTS show_in_form boolean NOT NULL DEFAULT true',
  },
];

/**
 * 2026-09-04 查重合併的資料完整性約束,以及外部案件編號欄位改名。
 *
 * 1. dev_customers 的「合併到哪一筆」不能指向自己。自我指向會讓查重頁把同一筆
 *    當成「已被合併」而永遠撈不回來,而且合併鏈的走訪會無限繞。
 *    這道 CHECK 以前只寫在 schema.prisma 的註解裡,repo 內沒有任何 SQL 會建它 ——
 *    也就是照著這個 repo 裝起來的資料庫,全部沒有這道約束。補在這裡。
 *
 * 2. converted_application_id 改名成中性的 external_case_ref。這一步是
 *    「舊欄位還在、新欄位還沒有」時才做的 RENAME,資料原封不動,跑幾次都只會生效一次;
 *    全新安裝根本走不到。
 *    這一步同時列在 PRE_DB_PUSH_STEPS 裡,由 entrypoint 在 `prisma db push` 之前先做完
 *    (不然 db push 會看到「要丟掉一個有資料的欄位」而整包失敗)。這裡留著是給
 *    沒有經過 entrypoint 的部署方式用的,跑到時已經是 no-op。
 */
export const CRM_INTEGRITY_STEPS: readonly StartupMigrationStep[] = [
  COLUMN_RENAME_STEP,
  {
    name: 'dev_customers.merged_into_id 不得指向自己',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'dev_customers_merged_into_id_not_self'
      ) THEN
        ALTER TABLE dev_customers ADD CONSTRAINT dev_customers_merged_into_id_not_self
          CHECK (merged_into_id IS NULL OR merged_into_id <> id) NOT VALID;
      END IF;
    END $$`,
  },
];

/**
 * 2026-09-04 通用化第三階段:互動管道與場所類型改成可設定的主檔。
 *
 * 這兩份清單原本寫死在程式碼裡(後端的 CHANNELS / PREMISES_TYPES 常數、前端客戶卡的
 * 中文對照表),違反「後台控制前台」:換一個行業就得改程式重新部署。
 * 做法比照 dev_stages / visit_photo_kinds:建表、seed,欄位從列舉轉成文字。
 *
 * 這裡只有建表與 seed。兩個欄位的轉型放在 ENUM_TO_TEXT_STEPS(跟階段、照片種類同一組),
 * 那一組已經在 APP_SETTINGS_STEPS 裡跑過,而且 entrypoint 會在 `prisma db push`
 * 之前先跑一次 —— 再列一次只會讓步驟名稱重複,失敗回報就指不出是哪一步。
 * 轉型與建表誰先誰後不影響結果:轉的是欄位型別,值一個字都不會變。
 */
export const VOCAB_CATALOG_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_interaction_channels 資料表',
    sql: `CREATE TABLE IF NOT EXISTS dev_interaction_channels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(40) NOT NULL UNIQUE,
      label varchar(40) NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'dev_interaction_channels 排序索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_interaction_channels_sort_order_idx ON dev_interaction_channels(sort_order)',
  },
  {
    name: 'dev_interaction_channels 預設管道',
    sql: interactionChannelsSeedSql(),
    // 失敗等於整套業務語彙退回寫死的清單,後台改不到(見 StartupMigrationStep.critical)
    critical: true,
  },
  {
    name: 'dev_premises_types 資料表',
    sql: `CREATE TABLE IF NOT EXISTS dev_premises_types (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(40) NOT NULL UNIQUE,
      label varchar(40) NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'dev_premises_types 排序索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_premises_types_sort_order_idx ON dev_premises_types(sort_order)',
  },
  {
    name: 'dev_premises_types 預設場所類型',
    sql: premisesTypesSeedSql(),
    // 失敗等於整套業務語彙退回寫死的清單,後台改不到(見 StartupMigrationStep.critical)
    critical: true,
  },
];

/**
 * 2026-09-04 登入權杖的即時撤銷。
 *
 * 為什麼要這一欄:JWT 是一次簽死的,改密碼、重設密碼之前簽出去的權杖在效期內
 * 照樣通行。停用與降級可以靠「每次請求回查 users 這一列」擋掉(那是狀態,現在的值
 * 就是真相),但「密碼換過了」不是一個看得出來的狀態 —— 舊權杖裡沒有任何欄位
 * 會因為換密碼而改變。所以另外記一格時間,讓 JwtStrategy 拿權杖的 iat 去比。
 *
 * 既有部署套用之後是 NULL,代表「沒有換過密碼的紀錄」,不擋任何既有的登入,
 * 使用者不會在升級的那一刻被全部踢下線。
 */
export const SESSION_REVOCATION_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'users.password_changed_at 欄位',
    sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NULL',
  },
];

/**
 * 2026-09-04 錯誤記錄的保留期與同訊息合併。
 *
 * 為什麼要這兩欄:error_logs 原本只寫不刪也不合併,同一種錯誤被打一萬次就是一萬列
 * (每列 message 1000 字 + stack 8000 字)。加 fingerprint 之後,同一個指紋在
 * 保留期內只留一列,重複的併進 seen_count;過了保留期的整列刪掉。
 * 兩欄都可為 NULL,既有資料不動。
 */
export const ERROR_LOG_RETENTION_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'error_logs.fingerprint 欄位',
    sql: 'ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS fingerprint varchar(64) NULL',
  },
  {
    name: 'error_logs.seen_count 欄位',
    sql: 'ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS seen_count integer NOT NULL DEFAULT 1',
  },
  {
    name: 'error_logs.last_seen_at 欄位',
    sql: 'ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NULL',
  },
  {
    name: 'error_logs 指紋索引',
    sql: 'CREATE INDEX IF NOT EXISTS error_logs_fingerprint_idx ON error_logs(fingerprint, created_at)',
  },
];

/**
 * 2026-09-04 商業分類主檔(dev_categories)。
 *
 * 這份清單原本寫死在前端,後台完全改不到,違反「前台不得出現寫死的業務用語清單」。
 * 純新增:建表 + 索引 + 出廠分類,不動 dev_customers.category 既有的值 ——
 * 那一格存的是分類的顯示文字或代碼,由使用者自己維護,強制對應只會把舊資料洗掉。
 */
export const CATEGORY_CATALOG_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_categories 資料表',
    sql: `CREATE TABLE IF NOT EXISTS dev_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key varchar(40) NOT NULL UNIQUE,
      label varchar(40) NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
  },
  {
    name: 'dev_categories 排序索引',
    sql: 'CREATE INDEX IF NOT EXISTS dev_categories_sort_order_idx ON dev_categories(sort_order)',
  },
  {
    name: 'dev_categories 預設商業分類',
    sql: categoriesSeedSql(),
    // 失敗等於整套業務語彙退回寫死的清單,後台改不到(見 StartupMigrationStep.critical)
    critical: true,
  },
];

/**
 * 2026-09-05 email 的大小寫唯一性。
 *
 * users.email 是 `@unique`,而 PostgreSQL 的唯一索引區分大小寫(schema 沒有 citext),
 * 所以 `Alice@Example.com` 與 `alice@example.com` 在資料庫眼裡是兩個不同的值,
 * 同一個人可以有兩個帳號。程式碼那一層已經在所有寫入點正規化(見 common/email.ts),
 * 這一條是資料庫層的最後一道 —— 少了它,日後任何一個漏掉正規化的新寫入點
 * 都會安靜地製造重複帳號,而唯一的症狀是「某個人 SSO 登入拿到了另一個帳號」。
 *
 * ★ 既有資料可能已經有大小寫不同的重複。這種資料庫上 `CREATE UNIQUE INDEX` 一定失敗,
 *   而 runStartupMigrations 是「失敗只記錄不中斷啟動」的,所以那會變成一行沒有人看的
 *   警告,管理員不知道自己少了一道防線。因此這一步包成 DO 區塊:
 *     有重複  → 不建索引,用 RAISE WARNING 明確說出「有幾組重複要先處理」
 *     沒重複  → 建立唯一索引
 *   兩條路都不會讓啟動失敗,也都不會動到任何一列資料(符合 additive-only)。
 *   管理員處理完重複之後,下一次重啟這一步就會把索引建起來。
 *
 * 找重複的 SQL(要自己查的人可以直接抄):
 *   SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
 *
 * ── 為什麼這一條只寫在這裡、沒有寫進 schema.prisma(2026-09-05 實測確認)──
 * 這是一個 functional index(建在 `lower(email)` 這個運算式上,不是建在欄位上),
 * Prisma 的 schema 語法表達不出來,所以寫不進 schema.prisma。
 *
 * 「entrypoint 每次啟動都跑 prisma db push,db push 會把不在 schema 裡的索引 diff 成
 * DROP,然後才由 startup migrations 補建回來」這個推論**不成立**,實測結果:
 *   建一張表,手動建四種索引再跑 db push,只有普通索引被 drop:
 *     plain_idx           (普通索引)              → 被 DROP
 *     plain_uniq_idx      (普通唯一索引)          → 被 DROP
 *     users_email_lower_key(運算式唯一索引)       → 留著
 *     expr_nonuniq_idx    (運算式索引)            → 留著
 *     dev_customers_external_case_ref_live_key(部分唯一索引)→ 留著
 *     partial_nonuniq_idx (部分索引)              → 留著
 *   接著用這個 repo 真正的 schema.prisma 建一套空庫,把整組 startup migrations 套上去,
 *   再跑一次 db push:回報 "The database is already in sync",一條索引都沒有掉。
 * 原因是 Prisma 的 schema describer 表達不了運算式與部分索引,那兩種索引在它眼裡
 * 根本不存在,自然也不會被 diff 出 DROP。反過來說,**普通索引如果只寫在
 * startup migrations 而沒有寫進 schema.prisma,就真的會每次開機被 drop 再重建** ——
 * 所以這一批裡每一條普通索引都在 schema.prisma 有對應的 @@index / @@unique,
 * 新增普通索引時兩邊都要寫(startup-migrations.spec.ts 有一條測試在盯 company_name 那一條)。
 *
 * 實測環境:PostgreSQL 16.13,Prisma CLI 6.19.3 的 WASM schema engine
 * (這個容器連不到 binaries.prisma.sh,拿不到 repo 釘住的 5.22.0 那顆 Rust engine;
 * 兩者共用同一份 sql-schema-describer 的行為,結論對 5.22 一樣適用,
 * 但如果哪天有人在真實部署上看到索引被 drop,請以那個為準並回來改掉這一段)。
 *
 * 順帶一提旗標:deploy/backend-entrypoint.sh 跑的是
 * `prisma db push --skip-generate --schema=...`,沒有 `--accept-data-loss`。
 * 那個旗標管的是「會弄丟資料的變更」(丟欄位、改型別),drop 索引不算在內 ——
 * 上面那個實測就是在沒有這個旗標的情況下把兩條普通索引 drop 掉的,
 * 所以不能靠「沒加旗標」來保護任何索引。
 *
 * 因為索引根本不會被 drop,也就沒有「重建期間唯一性有空窗」這回事:
 * db push 從頭到尾不會碰這兩條索引,唯一性沒有斷過。
 */
export const EMAIL_CASE_UNIQUE_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'users.email 忽略大小寫的唯一索引',
    sql: `DO $$
    DECLARE dup_count integer;
    BEGIN
      SELECT count(*) INTO dup_count FROM (
        SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
      ) d;
      IF dup_count > 0 THEN
        RAISE WARNING '有 % 組 email 只差在大小寫的重複帳號,users_email_lower_key 未建立。請先處理重複(SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1),下次重啟會自動補上', dup_count;
      ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
      END IF;
    END $$`,
  },
];

/**
 * 2026-09-05 每人每日上傳配額用的索引。
 *
 * 為什麼要:新增的「每位使用者每天累計上傳位元組」檢查會沿著
 * dev_visit_photos → dev_interactions 算某位使用者今天寫進去的總量,
 * 過濾條件是 created_at 落在組織時區的今天。沒有這個索引的話,
 * 每一次上傳都要掃整張照片表 —— 而那張表正是這個配額要保護的對象,
 * 它越大檢查越慢,剛好是最不該慢的時候。
 * 純新增,重複執行沒有副作用。
 */
export const UPLOAD_QUOTA_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_visit_photos 建立時間索引(每人每日上傳配額)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_visit_photos_created_at_idx ON dev_visit_photos(created_at)',
  },
  {
    name: 'dev_visit_photos 互動索引(配額要沿著互動找上傳者)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_visit_photos_interaction_id_idx ON dev_visit_photos(interaction_id)',
  },
];

/**
 * 2026-09-05 出廠設定的墓碑表(dev_seed_tombstones)。
 *
 * 擋的錯誤:五張主檔的 seed 是 `INSERT ... ON CONFLICT (key) DO NOTHING`,每次開機都跑,
 * 而資料庫上沒有任何地方記著「這一筆是被管理員刻意刪掉的」。結果是後台刪掉的出廠值
 * (可刪的共 39 筆:階段 5、照片種類 7、互動管道 5、場所類型 2、商業分類 20)
 * 在下一次重啟時 ON CONFLICT 不命中,整列用出廠的 label / color / sort_order /
 * is_active=true 重新插回來。使用者的感受是「存檔成功、畫面正確,某天重啟之後
 * 看板自己多一欄」,沒有錯誤訊息也沒有日誌,再刪一次下次還是會回來。
 *
 * 這張表逐 key 記下「刪過了」,seed 那五句加一道 NOT EXISTS 跳過它們。
 * 管理員把同一個 key 加回來時墓碑會被清掉(見 AppSettingsService),
 * 行為回到出廠狀態。
 *
 * ★ 排序上的例外:這一組**排在 ALL_STARTUP_MIGRATION_STEPS 的最前面**,不是最後面。
 *   seed 的 SQL 直接引用 dev_seed_tombstones,PostgreSQL 在剖析階段就要解析得到這張表
 *   (to_regclass 之類的執行期判斷繞不過剖析),所以建表一定要先做。
 *   這一步本身是 CREATE TABLE IF NOT EXISTS,對既有資料庫沒有任何副作用,
 *   放在最前面不會讓已上線的資料庫走到不同的路徑。
 */
export const SEED_TOMBSTONE_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_seed_tombstones 資料表(被刪掉的出廠代碼)',
    sql: `CREATE TABLE IF NOT EXISTS dev_seed_tombstones (
      catalog varchar(40) NOT NULL,
      key varchar(40) NOT NULL,
      deleted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (catalog, key)
    )`,
  },
];

/**
 * 2026-09-05 五張主檔的 id 與時間欄補上資料庫預設值。
 *
 * 擋的錯誤:同一張表有兩條建法,而兩條建出來的欄位預設值不一樣。
 *
 *   表由這支的 `CREATE TABLE IF NOT EXISTS` 建   → 三欄都有 DEFAULT
 *   表由 `prisma db push` 建                     → id(@default(uuid()))與
 *     updated_at(@updatedAt)由 Prisma 在 client 端填,資料庫上只有 NOT NULL,
 *     **沒有** DEFAULT
 *
 * 而 deploy/backend-entrypoint.sh 的順序是 `prisma db push` 先跑,所以照文件裝起來的
 * 正式安裝走的是後面那一條。實測(PostgreSQL 16.13)的症狀是五張主檔的出廠 seed 全部
 * 撞 not-null:
 *
 *   ERROR:  null value in column "updated_at" of relation "dev_stages"
 *           violates not-null constraint
 *
 * 五張表 seed 完是 0 筆,而整個系統照常啟動、畫面照常顯示七個階段與二十個分類 ——
 * 那些全是程式裡的保底清單,後台一個字都改不到。
 *
 * 第一層修正在 seed 自己(app-settings.constants.ts 把那幾欄明確寫進 INSERT),
 * 這一組是第二層:把 db push 建出來的表補成跟遷移建出來的一模一樣,
 * 讓日後任何一支手寫 SQL、任何一個 DBA 手動補資料都不必知道這個坑。
 *
 * 為什麼放在所有建表與 seed 的後面:五張表分散在三組建表步驟裡(APP_SETTINGS_STEPS、
 * VOCAB_CATALOG_STEPS、CATEGORY_CATALOG_STEPS),排在最後才保證每一張都已經存在。
 * seed 不依賴這一組(它自己填值),所以先後順序不影響 seed 的結果。
 *
 * additive-only:SET DEFAULT 只影響「沒有寫到這一欄」的 INSERT,不動任何一列既有資料,
 * 重跑幾次結果都一樣。DO 區塊裡先問 to_regclass,表還沒建出來時整步是 no-op 而不是失敗。
 *
 * ★ 每次開機都要跑一次的理由:`prisma db push` 有可能把它看不順眼的預設值 diff 掉
 *   (schema.prisma 上那兩欄的預設值是 client 端語意,不是資料庫預設值)。
 *   entrypoint 的順序是 db push 先、這一批後,所以就算被拿掉,同一輪開機就補回來。
 */
export const SEED_COLUMN_DEFAULT_STEPS: readonly StartupMigrationStep[] = Object.keys(
  SEED_SQL_BY_TABLE,
).map((table) => ({
  name: `${table} 的 ${SEED_GENERATED_COLUMN_NAMES.join(' / ')} 補上資料庫預設值`,
  sql: `DO $$ BEGIN
      IF to_regclass('public.${table}') IS NOT NULL THEN
        ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT gen_random_uuid();
        ALTER TABLE ${table} ALTER COLUMN created_at SET DEFAULT now();
        ALTER TABLE ${table} ALTER COLUMN updated_at SET DEFAULT now();
      END IF;
    END $$`,
}));

/**
 * 2026-09-05 客戶軟刪除與匯入批次識別碼。
 *
 * 擋的錯誤:在這之前系統沒有任何刪除客戶的路徑。匯錯一批(欄位錯位、編碼壞掉、
 * 同事重複匯同一份)之後,那批假資料永久留在秒查、看板、查重、統計與地圖裡,
 * 唯一的軟路徑是逐筆改成終止階段,硬路徑是連進資料庫下 DELETE。
 *
 * 四個純新增欄位:
 *   deleted_at / deleted_by_id / delete_reason  軟刪除的標記與原因
 *   import_batch_id                             同一次匯入寫進來的每一筆共用同一個值
 * 加上兩個索引:回收桶按 deleted_at 撈,整批刪除按 import_batch_id 撈。
 *
 * 舊版程式回滾安全:舊程式不認得這四欄,它的查詢不帶 deleted_at IS NULL,
 * 症狀是被刪掉的客戶重新出現在清單上,不會壞掉也不會掉資料。
 */
export const SOFT_DELETE_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_customers.deleted_at 欄位(軟刪除)',
    sql: 'ALTER TABLE dev_customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz',
  },
  {
    name: 'dev_customers.deleted_by_id 欄位(誰刪的)',
    sql: 'ALTER TABLE dev_customers ADD COLUMN IF NOT EXISTS deleted_by_id uuid',
  },
  {
    name: 'dev_customers.delete_reason 欄位(刪除原因)',
    sql: 'ALTER TABLE dev_customers ADD COLUMN IF NOT EXISTS delete_reason varchar(300)',
  },
  {
    name: 'dev_customers.import_batch_id 欄位(匯入批次)',
    sql: 'ALTER TABLE dev_customers ADD COLUMN IF NOT EXISTS import_batch_id uuid',
  },
  {
    name: 'dev_customers 軟刪除索引(回收桶)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_customers_deleted_at_idx ON dev_customers(deleted_at)',
  },
  {
    name: 'dev_customers 匯入批次索引(整批刪除)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_customers_import_batch_id_idx ON dev_customers(import_batch_id)',
  },
];

/**
 * 2026-09-05 外部案件編號的唯一性(只算活著的那些)。
 *
 * dev_customers.external_case_ref 是「成交後對應到外部系統的案件編號」,規格上
 * 一個編號只能對到一位客戶,而資料庫上一直沒有任何東西替我們守這一條:
 * 標記成交那一支自己查(而且刻意放行回收桶裡的那筆),還原那一端再查一次。
 * 兩道都是應用層的 check-then-act,在 READ COMMITTED 底下沒有謂詞鎖 ——
 * 「還原 A」與「把同一個編號標記到 B」同時發生時,兩邊各自查對方,
 * 對方當下都還不算活著,於是兩邊都放行。整批還原那條路徑更直接:
 * 同一批被還原的那些筆彼此看不見對方(已在程式碼那一層補上,見 CrmDeletionService)。
 *
 * 這一條是最終防線,partial index —— 條件是 `WHERE deleted_at IS NULL`:
 * 回收桶裡的那些不佔編號(那正是標記成交刻意放行的前提),還原時才會撞。
 *
 * ★ 既有資料可能已經有活著的重複,做法照 EMAIL_CASE_UNIQUE_STEPS 那一步:
 *   有重複  → 不建索引,RAISE WARNING 說出有幾組
 *   沒重複  → 建立唯一索引
 *   兩條路都不動任何一列資料(符合 additive-only),也都不會讓啟動失敗。
 *   ★★ 但 RAISE WARNING 只會進 PostgreSQL 的 server log,管理員看不到。
 *      所以另外有一支開機自我檢查會把同一件事寫進 error_logs(後台的錯誤記錄頁),
 *      見 prisma/migration-warnings.ts。少了那一支,「你少了一道防線」這句話
 *      只存在於一個大部分部署方都讀不到的地方。
 *
 * 既有重複最常見的來源是**查重合併**:合併把被併掉那筆的案件編號抄給保留筆,
 * 而被併掉那筆自己那一格沒有清掉,且它的 deleted_at 是 null(它是「已合併」
 * 不是「已刪除」)。這個行為已經修掉(見 crm-duplicates.service 的第 3 / 5 步),
 * 但**修正之前**合併過的資料仍然帶著重複,所以這一步一定要能容忍既有重複。
 *
 * 找重複的 SQL(要自己查的人可以直接抄):
 *   SELECT external_case_ref, count(*) FROM dev_customers
 *   WHERE deleted_at IS NULL AND external_case_ref IS NOT NULL
 *   GROUP BY 1 HAVING count(*) > 1;
 *
 * 舊版程式回滾安全:索引只是多一道約束,舊程式的寫入路徑本來就不該產生重複。
 *
 * ── 為什麼這一條只寫在這裡、沒有寫進 schema.prisma ─────────────────
 * 這是一個 partial index(帶 `WHERE deleted_at IS NULL`),Prisma 的 schema 語法
 * 表達不出來。db push 不會把它 diff 成 DROP,實測與理由見 EMAIL_CASE_UNIQUE_STEPS
 * 上方那一段「為什麼這一條只寫在這裡」,兩條的情形一模一樣。
 */
export const EXTERNAL_CASE_REF_INDEX = 'dev_customers_external_case_ref_live_key';

export const EXTERNAL_CASE_REF_UNIQUE_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_customers.external_case_ref 唯一索引(只算未刪除的)',
    sql: `DO $$
    DECLARE dup_count integer;
    BEGIN
      SELECT count(*) INTO dup_count FROM (
        SELECT external_case_ref FROM dev_customers
        WHERE deleted_at IS NULL AND external_case_ref IS NOT NULL
        GROUP BY external_case_ref HAVING count(*) > 1
      ) d;
      IF dup_count > 0 THEN
        RAISE WARNING '有 % 組外部案件編號同時掛在兩筆以上未刪除的客戶身上,${EXTERNAL_CASE_REF_INDEX} 未建立。請先處理重複(SELECT external_case_ref, count(*) FROM dev_customers WHERE deleted_at IS NULL AND external_case_ref IS NOT NULL GROUP BY 1 HAVING count(*) > 1),下次重啟會自動補上', dup_count;
      ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS ${EXTERNAL_CASE_REF_INDEX}
          ON dev_customers (external_case_ref) WHERE deleted_at IS NULL;
      END IF;
    END $$`,
  },
];

/**
 * 2026-09-05 dev_customers.merged_into_id 的索引。
 *
 * 擋的錯誤:這一欄一直沒有任何索引。它沒有外鍵(合併保留筆被永久刪除時要清得掉
 * 指標,見 CrmDeletionService.unlinkMergedInto 的說明),所以資料庫不會自動替它
 * 建一條,而 Prisma 的 schema 裡也沒有寫。走它的路徑有三條:
 *
 *   lockCustomerAndMergedSources  永久刪除前一次鎖住「這一筆 + 併進它的那些」
 *   unlinkMergedInto              永久刪除時把懸空的指標清掉
 *   countableCustomerWhere()      清單 / 看板 / 漏斗 / 統計 / 匯出的共同口徑,
 *                                 每一句都帶 merged_into_id IS NULL
 *
 * 前兩條是 `WHERE merged_into_id = $1`,沒有索引就是整表 Seq Scan,而且是在一筆
 * 已經握著列鎖的交易裡;第三條是全站最常跑的查詢。二十萬列的實測是 13.4ms 一次。
 *
 * 舊版程式回滾安全:索引只是查詢加速,沒有任何語意。
 */
export const MERGED_INTO_INDEX_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_customers 合併指標索引(查重合併 / 永久刪除 / 清單口徑)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_customers_merged_into_id_idx ON dev_customers(merged_into_id)',
  },
];

/**
 * 2026-09-05 dev_interactions 的兩條時間索引。
 *
 * 擋的錯誤:這張表在兩年、四十萬列之後,只有 customer_id 與 user_id 兩條單欄索引,
 * 而真正在跑的查詢都帶時間條件或時間排序:
 *
 *   打卡假定位偵測  WHERE user_id = $1 AND channel='visit' AND occurred_at >= now()-2h
 *                   ORDER BY occurred_at DESC LIMIT 1(每一次打卡都跑一次)
 *   主管可疑打卡表  WHERE channel='visit' AND occurred_at >= $1 ORDER BY occurred_at DESC
 *   戰情 / 日報彙整  WHERE occurred_at >= $1 GROUP BY user_id, channel
 *   最近聯絡        WHERE occurred_at >= $1 GROUP BY customer_id
 *   互動匯出        ORDER BY occurred_at DESC, id ASC OFFSET $1 LIMIT $2
 *
 * 四十萬列的實測(PostgreSQL 16、shared_buffers 128MB):
 *   打卡偵測那一句  38.1ms / 6672 個 buffer  →  0.11ms / 8 個 buffer
 *   可疑打卡表      70.4ms                   →  6.1ms
 *   匯出第一頁      214.5ms                  →  31.4ms
 *   匯出第十頁      406.4ms、外部排序寫 52MB  →  204.1ms、不再落磁碟
 *
 * 最後一項是這兩條索引真正要擋的事:小機器上把整批互動匯出去,原本每翻一頁
 * 就往磁碟寫一次 52MB 的暫存檔,八十頁就是 4GB 的寫入。
 *
 * 舊版程式回滾安全:索引只是查詢加速,沒有任何語意。
 * user_id 單欄索引照舊留著(純新增,不動既有結構)。
 */
export const INTERACTION_TIME_INDEX_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_interactions 使用者加時間索引(打卡假定位偵測)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_interactions_user_id_occurred_at_idx ON dev_interactions(user_id, occurred_at)',
  },
  {
    name: 'dev_interactions 發生時間索引(統計 / 最近聯絡 / 匯出排序)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_interactions_occurred_at_idx ON dev_interactions(occurred_at)',
  },
];

/**
 * 2026-09-05 dev_customers.company_name 索引。
 *
 * 匯入時的整批查重是一句
 *   WHERE deleted_at IS NULL AND (tax_id IN (...) OR company_name IN (...))
 * PostgreSQL 對 OR 只有在**兩邊都有索引**時才走 BitmapOr;有一邊沒有索引,
 * 整句就退回 Seq Scan。tax_id 那一邊本來就有索引,company_name 這一邊沒有,
 * 所以那一句實際上一直在掃整張 dev_customers,而且每匯入一批就掃一次 ——
 * 五萬筆的部署匯入一次要多讀整張表。
 *
 * 舊版程式回滾安全:索引只是查詢加速,沒有任何語意。
 */
export const CUSTOMER_NAME_INDEX_STEPS: readonly StartupMigrationStep[] = [
  {
    name: 'dev_customers 公司名索引(匯入查重)',
    sql: 'CREATE INDEX IF NOT EXISTS dev_customers_company_name_idx ON dev_customers(company_name)',
  },
];

/**
 * 啟動時實際會跑的全部步驟(依序)。
 * 新的一批一律往後加,不要插進舊的中間 —— 順序改了,已上線的資料庫會走到不同的路徑。
 */
export const ALL_STARTUP_MIGRATION_STEPS: readonly StartupMigrationStep[] = [
  // 墓碑表要排在所有 seed 之前,理由見 SEED_TOMBSTONE_STEPS 的說明
  ...SEED_TOMBSTONE_STEPS,
  ...CRM_PHASE3_STEPS,
  ...APP_SETTINGS_STEPS,
  ...STAGE_DISPLAY_STEPS,
  ...CRM_INTEGRITY_STEPS,
  ...VOCAB_CATALOG_STEPS,
  ...SESSION_REVOCATION_STEPS,
  ...ERROR_LOG_RETENTION_STEPS,
  ...CATEGORY_CATALOG_STEPS,
  ...EMAIL_CASE_UNIQUE_STEPS,
  ...UPLOAD_QUOTA_STEPS,
  ...SOFT_DELETE_STEPS,
  ...EXTERNAL_CASE_REF_UNIQUE_STEPS,
  ...MERGED_INTO_INDEX_STEPS,
  ...INTERACTION_TIME_INDEX_STEPS,
  ...CUSTOMER_NAME_INDEX_STEPS,
  // 五張主檔都建完之後才補預設值,理由見 SEED_COLUMN_DEFAULT_STEPS
  ...SEED_COLUMN_DEFAULT_STEPS,
];

/**
 * ── 併發啟動的互斥(2026-09-05 新增)────────────────────────────────
 *
 * 擋的錯誤:兩個容器同時啟動時,兩邊各自跑同一批 DDL。
 * 最終狀態其實是對的(每一句都是 IF NOT EXISTS,兩邊跑完的聯集就是全套),
 * 壞的是**過程與訊息**:同一句 `CREATE INDEX IF NOT EXISTS` 兩邊同時送,
 * PostgreSQL 會讓其中一邊拿不到鎖或撞上 duplicate key,那一步在輸的那一邊
 * 算失敗,於是啟動日誌印出「相關功能可能無法使用」—— 而其實什麼都沒少。
 * 接在後面跑的 reportMigrationWarnings 更糟:它在贏的那一邊還沒 commit 的
 * 空窗裡去看索引在不在,看到的是「不在」,就往 error_logs 寫一列叫管理員
 * 去處理重複資料的警告,而重複根本不存在。滾動更新或 `--scale backend=2`
 * 的部署方每升級一次就多一列查不出東西的嚴重警告。
 *
 * 做法:整批 DDL 包在一筆交易裡,交易開頭先取 advisory lock。
 *
 * 為什麼是 pg_advisory_xact_lock 而不是 pg_advisory_lock:
 *   session 版的鎖綁在**取得它的那條連線**上,而 Prisma 是連線池 ——
 *   解鎖那一句可能被送到另一條連線,解不掉,那把鎖就會留在池子裡的某條連線上
 *   直到行程結束。下一輪滾動更新的新容器全部拿不到鎖,遷移從此不再執行,
 *   而且沒有任何錯誤訊息。xact 版綁交易,commit 或 rollback 一定放掉,
 *   而交易客戶端本來就保證是同一條連線。做法與 settings/settings-lock.ts 一致。
 *
 * 為什麼包成一筆交易之後單步失敗還是不會拖垮其他步驟:
 *   每一步前面下一個 SAVEPOINT,失敗就 ROLLBACK TO SAVEPOINT 再繼續下一步。
 *   少了這個,PostgreSQL 在第一次錯誤之後會把整筆交易標成 aborted,
 *   後面每一句都回 25P02,行為會從「失敗一步」變成「失敗全部」。
 *   這一批 DDL 沒有任何一句不能放在交易裡(沒有 CREATE INDEX CONCURRENTLY、
 *   沒有 VACUUM、沒有 ALTER TYPE ADD VALUE),所以包起來是安全的。
 *
 * 拿不到鎖時要等還是跳過:**先等,等到上限就跳過**。
 *   等的理由:對方跑的是一模一樣的一整套,等它跑完,我們這一輪的每一句都是
 *   no-op,不會有假的失敗訊息,接在後面的防線盤點也讀得到已經 commit 的狀態。
 *   要有上限的理由:不能讓啟動無限期卡住。對方如果掛在半路(容器被 OOM 殺掉、
 *   資料庫連線斷),鎖會隨著它的交易結束而放掉,我們在上限內就等得到;
 *   真的等不到就跳過這一輪並明講「跳過」,不要印成失敗 —— 這一輪跳過的代價
 *   只是新結構晚一次重啟才生效,而印成失敗會讓人去追一個不存在的問題。
 */

/**
 * 啟動遷移的 advisory lock 鍵。
 * 既有的鍵:安裝精靈 3687_0001、後台設定 3687_0002、上傳配額命名空間 3687_0003。
 * 新增的鍵一律往下接,不要沿用別人的。
 */
export const STARTUP_MIGRATION_LOCK_KEY = 3687_0004;

/** 等鎖的上限。超過就跳過這一輪,不擋啟動 */
export const LOCK_WAIT_TIMEOUT_MS = 60_000;
/** 等鎖的重試間隔 */
export const LOCK_POLL_INTERVAL_MS = 500;
/** 整批 DDL 的交易上限。空轉的一輪是毫秒等級,這個值是留給「大表上第一次建索引」的 */
export const MIGRATION_TX_TIMEOUT_MS = 10 * 60_000;
/** 從連線池等一條連線的上限 */
export const MIGRATION_TX_MAX_WAIT_MS = 30_000;
/** SAVEPOINT 的名字。固定一個就夠:每一步都重新宣告,後宣告的蓋掉前一個 */
const STEP_SAVEPOINT = 'mitchcrm_startup_migration_step';

/**
 * 這支需要的三件事:送 DDL、查一句拿得到回傳值(取鎖)、開交易。
 * 後兩者是選填:測試餵的假物件只實作 $executeRawUnsafe,那種情況退回不加鎖的逐句執行
 * (行為與加鎖之前完全相同),不必為了測試去湊一整個 Prisma 客戶端。
 */
export interface RawExecutor {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe?<T = unknown>(sql: string): Promise<T>;
  $transaction?<R>(
    fn: (tx: RawExecutor) => Promise<R>,
    options?: { readonly timeout?: number; readonly maxWait?: number },
  ): Promise<R>;
}

export interface StartupMigrationResult {
  readonly applied: number;
  readonly failed: readonly string[];
  /** true = 沒拿到鎖(別的實例正在跑同一批),這一輪整個沒跑,不是失敗 */
  readonly skipped: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** pg_try_advisory_xact_lock 回一個布林。拿到回 true,已經被別人握著回 false(不阻塞) */
async function tryLock(tx: RawExecutor): Promise<boolean> {
  const query = tx.$queryRawUnsafe;
  if (!query) return true;
  const rows = await query.call(
    tx,
    `SELECT pg_try_advisory_xact_lock(${STARTUP_MIGRATION_LOCK_KEY}) AS locked`,
  );
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  return first?.locked === true;
}

/** 等到拿得到鎖為止,或等到上限。回 false = 這一輪跳過 */
async function acquireLock(tx: RawExecutor, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await tryLock(tx)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

/**
 * 這支要的 logger。error 是選填:測試餵的假物件只有 log 與 warn,
 * 而正式跑的時候拿到的是 NestJS 的 Logger,四種等級都有。
 */
export type MigrationLogger = Pick<Logger, 'log' | 'warn'> & Partial<Pick<Logger, 'error'>>;

/**
 * 關鍵步驟失敗時要說的那一句。純函式,規格直接比字串。
 *
 * 要說三件事:哪幾步、後果是什麼、怎麼確認。只寫「步驟未完成」的話,
 * 讀到的人不知道那代表整套業務語彙已經退回寫死的清單 —— 而畫面上完全看不出來,
 * 系統會照常運作、照常顯示出廠的階段與分類,只是後台改不到。
 */
export function criticalFailedMessage(failedNames: readonly string[]): string {
  return (
    `資料庫的出廠主檔沒有寫進去:${failedNames.join('、')}。` +
    '系統會照常啟動,畫面上也會照常出現階段、分類與場所類型,但那是程式裡的保底清單,' +
    '後台的系統設定改不到它們,改了也不會生效。' +
    '請確認資料庫裡這幾張主檔的筆數(例如 select count(*) from dev_stages),' +
    '處理完之後重新啟動一次就會補上。'
  );
}

/**
 * 逐句送出。useSavepoint=true 時每一步包一個 SAVEPOINT,
 * 失敗就回捲到那個點,讓後面的步驟仍然跑得下去(交易裡的必要條件,見上面的說明)。
 * 不記錄 SQL 內文與資料庫回傳的細節,只記步驟名與錯誤型別。
 */
async function sendSteps(
  db: RawExecutor,
  steps: readonly StartupMigrationStep[],
  logger: MigrationLogger,
  useSavepoint: boolean,
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    if (useSavepoint) await db.$executeRawUnsafe(`SAVEPOINT ${STEP_SAVEPOINT}`);
    try {
      await db.$executeRawUnsafe(step.sql);
      if (useSavepoint) await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${STEP_SAVEPOINT}`);
    } catch (err) {
      failed.push(step.name);
      const kind = err instanceof Error ? err.name : 'UnknownError';
      logger.warn(`資料庫遷移步驟未完成:${step.name}(${kind})`);
      if (useSavepoint) await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${STEP_SAVEPOINT}`);
    }
  }
  return failed;
}

/**
 * 失敗清單裡的 critical 步驟另外走一次 logger.error。
 *
 * 為什麼要獨立成一支:critical 的升級以前只寫在 summarise 裡,而 summarise 只有
 * 「逐句送完」那一條路徑會走到。整筆交易不成立時(逾時、連線斷、拿不到連線)
 * 是**每一步都算失敗**,五張主檔的 seed 當然也在裡面,後果跟五步各自失敗完全一樣,
 * 但那條路徑當時只印一行「這一輪沒有套用」的 WARN,升級最嚴重的那一種失敗
 * 反而是唯一沒有被升級的。兩條路徑現在共用這一支。
 */
function reportCriticalFailures(
  steps: readonly StartupMigrationStep[],
  failed: readonly string[],
  logger: MigrationLogger,
): void {
  const criticalFailed = steps
    .filter((step) => step.critical === true && failed.includes(step.name))
    .map((step) => step.name);
  if (criticalFailed.length === 0) return;
  const message = criticalFailedMessage(criticalFailed);
  // logger.error 是選填:測試餵的假 logger 只有 log / warn。沒有就退回 warn,
  // 訊息本身一個字都不少 —— 分級是加強,不是把話藏起來的條件
  if (logger.error) logger.error(message);
  else logger.warn(message);
}

function summarise(
  steps: readonly StartupMigrationStep[],
  failed: readonly string[],
  logger: MigrationLogger,
): StartupMigrationResult {
  const applied = steps.length - failed.length;
  if (failed.length === 0) logger.log(`資料庫遷移檢查完成,${applied} 個步驟就緒`);
  else {
    logger.warn(`資料庫遷移有 ${failed.length} 個步驟未完成,相關功能可能無法使用`);
    // 出廠 seed 失敗的後果跟「少一個索引」不是同一個等級,不能只留一行長得一樣的警告
    reportCriticalFailures(steps, failed, logger);
  }
  return { applied, failed, skipped: false };
}

/**
 * 依序送出每一句。單句失敗只記錄並繼續,回傳結果讓呼叫端決定要不要提醒。
 *
 * 併發互斥見上面那一大段:整批包一筆交易,開頭取 advisory lock,拿不到就先等,
 * 等超過 LOCK_WAIT_TIMEOUT_MS 才跳過。跳過會回 skipped:true,不算失敗。
 */
export async function runStartupMigrations(
  db: RawExecutor,
  steps: readonly StartupMigrationStep[] = ALL_STARTUP_MIGRATION_STEPS,
  logger: MigrationLogger = new Logger('StartupMigrations'),
  /** 等鎖的上限,只有測試會傳(預設 LOCK_WAIT_TIMEOUT_MS) */
  options: { readonly lockWaitMs?: number } = {},
): Promise<StartupMigrationResult> {
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_TIMEOUT_MS;
  if (typeof db.$transaction !== 'function' || typeof db.$queryRawUnsafe !== 'function') {
    // 沒有交易能力的客戶端(測試的假物件)退回加鎖之前的行為:逐句送、不互斥
    return summarise(steps, await sendSteps(db, steps, logger, false), logger);
  }

  try {
    return await db.$transaction<StartupMigrationResult>(
      async (tx) => {
        if (!(await acquireLock(tx, lockWaitMs))) {
          logger.log(
            `另一個實例正在套用同一批資料庫遷移(等超過 ${Math.round(lockWaitMs / 1000)} 秒),` +
              '這一輪跳過。最終結構由那一邊補齊,沒有步驟遺漏',
          );
          return { applied: 0, failed: [], skipped: true } satisfies StartupMigrationResult;
        }
        return summarise(steps, await sendSteps(tx, steps, logger, true), logger);
      },
      { timeout: MIGRATION_TX_TIMEOUT_MS, maxWait: MIGRATION_TX_MAX_WAIT_MS },
    );
  } catch (err) {
    // 整筆交易沒成立(逾時、連線斷、拿不到連線)。這一輪一句都沒生效,
    // 下一次重啟會再跑一次;不擋啟動,理由與單步失敗相同。
    const kind = err instanceof Error ? err.name : 'UnknownError';
    logger.warn(`資料庫遷移這一輪沒有套用(${kind}),下一次重新啟動會再試一次`);
    const failed = steps.map((s) => s.name);
    // 一步都沒生效,也就是五張主檔的出廠 seed 同樣沒進去。後果與逐句失敗一模一樣,
    // 所以同樣要升級成 error,不能只留上面那一行看起來像暫時性問題的 WARN
    reportCriticalFailures(steps, failed, logger);
    return { applied: 0, failed, skipped: false };
  }
}
