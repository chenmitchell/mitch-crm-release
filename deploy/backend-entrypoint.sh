#!/bin/sh
# ref:3687 mc/陳彥輔/米球®
# =============================================================
# Mitch CRM backend 容器啟動腳本
# =============================================================
# 做四件事,然後才把控制權交給 Node:
#
#   1. 金鑰:JWT 一把(這套系統只有登入權杖,沒有更新權杖),沒設就自動產生
#      並寫進 volume,讓「docker compose up -d」真的可以零設定啟動。
#   2. db push 之前的結構調整:enum 欄位轉文字、舊欄位改名。
#      ★ 對公開版本(0.1.0 起)而言這一步永遠不會實際動作:全新安裝的資料庫
#      一開始就是新形狀,每一步都用 information_schema 判斷「還是舊形狀才做」,
#      所以它只是空轉。留著是為了讓作者自己那套 0.1.0 之前的舊部署升得上來,
#      維護者不需要為它做任何事。
#      這一步一定要在 db push 之前,理由見下面第 2 節與
#      apps/backend/src/prisma/run-pre-push-migrations.ts 的說明。
#   3. 建表:用 prisma db push 對齊 schema(idempotent,重跑無害)。
#      程式內另外還有 startup-migrations 做增量 DDL,兩者互補。
#   4. exec 傳進來的指令(預設 node dist/main.js)。
#
# 已經在環境變數裡設好的值一律優先,這支腳本不會覆寫任何既有的值。
# 部署平台(例如 Zeabur)自己注入環境變數時,第 1 步整段是 no-op。
# =============================================================
set -e

SECRETS_DIR="${MITCHCRM_SECRETS_DIR:-/var/lib/mitchcrm/secrets}"
SECRETS_FILE="$SECRETS_DIR/app.env"
PRISMA_CLI_PATH="${PRISMA_CLI_PATH:-/opt/prisma-cli/node_modules/prisma/build/index.js}"

log() { echo "[entrypoint] $*"; }

# ── 1. 金鑰 ─────────────────────────────────────────────────
# 讀回上次產生的值。已經存在於環境變數的 key 不動(平台注入的值優先)。
#
# 整行讀進來再從第一個等號切開,不要用 IFS='=' read key value:
# 那樣寫的話行尾的 = 會被當成分隔符吃掉,而 base64 的 32 bytes 金鑰
# 結尾一定是 =,44 字元會變成 43,重啟後直接卡在 env 驗證起不來。
if [ -f "$SECRETS_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#* | =*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    eval "current=\${$key-}"
    if [ -z "$current" ]; then
      export "$key=$value"
    fi
  done < "$SECRETS_FILE"
fi

rand_hex() { node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))"; }

generated=''

ensure_secret() {
  name="$1"
  eval "current=\${$name-}"
  [ -n "$current" ] && return 0

  value="$(rand_hex)"

  if ! ( [ -d "$SECRETS_DIR" ] || mkdir -p "$SECRETS_DIR" 2>/dev/null ); then
    echo "[entrypoint] 錯誤:$name 沒有設定,而且金鑰目錄 $SECRETS_DIR 無法建立。" >&2
    echo "[entrypoint] 請在部署平台的環境變數設定 $name,或把一個可寫入的 volume 掛到 $SECRETS_DIR。" >&2
    exit 1
  fi
  if ! ( [ -f "$SECRETS_FILE" ] || : > "$SECRETS_FILE" ) 2>/dev/null; then
    echo "[entrypoint] 錯誤:$name 沒有設定,而且 $SECRETS_FILE 不可寫入。" >&2
    echo "[entrypoint] 請在部署平台的環境變數設定 $name,或改用可寫入的 volume。" >&2
    exit 1
  fi

  printf '%s=%s\n' "$name" "$value" >> "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
  export "$name=$value"
  generated="$generated $name"
}

# 只有一把:登入權杖是這套系統唯一的權杖,沒有更新權杖(refresh token),
# 還在操作的人靠滑動續期留著(見 apps/backend/src/auth/session-refresh.interceptor.ts)。
ensure_secret JWT_ACCESS_SECRET

if [ -n "$generated" ]; then
  log "已自動產生金鑰:$generated"
  log "存放位置:$SECRETS_FILE(容器內),對應 docker volume。"
  log "注意:正式環境請自行指定金鑰並離線備份。"
  log "注意:刪掉這個 volume 等同刪掉金鑰。備份方式見 README。"
fi

# ── 2. db push 之前的結構調整 ───────────────────────────────
# ★ 先講結論:公開版本(0.1.0 起)的安裝不會用到這一段。全新建立的資料庫
# 一開始就是新形狀,下面每一步都先問 information_schema「還是舊形狀嗎」,
# 答案永遠是否,所以整段是空轉,log 上會看到「0 個步驟就緒」之類的訊息。
# 這一段存在的理由只有一個:讓作者自己那套 0.1.0 之前的內部舊部署升得上來。
# 維護公開版本的人不需要為它做任何事,也不必為了新功能往裡面加東西
# (新的結構變更請走 startup-migrations 的純新增規則)。
#
# 以下說明的是那種舊部署的情形:
# 舊部署第一次升級時,資料庫裡 dev_customers.stage / dev_visit_photos.kind
# 還是 pg 的 enum 型別,而 schema.prisma 已經沒有那兩個 enum 了。
# enum → varchar 在 Postgres 需要顯式的 USING,prisma db push 非互動模式不會加,
# 所以 db push 會整包失敗(下面那一步只記警告不中斷)。
#
# 那一輪失敗的後果不只是這兩個欄位:**那一版 schema.prisma 裡所有其他的結構變更
# 也一起沒生效**,要等第二次重啟才會補上。升級的第一輪等於在賭那一版沒有別的變更。
#
# 所以先把那幾步用正確的 USING ::text 做掉,再讓 db push 跑。
# 這支永遠以 0 結束,連不到資料庫也不會擋住啟動。
PREPUSH_SCRIPT="${MITCHCRM_PREPUSH_SCRIPT:-/app/dist/prisma/run-pre-push-migrations.js}"
if [ -f "$PREPUSH_SCRIPT" ]; then
  log "db push 前的結構調整(舊部署才會實際動作)"
  node "$PREPUSH_SCRIPT" || log "警告:db push 前的結構調整沒跑完,繼續往下(啟動後還會再試一次)"
else
  log "找不到 $PREPUSH_SCRIPT,略過 db push 前的結構調整"
fi

# ── 3. 建表 ─────────────────────────────────────────────────
# MITCHCRM_SKIP_DB_PUSH=true 可以關掉(資料庫由 DBA 另外管控的環境)。
if [ "${MITCHCRM_SKIP_DB_PUSH:-false}" = 'true' ]; then
  log "MITCHCRM_SKIP_DB_PUSH=true,略過 prisma db push"
elif [ -f "$PRISMA_CLI_PATH" ] && [ -f /app/prisma/schema.prisma ]; then
  log "prisma db push(依 schema 對齊資料表,重複執行無害)"
  # 失敗不擋啟動:健康檢查會把問題顯示出來,而把整個服務停在這裡更難查。
  if ! node "$PRISMA_CLI_PATH" db push --skip-generate --schema=/app/prisma/schema.prisma; then
    log "警告:prisma db push 失敗。若資料表已存在可以忽略,否則請檢查 DATABASE_URL 與資料庫權限。"
  fi
else
  log "找不到 prisma CLI 或 schema,略過建表步驟"
fi

# ── 4. 交棒 ─────────────────────────────────────────────────
log "啟動:$*"
exec "$@"
