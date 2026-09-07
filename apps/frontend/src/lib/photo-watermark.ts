// 外勤打卡「拍照存證」影像處理(純瀏覽器端,不依賴任何套件)。
// 流程:讀檔(<img> 解碼,瀏覽器自動套 EXIF 方向,理由見 loadImage)→ 長邊縮到 ≤1280 → 壓浮水印(左上、右下各一組三行文字 + 中央斜 30 度淡淡的公司名)
//   → 輸出 JPEG quality 0.72;若 base64 長度超過 550×1024 字元(解碼後約 410KB)就降到 quality 0.6、長邊 1024 重做一次。
// 浮水印文字:① 客戶公司名 照片類型(例:某某公司 門牌) ② 業務姓名 職稱
//   ③ YYYY-MM-DD HH:mm:ss (GMT+8) 緯度,經度(小數 5 位;沒定位寫「未定位」)。
// 時間一律以組織設定的時區顯示,而且一定帶時區標示:存證照片是要拿出來當證據的,
// 跨時區時只寫「14:30」對造可以主張那是別的時區的 14:30。時區由呼叫端從設定帶進來。
// 時間由呼叫端決定(優先主機時間;用裝置時間時第三行尾端標「(裝置時間)」)。
// 記憶體:ImageBitmap 用完 close()、object URL 用完 revoke、canvas 用完歸零。回傳只帶 base64 + mime,預覽的 data URL 由呼叫端拼(見 photoDataUrl)。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE

import { formatOrgStamp } from '@mitchcrm/shared';

export interface WatermarkInput {
  file: Blob;
  /** 乙方公司名稱(中央斜字淡蓋) */
  companyName: string;
  /** 客戶公司名(第一行開頭) */
  customerName: string;
  /** 照片類型中文(第一行結尾,例:門牌、招牌) */
  kindLabel: string;
  /** 業務姓名(第二行) */
  salesName: string;
  /** 業務職稱(第二行,可空) */
  salesTitle: string;
  /** 座標;null = 未定位,第三行寫「未定位」 */
  lat: number | null;
  lng: number | null;
  /** 拍照時間(epoch ms) */
  takenAtMs: number;
  /** 組織設定的時區(IANA);浮水印的時間戳以它顯示 */
  timeZone: string;
  /** true = 時間來自裝置,不是主機;浮水印會標「(裝置時間)」 */
  deviceTime: boolean;
}

export interface WatermarkResult {
  mime: 'image/jpeg';
  /** 不含 data: 前綴的 base64;要預覽時由呼叫端拼 `data:${mime};base64,${base64}`(不重複存一份) */
  base64: string;
  /** 解碼後的檔案大小(bytes) */
  bytes: number;
  width: number;
  height: number;
  /** 拍照時間 ISO */
  takenAt: string;
  /** 是否走到第二輪(1024 / 0.6)才壓進上限(解碼後約 410KB) */
  downgraded: boolean;
}

/** 第一輪與第二輪的輸出參數 */
const PASS_1 = { maxEdge: 1280, quality: 0.72 } as const;
const PASS_2 = { maxEdge: 1024, quality: 0.6 } as const;
/** base64 字串長度上限:550×1024 字元,解碼後約 410KB(後端單張上限 600KB,留餘裕) */
const MAX_BASE64_LEN = 550 * 1024;

/**
 * epoch ms →「YYYY-MM-DD HH:mm:ss (GMT+8)」(組織設定的時區)。
 * 計算在 @mitchcrm/shared 的 org-time,前後端共用同一份(用 Intl 查時區資料庫,夏令時間也對)。
 */
export function fmtOrgTime(ms: number, timeZone: string): string {
  return formatOrgStamp(new Date(ms), timeZone);
}

/** 預覽用 data URL(不存在 WatermarkResult 裡,避免同一張圖在記憶體放兩份) */
export function photoDataUrl(r: Pick<WatermarkResult, 'mime' | 'base64'>): string {
  return `data:${r.mime};base64,${r.base64}`;
}

/** bytes → 人看的大小(KB / MB) */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/**
 * 讀圖(EXIF 方向的處理方式與理由):
 * 先走 <img> + object URL。現代瀏覽器(Chrome 81+、Safari 13.1+(iOS 13.4)、Firefox 77+)的 <img> 預設就是
 * CSS image-orientation: from-image,解碼時會照 EXIF 轉正,naturalWidth / naturalHeight 是轉正後的尺寸,
 * drawImage 也畫轉正後的圖,所以這條路徑不需要自己讀 EXIF。
 * 不優先用 createImageBitmap 的原因:imageOrientation: 'from-image' 這個選項在舊版 Safari 會被「靜默忽略」
 * (不丟錯、但不轉正),而且各家對「沒帶選項時的預設值」在 2020 前後改過,呼叫端無法從回傳值判斷有沒有轉正,
 * 結果就是直的照片橫著壓浮水印。<img> 路徑則沒有這個不確定性。
 * createImageBitmap 只留作 <img> 解碼失敗時的備援。
 */
