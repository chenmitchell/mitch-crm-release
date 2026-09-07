#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Mitch CRM — 一鍵初始化
#
# 做三件事:
#   1. 從 .env.example 產生 .env
#   2. 產生資料庫密碼與 JWT 簽章金鑰填進去
#   3. 提醒把金鑰離線備份
#
# 請在**第一次 docker compose up 之前**跑。已經跑過 compose 的話,
# postgres 的資料目錄已經用舊密碼初始化過了,這支腳本產生的新
# POSTGRES_PASSWORD 不會被套用,backend 會連不上資料庫
# (log 出現 password authentication failed)。腳本偵測到既有的
# postgres-data volume 時會先提醒。
#
# 已經有 .env 就不動它,只檢查有沒有缺值。要重新產生請自己先改名或刪掉。
#
# 用法:bash scripts/setup.sh
# ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/.env"
EXAMPLE_FILE="$REPO/.env.example"

if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "找不到 $EXAMPLE_FILE,請確認在 repo 根目錄執行" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "找不到 openssl。這支腳本用它產生金鑰,請先安裝:" >&2
  echo "  Debian/Ubuntu: apt-get install -y openssl" >&2
  echo "  RHEL/Rocky   : dnf install -y openssl" >&2
  echo "  macOS        : 系統內建,或 brew install openssl" >&2
  exit 1
fi

# ── 已存在就不覆蓋 ─────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "偵測到既有的 .env,不覆蓋。"
  echo ""
  MISSING=""
  for key in POSTGRES_PASSWORD JWT_ACCESS_SECRET; do
    value="$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
    if [ -z "$value" ]; then
      MISSING="$MISSING $key"
    fi
  done
  if [ -n "$MISSING" ]; then
    # 這兩個留空**不會**讓服務起不來,compose 與 entrypoint 都有 fallback。
    # 但兩個 fallback 的代價不一樣,所以分開講,不要嚇人也不要含糊帶過。
    echo "以下兩項是空的:"
    for k in $MISSING; do echo "  - $k"; done
    echo ""
    echo "空著也起得來,但要知道代價:"
    echo "  POSTGRES_PASSWORD  空 = 用 docker-compose.yml 裡的明文預設值 mitchcrm,"
    echo "                     那個值在公開 repo 上人人看得到。正式環境請填。"
    echo "                     產生指令:openssl rand -hex 24"
    echo "                     ★ 只有第一次啟動(資料目錄還是空的)才套用得上,"
    echo "                       已經 up 過就要進資料庫 ALTER USER,或 down -v 重來。"
    echo "  JWT_ACCESS_SECRET  空 = backend 第一次啟動自動產生一把,寫進 app-secrets"
    echo "                     volume,那份是唯一副本,volume 沒了全體要重新登入。"
    echo "                     要自己指定:openssl rand -base64 48"
    exit 0
  fi
  echo "兩項都有值。要重新產生請先把 .env 改名或刪掉再跑一次。"
  exit 0
fi

# ── 已經跑過 compose 的話先提醒 ─────────────────────────────
# postgres 官方映像只在資料目錄是空的時候拿 POSTGRES_PASSWORD 建帳號。
# volume 已經存在就代表密碼早就定下來了,這裡新產生的那組套不上去,
# 起站之後 backend 會卡在 password authentication failed。
if command -v docker >/dev/null 2>&1; then
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx 'mitchcrm_postgres-data'; then
    echo "偵測到既有的資料庫 volume(mitchcrm_postgres-data),代表這套已經啟動過。" >&2
    echo "" >&2
    echo "現在產生新的 POSTGRES_PASSWORD 會讓 backend 連不上資料庫:" >&2
    echo "資料庫裡的密碼是第一次啟動時定下來的,不會因為改 .env 而變。" >&2
    echo "" >&2
    echo "要繼續的話兩條路擇一:" >&2
    echo "  1. 先自己改資料庫密碼,再把同一個值填進 .env:" >&2
    echo "     docker compose exec postgres psql -U mitchcrm -d mitchcrm \\" >&2
    echo "       -c \"ALTER USER mitchcrm WITH PASSWORD '新密碼';\"" >&2
    echo "  2. 資料還可以丟的話整組重來(會刪光資料庫內容):docker compose down -v" >&2
    echo "" >&2
    echo "這支腳本先停在這裡,不動你的 .env。" >&2
    exit 1
  fi
