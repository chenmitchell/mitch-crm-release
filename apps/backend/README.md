# @mitchcrm/backend

Mitch CRM backend — NestJS 10 + Prisma + PostgreSQL 16。

> 監聽連接埠預設 8787。要換成別的值就設 `PORT` 環境變數,程式不用動:
> code 裡讀的一律是 `process.env.PORT ?? 8787`,不會 hardcode。
>
> 部署請看 `docs/`,那些文件不預設任何雲平台。

## 本地啟動

```bash
# 在 monorepo 根
pnpm install
cp apps/backend/.env.example apps/backend/.env

# 起一個本機 PostgreSQL 16(用 repo 根目錄那份 compose,只起資料庫)
docker compose up -d postgres
# 或用任何你手上既有的 PostgreSQL,把 DATABASE_URL 指過去就好

# 建表。這個 repo 沒有 prisma migrations 目錄,只有 schema.prisma,
# 所以走 db push,不是 migrate deploy。
pnpm --filter @mitchcrm/backend exec prisma db push

# 起 dev server
pnpm --filter @mitchcrm/backend dev
# 預設 listen localhost:8787
```

健康檢查:

- `curl http://localhost:8787/healthz` — 程序活著就回 200
- `curl http://localhost:8787/readyz` — 資料庫連得上回 200,連不上回 503(body 仍然帶 `db:"down"`)

## 硬性需求

- **Argon2id** 做密碼 hash(`argon2` 套件,非 bcrypt)
- 登入失敗 5 次鎖 30 分鐘
- JWT Access 8h,效期過半自動重簽(HttpOnly Cookie)
- 授權一律在後端做;查不到與沒權限回同一種訊息
- Microsoft Entra ID 單一登入是選用功能,不設對應的環境變數就完全不啟用

## 第一次啟動

一般安裝走首次啟動精靈,不用進機器:

- `GET /api/setup/status` 回 `{ initialized, templates }`,還沒建過帳號時 `initialized` 是 `false`
- `POST /api/setup` 建第一個管理員、寫入公司基本設定、套用客戶階段範本

已初始化之後這兩支端點一律拒絕。

自動化部署或救援時可以改用命令列:

```bash
# 一次性執行。除了建管理員,還會寫入署名紀錄。兩項都是 idempotent,重跑不會覆蓋既有資料。
pnpm --filter @mitchcrm/backend run seed:admin
```

`SEED_ADMIN_EMAIL` 與 `SEED_ADMIN_PASSWORD` 兩個都有值才會建帳號,密碼至少 12 個字元
(不足的話 env 驗證會在開機當下就 exit,不會起站之後才靜靜不建帳號),
建好的帳號標記為「下次登入必須改密碼」。跑完請把 `SEED_ADMIN_PASSWORD` 從環境變數移除,
它沒有 runtime 用途。**沒設密碼時不會建任何帳號,也不會產隨機密碼**,請改走 `/setup` 精靈:
以前那個隨機密碼行為會讓資料庫一開機就有帳號,精靈因此永遠不出現(見
`apps/backend/scripts/seed-admin.ts` 檔頭)。

## 系統設定

公司名稱、標誌文字、時區、地區、預設語言、對外聯絡資訊、地圖服務(Nominatim 聯絡信箱、
自訂 geocoder 位址)都存在資料庫,不寫在 code 裡:

- `GET /api/admin/app-settings`、`PUT /api/admin/app-settings`(寫入限系統管理員)
- `GET /api/public/settings` 是免登入的公開展示欄位,只回白名單那幾個

客戶階段(`dev_stages`)與存證照片種類(`visit_photo_kinds`)是可以增減的資料表,
啟動時自動建表並 seed 預設值。還有客戶或照片在用的項目不能刪除,只能停用。

組織部門(`departments`)支援多層,訪查主管的可見範圍是「自己的團隊(managerId 子樹)
加上所屬部門子樹」,計算在 `src/scope/`。

## 資料庫遷移

`src/prisma/startup-migrations.ts` 在服務啟動時執行,內容是純新增的 DDL 與 seed,
每一句都可以重複執行。單步失敗只記錄不中斷啟動。新增的步驟一律往後加,不要插進舊的中間。
