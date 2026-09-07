// ref:3687 mc/陳彥輔/米球®
/**
 * 把 json-depth.ts 的門檻掛成全域中介層。
 *
 * 位置很重要:Nest 的中介層跑在 body-parser 之後、守衛與 ValidationPipe 之前。
 * 這正是我們要的順序 —— body 已經是解析好的物件(量深度不必自己再 parse 一次),
 * 而 class-transformer 還沒開始遞迴深拷貝(那才是會爆堆疊的那一步)。
 *
 * 只看 body。query string 沒有巢狀能力(Express 預設的 extended qs 有深度上限,
 * 而且不會被 class-transformer 深拷貝),不需要在這裡多做一次。
 */
import { BadRequestException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MAX_BODY_DEPTH, TOO_DEEP_MESSAGE, jsonDepth } from './json-depth';

@Injectable()
export class JsonDepthMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const body: unknown = req.body;
    // 純量、null、沒有 body 的請求(GET / DELETE)直接放行,不必走一趟
    if (body === null || typeof body !== 'object') return next();
    if (jsonDepth(body) > MAX_BODY_DEPTH) {
      // 400 而不是 500:這是輸入問題,而且 4xx 不會被寫進 error_logs,
      // 「一次請求換一列錯誤記錄」那條灌記錄的路徑一併斷掉。
      throw new BadRequestException(TOO_DEEP_MESSAGE);
    }
    next();
  }
}
// ref:3687 mc/陳彥輔/米球®
