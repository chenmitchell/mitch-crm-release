# ---------------------------------------------------------------------------
# Mitch CRM — 一鍵初始化(Windows / PowerShell)
#
# 做三件事:
#   1. 從 .env.example 產生 .env
#   2. 產生資料庫密碼與 JWT 簽章金鑰填進去
#   3. 提醒把金鑰離線備份
#
# 請在第一次 docker compose up 之前跑。已經跑過 compose 的話,
# postgres 的資料目錄已經用舊密碼初始化過了,這支腳本產生的新
# POSTGRES_PASSWORD 不會被套用,backend 會連不上資料庫
# (log 出現 password authentication failed)。
# 偵測到既有的 postgres-data volume 時會先停下來提醒。
#
# 已經有 .env 就不動它,只檢查有沒有缺值。要重新產生請自己先改名或刪掉。
#
# 用法(在 repo 根目錄):
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# 這支不依賴 openssl,金鑰用 .NET 的 RandomNumberGenerator 產生,
# 跟 openssl rand 一樣是密碼學安全的亂數來源。
# ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
# ---------------------------------------------------------------------------
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo '.env'
$exampleFile = Join-Path $repo '.env.example'

if (-not (Test-Path $exampleFile)) {
    Write-Error "找不到 $exampleFile,請確認在 repo 根目錄執行"
}

function New-RandomBytes {
    param([int]$Count)
    $bytes = New-Object byte[] $Count
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return $bytes
}

# hex:給 POSTGRES_PASSWORD 用。這個值會被組進 DATABASE_URL,
# base64 會出現 + / = 這類在 URL 裡有意義的字元,得額外編碼才不會連不上。
function New-HexKey {
    param([int]$ByteCount)
    return -join ((New-RandomBytes -Count $ByteCount) | ForEach-Object { $_.ToString('x2') })
}

function New-Base64Key {
    param([int]$ByteCount)
    return [Convert]::ToBase64String((New-RandomBytes -Count $ByteCount))
}

$targetKeys = @('POSTGRES_PASSWORD', 'JWT_ACCESS_SECRET')

# ── 已存在就不覆蓋 ─────────────────────────────────────────
if (Test-Path $envFile) {
    Write-Host '偵測到既有的 .env,不覆蓋。'
    Write-Host ''
    $existing = Get-Content -LiteralPath $envFile -Encoding UTF8
    $missing = @()
    foreach ($key in $targetKeys) {
        $line = $existing | Where-Object { $_.StartsWith("$key=") } | Select-Object -First 1
        if ($null -eq $line -or $line.Substring($key.Length + 1).Trim() -eq '') {
            $missing += $key
        }
    }
    if ($missing.Count -gt 0) {
        # 這兩個留空並不會讓服務起不來,compose 與 entrypoint 都有 fallback。
        # 兩個 fallback 的代價不一樣,所以分開講清楚。
        Write-Host '以下兩項是空的:'
        foreach ($k in $missing) { Write-Host "  - $k" }
        Write-Host ''
        Write-Host '空著也起得來,但要知道代價:'
        Write-Host '  POSTGRES_PASSWORD  空 = 用 docker-compose.yml 裡的明文預設值 mitchcrm,'
        Write-Host '                     那個值在公開 repo 上人人看得到。正式環境請填。'
        Write-Host '                     只有第一次啟動(資料目錄還是空的)才套用得上,'
        Write-Host '                     已經 up 過就要進資料庫 ALTER USER,或 down -v 重來。'
        Write-Host '  JWT_ACCESS_SECRET  空 = backend 第一次啟動自動產生一把,寫進 app-secrets'
        Write-Host '                     volume,那份是唯一副本,volume 沒了全體要重新登入。'
        Write-Host ''
        Write-Host '要自己指定的話,把 .env 改名或刪掉後重跑這支腳本。'
        Write-Host '注意:換掉 JWT 金鑰之後,所有人的登入狀態都會失效,要重新登入。'
        exit 0
    }
    Write-Host '兩項都有值。要重新產生請先把 .env 改名或刪掉再跑一次。'
    exit 0
}

