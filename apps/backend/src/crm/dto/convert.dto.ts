// 標記成交 body 的 DTO。
// body 一定要用 DTO class:型別註記(interface / 行內型別)不會產生 class-validator
// metadata,全域 ValidationPipe 等於沒作用,externalRef 就變成沒驗過的字串直通 service。
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
import { IsOptional, IsUUID } from 'class-validator';

export class ConvertDto {
  /** 外部系統的案件編號(選填);不帶就只把客戶標成已成交 */
  @IsOptional()
  @IsUUID('4')
  externalRef?: string;
}
