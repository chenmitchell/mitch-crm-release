// ref:3687 mc/陳彥輔/米球®
/**
 * 批次移交的 DTO。
 *
 * 為什麼需要上限:批次移交是逐筆各自一個交易、各自鎖客戶列(見 CrmService.transferMany),
 * 一次幾百筆就是幾百輪交易,沒有上限的話一個請求可以把連線池佔滿。200 筆是
 * 「一次把一個團隊的名單轉完」跟「一個請求不要跑太久」之間的取捨;要更多就分幾次送。
 *
 * 上限同時寫在 DTO(擋在 controller,回 400 並說清楚)與 service(再切一次),
 * 理由跟匯入的 IMPORT_MAX_ROWS 一樣:直接打 API 的來源不一定走得到 DTO。
 */
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** 一次批次移交的筆數上限;service 端也會再切掉多的,兩邊用同一個常數 */
export const TRANSFER_BATCH_MAX = 200;

export class TransferBatchDto {
  @IsArray()
  @ArrayNotEmpty({ message: '請至少選一筆客戶' })
  @ArrayMaxSize(TRANSFER_BATCH_MAX, {
    message: `一次最多移交 ${TRANSFER_BATCH_MAX} 筆,請分批`,
  })
  @IsUUID(undefined, { each: true, message: '客戶編號格式不正確' })
  customerIds!: string[];

  @IsUUID(undefined, { message: '接手人員編號格式不正確' })
  toUserId!: string;
}
