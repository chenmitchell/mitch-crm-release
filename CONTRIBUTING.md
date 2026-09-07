# 貢獻指南

歡迎 issue 與 pull request。這份寫的是流程與規矩。

---

## 開 issue

**回報問題**請寫:發生什麼、預期是什麼、怎麼重現、版本與部署方式(Docker Compose、自架、PaaS)、相關的 log。log 貼出來之前請自己看一遍有沒有帶到真實資料。

**提功能**請寫:你遇到的實際情境是什麼、現在怎麼處理、希望系統怎麼做。從情境出發比較容易討論,直接丟一句「請加某某功能」通常會先被問回去。

**安全性問題不要開公開 issue**,照 [`SECURITY.md`](SECURITY.md) 的方式回報。

開 issue 時 GitHub 會給你兩種表單(回報問題、提功能),必寫的欄位就是上面這幾項,照著填就好。

## 送 pull request

1. 比較大的改動先開 issue 討論,免得白做
2. 從 `main` 開分支,分支名用 `feat/`、`fix/`、`docs/`、`refactor/` 開頭
3. 一個 PR 做一件事。混了好幾件不相干的改動會被請你拆開
4. commit 訊息用祈使句寫清楚做了什麼
5. 本機跑過 `pnpm lint && pnpm type-check && pnpm build`。

   最後那一步是前端建置,而前端**刻意**在缺少兩個環境變數時直接失敗(錯誤訊息會指名缺哪一個),所以先設好再跑:

   ```bash
   export NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
   export NEXT_PUBLIC_SITE_URL=http://localhost:3000
   pnpm build
   ```

   有哪一關沒跑,在 PR 說明裡寫清楚沒跑、為什麼
6. PR 說明要寫:解決什麼問題、改了什麼、怎麼驗證的(附實際輸出)、有沒有影響資料庫結構或環境變數。開 PR 時會自動帶出 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md),照著填即可

跑過就是跑過,沒跑就寫沒跑。沒辦法驗證的部分講清楚原因。

## 一定會被退回的情況

- 原始碼檔頭的 `// ref:3687 mc/陳彥輔/米球®` 署名註解被刪或被改。新增檔案也要加同樣一行
- 前台新增了寫死的業務用語清單而沒有對應的設定頁
- 前端改動不符合 WCAG 2.1 AAA 的對比、命中區與鍵盤操作要求
- 資料庫結構變更不是純新增
- 有金鑰、權杖或真實個資

## 開發環境

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env
# 編輯 apps/backend/.env:填自己的 DATABASE_URL,並把 JWT_ACCESS_SECRET
# 換成一組至少 32 字元的隨機值(openssl rand -base64 48)。
# 範例檔裡的佔位值長度合法、起得來,但那是假值,不要留著用。
pnpm --filter @mitchcrm/backend exec prisma db push
pnpm --filter @mitchcrm/backend run seed:admin
pnpm dev
```

需要 Node 20.20.2、pnpm 10 以上、PostgreSQL 16。

## 文件

改功能就要改文件。文件用繁體中文寫,規矩幾條:

- 不用連續符號堆疊,不用 AI 慣用的贅詞
- 台灣正常用語,句子像人講的
- 寫得出實際數字就不要寫「很快」「很多」

## 授權

送出 pull request 即表示同意你的貢獻以 MPL-2.0 加姓名表示權附加條款釋出,條款見 [`LICENSE`](LICENSE)。

參與這個專案請遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