fi

# ── 產生金鑰 ───────────────────────────────────────────────
# POSTGRES_PASSWORD 用 hex:這個值會被組進 DATABASE_URL,
# base64 會出現 + / = 這類在 URL 裡有意義的字元,得額外編碼才不會連不上。
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
JWT_ACCESS_SECRET="$(openssl rand -base64 48)"

# ── 寫檔 ───────────────────────────────────────────────────
# 先寫成暫存檔再搬過去,中途失敗不會留下半份 .env。
TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/mitchcrm-env.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT
cp "$EXAMPLE_FILE" "$TMP_FILE"

# 用 python3 做替換,避免金鑰裡的 / 與 + 被 sed 當成分隔符或特殊字元。
if command -v python3 >/dev/null 2>&1; then
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  JWT_ACCESS_SECRET="$JWT_ACCESS_SECRET" \
  python3 - "$TMP_FILE" <<'PY'
import os, sys

path = sys.argv[1]
keys = ["POSTGRES_PASSWORD", "JWT_ACCESS_SECRET"]
values = {k: os.environ[k] for k in keys}
filled = {k: False for k in keys}

out = []
with open(path, encoding="utf-8") as f:
    for line in f:
        stripped = line.rstrip("\n")
        for k in keys:
            if stripped.startswith(k + "="):
                out.append(f"{k}={values[k]}")
                filled[k] = True
                break
        else:
            out.append(stripped)

missing = [k for k, done in filled.items() if not done]
if missing:
    # .env.example 少了這幾行,寫出去的 .env 會缺值。寧可在這裡停手。
    sys.stderr.write("[setup] .env.example 缺少這些欄位:" + ", ".join(missing) + "\n")
    sys.exit(1)

with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
PY
else
  echo "找不到 python3,改用 awk 替換" >&2
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  JWT_ACCESS_SECRET="$JWT_ACCESS_SECRET" \
  awk '
    function val(k) { return ENVIRON[k] }
    /^POSTGRES_PASSWORD=/    { print "POSTGRES_PASSWORD=" val("POSTGRES_PASSWORD"); next }
    /^JWT_ACCESS_SECRET=/    { print "JWT_ACCESS_SECRET=" val("JWT_ACCESS_SECRET"); next }
    { print }
  ' "$TMP_FILE" > "$TMP_FILE.awk" && mv "$TMP_FILE.awk" "$TMP_FILE"
fi

mv "$TMP_FILE" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

# ── 報告 ───────────────────────────────────────────────────
echo "已產生 $ENV_FILE(權限 600),資料庫密碼與 JWT 金鑰都填好了。"
echo ""
echo "============================================================"
echo " 請離線備份 .env 裡的金鑰"
echo "============================================================"
echo " 金鑰遺失就換不回同一組登入狀態,所有人都要重新登入。"
echo " 請抄一份存在密碼管理系統或離線保管。"
echo ""
echo " 另外:資料庫裡的客戶資料是明文,系統不做欄位層加密。"
echo " 資料庫備份的內容等同正式資料,請比照正式資料保護,"
echo " 不要丟到沒有加密或沒有存取控制的地方。細節見 SECURITY.md。"
echo "============================================================"
echo ""
echo "接下來要做的事:"
echo "  1. 編輯 .env,把 PUBLIC_BASE_URL 改成使用者實際會打的網址"
echo "     (本機試跑可維持 http://localhost:8080)"
echo "  2. docker compose up -d --build"
echo "  3. 開瀏覽器進 PUBLIC_BASE_URL,走首次啟動精靈"
echo "     第二步就是設定你自己的管理員帳號密碼,不必去 log 裡抄"
echo ""
echo "  (自動化部署想跳過精靈:在 .env 填 SEED_ADMIN_EMAIL 與 SEED_ADMIN_PASSWORD,"
echo "   起站後那組帳號就存在,第一次登入會強制改密碼)"
echo ""
echo "環境需求與逐條環境變數說明:docs/安裝與部署.md"