async function loadImage(file: Blob): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = url;
    });
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => {
          img.src = '';
          URL.revokeObjectURL(url);
        },
      };
    }
    img.src = '';
    URL.revokeObjectURL(url);
  } catch {
    URL.revokeObjectURL(url);
  }
  // 備援:<img> 解不開時再試 createImageBitmap(帶 from-image;舊版不吃選項就不帶)
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* 再試一次不帶參數 */
    }
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
  }
  throw new Error('image decode failed');
}

/** 畫一組三行文字(白字黑描邊、半透明);anchor 決定貼齊左上或右下 */
function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontPx: number,
  canvasW: number,
  canvasH: number,
  anchor: 'top-left' | 'bottom-right',
) {
  const pad = Math.round(fontPx * 0.8);
  const lineH = Math.round(fontPx * 1.3);
  ctx.save();
  ctx.font = `600 ${fontPx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, fontPx * 0.18);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.textAlign = anchor === 'top-left' ? 'left' : 'right';
  const x = anchor === 'top-left' ? pad : canvasW - pad;
  const totalH = lineH * lines.length;
  const y0 = anchor === 'top-left' ? pad : canvasH - pad - totalH;
  lines.forEach((line, i) => {
    const y = y0 + i * lineH;
    ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

/** 整張圖中央斜 30 度、透明度 0.18 蓋一行公司名(避免裁掉角落浮水印) */
function drawCenterStamp(
  ctx: CanvasRenderingContext2D,
  text: string,
  canvasW: number,
  canvasH: number,
) {
  if (!text) return;
  const fontPx = Math.max(16, Math.round(canvasW * 0.08));
  ctx.save();
  ctx.translate(canvasW / 2, canvasH / 2);
  ctx.rotate((-30 * Math.PI) / 180);
  ctx.font = `700 ${fontPx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.18;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, fontPx * 0.08);
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#ffffff';
  ctx.strokeText(text, 0, 0);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

interface RenderOut {
  base64: string;
  width: number;
  height: number;
}

function renderPass(
  img: LoadedImage,
  lines: string[],
  companyName: string,
  maxEdge: number,
  quality: number,
): RenderOut {
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(img.source, 0, 0, w, h);

  const fontPx = Math.max(11, Math.round(w * 0.025));
  drawCenterStamp(ctx, companyName, w, h);
  drawTextBlock(ctx, lines, fontPx, w, h, 'top-left');
  drawTextBlock(ctx, lines, fontPx, w, h, 'bottom-right');

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  // 用完歸零,讓 GPU/記憶體早點釋放(手機端很重要)
  canvas.width = 0;
  canvas.height = 0;
  const comma = dataUrl.indexOf(',');
  return { base64: dataUrl.slice(comma + 1), width: w, height: h };
}

/** base64 字串 → 解碼後 bytes */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** 主入口:讀圖 → 縮圖 → 壓浮水印 → JPEG;超過約 410KB 自動降級重做 */
export async function watermarkPhoto(input: WatermarkInput): Promise<WatermarkResult> {
  const timeText = `${fmtOrgTime(input.takenAtMs, input.timeZone)}${input.deviceTime ? '(裝置時間)' : ''}`;
  const coords =
    input.lat != null &&
    input.lng != null &&
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng)
      ? `${input.lat.toFixed(5)},${input.lng.toFixed(5)}`
      : '未定位';
  const lines = [
    `${input.customerName} ${input.kindLabel}`.trim(),
    `${input.salesName} ${input.salesTitle}`.trim(),
    `${timeText} ${coords}`,
  ].filter((s) => s.length > 0);

  const img = await loadImage(input.file);
  try {
    let out = renderPass(img, lines, input.companyName, PASS_1.maxEdge, PASS_1.quality);
    let downgraded = false;
    if (out.base64.length > MAX_BASE64_LEN) {
      out = renderPass(img, lines, input.companyName, PASS_2.maxEdge, PASS_2.quality);
      downgraded = true;
    }
    return {
      mime: 'image/jpeg',
      base64: out.base64,
      bytes: base64Bytes(out.base64),
      width: out.width,
      height: out.height,
      takenAt: new Date(input.takenAtMs).toISOString(),
      downgraded,
    };
  } finally {
    img.release();
  }
}
