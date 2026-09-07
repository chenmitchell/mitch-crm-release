<!-- ref:3687 mc/陳彥輔/米球® -->
# 第三方相依套件的授權說明

這份檔案處理的是「拿授權掃描工具掃這個 repo 的相依樹會跳出來的兩件事」。兩件都不影響
Mitch CRM 本身的授權(MPL-2.0 加姓名表示權附款,見 [`LICENSE`](LICENSE)),但掃描報告
上會標紅,所以在這裡把來龍去脈寫清楚,省得每個做合規檢查的人都要自己追一次。

本專案自己的原始碼一律 MPL-2.0 加附款。以下講的全部是**相依套件**,不是本專案的程式碼。

完整的相依清單以 `pnpm-lock.yaml` 為準。要自己重跑一次盤點:

```bash
pnpm licenses list --json > /tmp/licenses.json
```

（輸出請寫到 repo 以外的路徑,理由見 [`docs/安裝與部署.md`](docs/安裝與部署.md) 的備份章節。）

---

## 一、LGPL-3.0-or-later:`@img/sharp-libvips-*`(libvips 預編譯二進位)

**掃描工具會說什麼:** 相依樹裡有一個 `LGPL-3.0-or-later` 的套件。很多公司的政策把
LGPL 列為「要人工簽核」。

**它是什麼:** `@img/sharp-libvips-<平台>` 是 [libvips](https://www.libvips.org/) 這套影像
處理程式庫的預編譯共享函式庫(在 Linux x64 上是 `lib/libvips-cpp.so.8.17.3`)。它自己的
`package.json` 標 `LGPL-3.0-or-later`,因為它打包進去的第三方程式庫裡有幾個是 LGPLv3
(glib、fribidi、libexif、libheif、librsvg 等),整包因此取最嚴的那一個。該套件的
README 附有逐一列出每個內含程式庫授權的表格。

**它為什麼在相依樹裡:** 它是 `sharp` 的**選用**相依,而 `sharp` 是 `next` 的**選用**相依。
Next.js 在有 `sharp` 的時候會拿它做圖片最佳化。這條路徑是相依樹自己長出來的,不是本專案
直接安裝的:`grep -rn '"sharp"' apps/*/package.json packages/*/package.json` 找不到任何一筆。

**對散布的影響:** LGPL 要求的是「使用者要能換掉那份 LGPL 的函式庫」。這裡的形態剛好是
LGPL 最寬鬆的那一種:libvips 是一個**獨立的動態連結共享函式庫檔案**,躺在
`node_modules/@img/sharp-libvips-*/lib/` 裡,沒有被靜態連結進本專案的任何產物,也沒有被
修改。要換成自己編的 libvips,把那個 `.so` 換掉就好。本專案的程式碼不會因為它而被要求
以 LGPL 釋出。

**不想要它的話:** 這是選用相依,拿掉不會讓系統跑不起來,只會讓 Next.js 的圖片最佳化退回
內建的實作。安裝時加 `--no-optional`,或在 `package.json` 用 pnpm 的 `neverBuiltDependencies`
/ overrides 排除。本專案沒有預設排除,因為排掉之後圖片最佳化會變慢。

## 二、UNKNOWN:`pause@0.0.1`

**掃描工具會說什麼:** `pause@0.0.1` 的授權是 `UNKNOWN` 或空白。

**為什麼:** 這個套件發布於 2012 年,它的 `package.json` 裡**沒有 `license` 欄位**
(自己看:`node_modules/.pnpm/pause@0.0.1/node_modules/pause/package.json`)。當年還不流行
在中繼資料裡標授權。掃描工具讀的是那個欄位,讀不到就報 UNKNOWN。

**實際的授權是 MIT。** 授權全文寫在同一個套件的 `Readme.md` 裡:

> (The MIT License)
>
> Copyright (c) 2012 TJ Holowaychuk &lt;tj@vision-media.ca&gt;

**它為什麼在相依樹裡:** `passport@0.7.0` 的相依。`passport` 是後端登入流程用的,
路徑是 `@mitchcrm/backend` → `passport` → `pause`。

**對散布的影響:** 沒有。MIT 只要求保留著作權聲明,而該聲明就在套件自己的檔案裡,
`node_modules` 原樣散布就已經符合。

---

## 這兩件事都不改變本專案的授權

Mitch CRM 的原始碼是 MPL-2.0 加姓名表示權附款。上面兩個套件都是相依,不是本專案的
著作,兩者的授權都不會傳染到本專案:MIT 沒有 copyleft,LGPL 的 copyleft 只及於那份
函式庫本身,而它以未修改的動態連結共享函式庫形態散布。

各 `package.json` 的 `license` 欄位填的是 SPDX 代碼 `MPL-2.0`,因為 SPDX 無法表達附加條款。
實際約束以 [`LICENSE`](LICENSE) 全文為準。
