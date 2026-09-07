import { IsUUID } from 'class-validator';
// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
export class TransferDto {
  @IsUUID() toUserId!: string;
}
