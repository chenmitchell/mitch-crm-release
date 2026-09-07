# syntax=docker/dockerfile:1.7
# ref:3687 mc/陳彥輔/米球®
# =============================================================
# Mitch CRM — frontend(Next.js 15 App Router)容器映像
# =============================================================
# build context 是 **repo 根目錄**,不是 apps/frontend。
# 原因跟 backend 一樣:這是 pnpm workspace,而前端的 package.json 有
# "@mitchcrm/shared": "workspace:*"(src/lib/app-settings.tsx 直接 import
# @mitchcrm/shared/vocab)。只給 apps/frontend 當 context 的話,
# pnpm install 會直接死在 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND。
#
#   docker build -f apps/frontend/Dockerfile -t mitchcrm-frontend .
#
# 分三個 stage:deps(裝相依)→ build(建 shared + next build)→ runner。
#
# NEXT_PUBLIC_* 是 build 時就編進 bundle 的,不是啟動時讀的。
# 換網址一定要重新 build,只 restart 不會生效。
#
# ★ build 期間需要對外網路,而且不只是 npm registry:
#   apps/frontend/src/app/layout.tsx 用 next/font/google 載 Noto Sans TC,
#   next build 會實際去打 fonts.googleapis.com 與 fonts.gstatic.com 把字型檔抓下來自架。
#   只放行 registry、把這兩個網域擋掉的建置環境會直接在 next build 這一步失敗。
#   離線或受限網路的機器改用 Next.js 官方留的 hook,不必改任何 apps/** 程式碼:
#
#     docker build -f apps/frontend/Dockerfile \
#       --build-arg NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/src/scripts/build/next-font-google-mock.cjs \
#       -t mitchcrm-frontend .
#
#   那份替身檔已經複製進 build stage(見下面的 COPY scripts/build)。
#   用了替身的話產物裡的 @font-face 指向一個假的 woff2,畫面會退回系統字型,
#   版面與功能不受影響。有網路的機器不要帶這個參數。
# =============================================================

ARG NODE_IMAGE=node:20.20.2-slim
ARG PNPM_VERSION=10.33.2

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN apt-get update -qq \
 && apt-get install -qq --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /src

# ── stage 1:相依 ────────────────────────────────────────────
# 只先複製 manifest,讓 pnpm install 這一層在原始碼變動時仍能命中快取
FROM base AS deps
WORKDIR /src

# lockfile 一定要進來。少了它 pnpm 會忽略 --frozen-lockfile 的意圖,
# 每次 build 都對 registry 重新解析版本,同一份原始碼在不同時間點做出來的
# 映像裝到的相依可能不一樣。對一個主打自架、資料留在自己機器上的產品,
# 供應鏈可重現是基本要求,所以這裡固定用 --frozen-lockfile:
# lockfile 跟 package.json 對不上就直接讓 build 失敗,不要安靜地換版本。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ── stage 2:編譯 ────────────────────────────────────────────
FROM deps AS build
WORKDIR /src

COPY apps/frontend ./apps/frontend
COPY packages/shared ./packages/shared
# next/font/google 的離線替身。只有帶了 NEXT_FONT_GOOGLE_MOCKED_RESPONSES 才會被讀到,
# 沒帶的話它只是躺在 build stage 裡,不進最終映像。
COPY scripts/build/next-font-google-mock.cjs ./scripts/build/next-font-google-mock.cjs

# 預設值只是為了讓「不帶任何參數的 docker build」也能過,
# 實際部署一定要帶對外網址進來(compose 與 Zeabur 都會帶)。
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
ARG NEXT_PUBLIC_SITE_URL=http://localhost:8080
ARG NEXT_PUBLIC_APP_ENV=production
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV}
ENV NEXT_TELEMETRY_DISABLED=1

# 空字串 = 不掛替身,走真正的 Google Fonts(有網路的機器就是這條)。
ARG NEXT_FONT_GOOGLE_MOCKED_RESPONSES=
ENV NEXT_FONT_GOOGLE_MOCKED_RESPONSES=${NEXT_FONT_GOOGLE_MOCKED_RESPONSES}

# `'{./apps/frontend}...'`:大括號是 pnpm 的目錄選擇器,`...` 代表連同相依套件,
# 所以 packages/shared 會先被建出 dist/*.js 再輪到 next build。
# 引號不能省,`{}` 在 bash 會被當成 brace expansion。
RUN pnpm --filter '{./apps/frontend}...' run build

# ── stage 3:runtime ─────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN groupadd -g 1001 -r nodeapp \
 && useradd -r -u 1001 -g nodeapp -d /home/nodeapp nodeapp \
 && mkdir -p /home/nodeapp && chown -R nodeapp:nodeapp /home/nodeapp

# next.config.mjs 的 outputFileTracingRoot 指向 monorepo root,
# 所以 standalone 產物是 .next/standalone/apps/frontend/server.js
# 外加一份 .next/standalone/node_modules(含 @mitchcrm/shared)。
# static 與 public 要各自補進對應的相對位置,不然是 404 而不是 500,更難查。
COPY --from=build --chown=nodeapp:nodeapp /src/apps/frontend/.next/standalone ./
COPY --from=build --chown=nodeapp:nodeapp /src/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=build --chown=nodeapp:nodeapp /src/apps/frontend/public ./apps/frontend/public

USER nodeapp
EXPOSE 3000

# Next.js standalone 沒有專屬的健康檢查端點,用首頁的狀態碼判斷。
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/frontend/server.js"]
