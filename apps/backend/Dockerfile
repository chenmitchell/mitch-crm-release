# syntax=docker/dockerfile:1.7
# ref:3687 mc/陳彥輔/米球®
# =============================================================
# Mitch CRM — backend(NestJS + Prisma)容器映像
# =============================================================
# build context 是 **repo 根目錄**,不是 apps/backend。
# 原因:這是 pnpm workspace,backend 依賴 packages/* 的 workspace 套件,
# 只給 apps/backend 當 context 的話 COPY 不到那些目錄。
#
#   docker build -f apps/backend/Dockerfile -t mitchcrm-backend .
#
# 分四個 stage:deps(裝相依)→ builder(編譯 + 抽出 production 相依)
#             → tools(離線用的 prisma CLI)→ runtime(最後跑的映像)
#
# 所有 pnpm --filter 都用「路徑」而不是套件名,套件改名不會弄壞這份 Dockerfile。
# =============================================================

ARG NODE_IMAGE=node:20.20.2-slim
ARG PNPM_VERSION=10.33.2
# prisma CLI 版本要跟 apps/backend/package.json 的 devDependencies.prisma 對齊
ARG PRISMA_VERSION=5.22.0

# ── stage 1:相依 ────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
WORKDIR /src

RUN apt-get update -qq \
 && apt-get install -qq --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# 只先複製 manifest,讓 pnpm install 這一層在原始碼變動時仍能命中快取
# lockfile 一定要進來。少了它 pnpm 會忽略 --frozen-lockfile 的意圖,
# 每次 build 都對 registry 重新解析版本,同一份原始碼在不同時間點做出來的
# 映像裝到的相依可能不一樣。對一個主打自架、資料留在自己機器上的產品,
# 供應鏈可重現是基本要求,所以這裡固定用 --frozen-lockfile:
# lockfile 跟 package.json 對不上就直接讓 build 失敗,不要安靜地換版本。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ── stage 2:編譯 ────────────────────────────────────────────
FROM deps AS builder
WORKDIR /src

COPY apps/backend ./apps/backend
COPY packages/shared ./packages/shared

# 順序有講究,三步都不能省:
#
#   1. 先 build packages/shared。它是 backend 的 **執行期** 相依(dependencies),
#      而且送出去的是 dist/*.js(CJS)+ .d.ts,不是 TypeScript 原始碼。
#      少了這一步,backend 編得起來但 runtime require 會找不到 dist。
#      用 `'{./apps/backend}...'` 這個寫法:大括號是 pnpm 的「目錄選擇器」,
#      後綴 `...` 代表「連同它的相依套件」,pnpm 會按拓樸順序先建 packages/shared。
#      引號不能省,`{}` 在 bash 會被當成 brace expansion。
#      將來多一個 workspace 相依也不必回頭改這裡。
#   2. backend 的 build script 自己會先跑 prisma generate,這裡不重複下指令。
#   3. `pnpm --prod deploy` 已經把 apps/backend 的原始檔(含 prisma/schema.prisma)
#      複製進 /out,dist/ 則因為列在 apps/backend/.gitignore 而不會被帶過去。
#      所以 dist 要自己 cp,prisma 只補一份 schema:
#      `cp -r apps/backend/prisma /out/prisma` 在目標目錄已存在時會複製成
#      /out/prisma/prisma/schema.prisma,多一層沒人讀的死目錄。
#   4. `--prod deploy` 產出的 /out/node_modules 是從 store 重新裝的一份乾淨相依,
#      **不會** 帶著步驟 2 產生的 .prisma/client(那份在 /src 的虛擬 store 裡)。
#      所以 deploy 完要對著 /out 再 generate 一次,否則 runtime 一啟動就會是
#      `Cannot find module '.prisma/client/default'`。
#      cwd 與 --schema 都指向 /out,prisma 才會把 client 產進 /out 的 @prisma/client。
RUN pnpm --filter '{./apps/backend}...' run build \
 && pnpm --filter ./apps/backend --prod deploy --legacy /out \
 && cp -r apps/backend/dist /out/dist \
 && mkdir -p /out/prisma \
 && cp apps/backend/prisma/schema.prisma /out/prisma/schema.prisma \
 && cd /out \
 && /src/apps/backend/node_modules/.bin/prisma generate --schema=/out/prisma/schema.prisma

# ── stage 3:runtime 要用的 prisma CLI ───────────────────────
# runtime 只裝 production 相依,裡面沒有 prisma CLI(它是 devDependency),
# 但啟動時要靠它把資料表建起來(見 deploy/backend-entrypoint.sh),
# 所以在這裡獨立裝一份,再整包搬進 runtime。
# 裝在自己的目錄,不跟 /app/node_modules 混在一起。
FROM ${NODE_IMAGE} AS tools
ARG PRISMA_VERSION
WORKDIR /opt/prisma-cli
RUN apt-get update -qq \
 && apt-get install -qq --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm init -y > /dev/null \
 && npm install --omit=dev --no-audit --no-fund prisma@${PRISMA_VERSION}

# ── stage 4:runtime ────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production
# 預設埠寫在這裡而不是程式碼裡,部署時用 PORT 環境變數覆寫即可
ENV PORT=8787
ENV MITCHCRM_SECRETS_DIR=/var/lib/mitchcrm/secrets
ENV PRISMA_CLI_PATH=/opt/prisma-cli/node_modules/prisma/build/index.js
ENV HOME=/home/nodeapp

RUN apt-get update -qq \
 && apt-get install -qq --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 -r nodeapp \
 && useradd -r -u 1001 -g nodeapp -d /home/nodeapp nodeapp \
 && mkdir -p /home/nodeapp/.cache /var/lib/mitchcrm/secrets \
 && chown -R nodeapp:nodeapp /home/nodeapp /var/lib/mitchcrm

COPY --from=builder --chown=nodeapp:nodeapp /out/node_modules ./node_modules
COPY --from=builder --chown=nodeapp:nodeapp /out/dist ./dist
COPY --from=builder --chown=nodeapp:nodeapp /out/prisma ./prisma
COPY --from=builder --chown=nodeapp:nodeapp /out/package.json ./package.json
COPY --from=tools --chown=nodeapp:nodeapp /opt/prisma-cli /opt/prisma-cli
COPY --chown=nodeapp:nodeapp deploy/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh
RUN chmod +x /usr/local/bin/backend-entrypoint.sh

USER nodeapp
EXPOSE 8787

# 這個映像沒有 curl 也沒有 wget,用 Node 內建的 fetch 打健康檢查端點。
# 埠改了也不用改這裡,PORT 是同一個變數。
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/backend-entrypoint.sh"]
CMD ["node", "dist/main.js"]