# ── 已經跑過 compose 的話先提醒 ─────────────────────────────
# postgres 官方映像只在資料目錄是空的時候拿 POSTGRES_PASSWORD 建帳號。
# volume 已經存在就代表密碼早就定下來了,這裡新產生的那組套不上去。
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($null -ne $dockerCmd) {
    $volumes = @()
    try { $volumes = @(& docker volume ls --format '{{.Name}}' 2>$null) } catch { $volumes = @() }
    if ($volumes -contains 'mitchcrm_postgres-data') {
        Write-Host '偵測到既有的資料庫 volume(mitchcrm_postgres-data),代表這套已經啟動過。'
        Write-Host ''
        Write-Host '現在產生新的 POSTGRES_PASSWORD 會讓 backend 連不上資料庫:'
        Write-Host '資料庫裡的密碼是第一次啟動時定下來的,不會因為改 .env 而變。'
        Write-Host ''
        Write-Host '要繼續的話兩條路擇一:'
        Write-Host '  1. 先用 docker compose exec postgres psql 進去 ALTER USER 改密碼,'
        Write-Host '     再把同一個值填進 .env'
        Write-Host '  2. 資料還可以丟的話整組重來(會刪光資料庫內容):docker compose down -v'
        Write-Host ''
        Write-Host '這支腳本先停在這裡,不動你的 .env。'
        exit 1
    }
}

# ── 產生金鑰 ───────────────────────────────────────────────
$values = @{
    'POSTGRES_PASSWORD'    = New-HexKey -ByteCount 24
    'JWT_ACCESS_SECRET'    = New-Base64Key -ByteCount 48
}

# ── 寫檔 ───────────────────────────────────────────────────
# 先寫暫存檔再搬過去,中途失敗不會留下半份 .env。
$lines = Get-Content -LiteralPath $exampleFile -Encoding UTF8
$filled = @{}
foreach ($k in $targetKeys) { $filled[$k] = $false }

$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
    $matched = $false
    foreach ($key in $targetKeys) {
        if ($line.StartsWith("$key=")) {
            $out.Add("$key=$($values[$key])")
            $filled[$key] = $true
            $matched = $true
            break
        }
    }
    if (-not $matched) { $out.Add($line) }
}

$missingKeys = $targetKeys | Where-Object { -not $filled[$_] }
if ($missingKeys) {
    # .env.example 少了這幾行,寫出去的 .env 會缺值。寧可在這裡停手。
    Write-Error (".env.example 缺少這些欄位:" + ($missingKeys -join ', '))
}

$tmpFile = [System.IO.Path]::GetTempFileName()
try {
    # 不寫 BOM:帶 BOM 的 .env 會讓第一個變數名多出看不見的字元,
    # docker compose 讀進去就變成一個叫「﻿PUBLIC_BASE_URL」的變數,
    # 現象是「明明填了卻說沒設定」。
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpFile, ($out -join "`n") + "`n", $utf8NoBom)
    Move-Item -LiteralPath $tmpFile -Destination $envFile -Force
} finally {
    if (Test-Path $tmpFile) { Remove-Item -LiteralPath $tmpFile -Force }
}

# 收斂 .env 的存取權限:只留目前使用者與系統管理員
try {
    $acl = Get-Acl -LiteralPath $envFile
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $envFile -AclObject $acl
} catch {
    Write-Host "提醒:沒能收斂 .env 的檔案權限($($_.Exception.Message))。請自行確認只有維運人員讀得到。"
}

# ── 報告 ───────────────────────────────────────────────────
Write-Host "已產生 $envFile,資料庫密碼與 JWT 金鑰都填好了。"
Write-Host ''
Write-Host '============================================================'
Write-Host ' 請離線備份 .env 裡的金鑰'
Write-Host '============================================================'
Write-Host ' 金鑰遺失就換不回同一組登入狀態,所有人都要重新登入。'
Write-Host ' 請抄一份存在密碼管理系統或離線保管。'
Write-Host ''
Write-Host ' 另外:資料庫裡的客戶資料是明文,系統不做欄位層加密。'
Write-Host ' 資料庫備份的內容等同正式資料,請比照正式資料保護,'
Write-Host ' 不要丟到沒有加密或沒有存取控制的地方。細節見 SECURITY.md。'
Write-Host '============================================================'
Write-Host ''
Write-Host '接下來要做的事:'
Write-Host '  1. 編輯 .env,把 PUBLIC_BASE_URL 改成使用者實際會打的網址'
Write-Host '     (本機試跑可維持 http://localhost:8080)'
Write-Host '  2. docker compose up -d --build'
Write-Host '  3. 開瀏覽器進 PUBLIC_BASE_URL,走首次啟動精靈'
Write-Host '     第二步就是設定你自己的管理員帳號密碼,不必去 log 裡抄'
Write-Host ''
Write-Host '  (自動化部署想跳過精靈:在 .env 填 SEED_ADMIN_EMAIL 與 SEED_ADMIN_PASSWORD,'
Write-Host '   起站後那組帳號就存在,第一次登入會強制改密碼)'
Write-Host ''
Write-Host '環境需求與逐條環境變數說明:docs\安裝與部署.md'
