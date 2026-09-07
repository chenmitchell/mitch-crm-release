import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorsService } from './errors.service';
import { redactUrl } from '../common/redact';

/**
 * Global exception filter — 捕捉所有未處理的 exception:
 * 1. 寫進 error_logs(失敗也不阻擋)
 * 2. 回客戶端統一格式
 * 3. console.error stack
 *
 * 4xx 錯誤(BadRequest / Unauthorized 等)不寫 DB,因為通常是 user 端輸入問題,
 * 量大會塞爆。只寫 5xx + 預期外的錯誤。
 *
 * URL 一律先過 `redactUrl()` 再落地。一次性連結長成 `/invite?t=<64 字元 token>`,
 *    那個 token 就是存取憑證;原本這裡把 `req.url` 原封不動寫進 `error_logs.path`,
 *    後台 /admin/errors 又會顯示出來,等於前端一出錯就把一組還有效的憑證
 *    抄進 DB 與後台畫面(OWASP A09)。log、console、回應本體三個出口都要遮。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly errors: ErrorsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
    const req = ctx.getRequest<Request & { user?: { sub?: string } }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    // message = 進 log / DB 的完整內部訊息;clientMessage = 回給前端的訊息。
    // 兩者分開的判準是「status 而不是 exception 型別」:只有 4xx 的訊息才面向使用者
    // (如「識別碼格式不正確」),可以原樣回。5xx 不論是 HttpException 還是預期外的
    // Error,message 都可能夾帶內部欄位名、SQL 片段、檔案路徑甚至觸發錯誤的值,
    // 一律不回給前端,只留在 log 與 error_logs。
    let message = 'Internal server error';
    let clientMessage = '伺服器發生未預期的錯誤,請稍後再試';
    let stack: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      message =
        typeof r === 'string'
          ? r
          : (((r as Record<string, unknown>)?.message as string) ?? exception.message);
      // 4xx 的 HttpException 訊息是刻意面向使用者的(如「識別碼格式不正確」),原樣回前端。
      // 5xx 的 HttpException 不是:它多半是內部失敗被包成 InternalServerErrorException,
      // message 裡常常帶著伺服器路徑、SQL 片段、第三方套件的原始錯誤,甚至觸發錯誤的那個值。
      // 這個專案裡實際會長這樣的有幾種:資料庫連不上時 Prisma 回的連線字串資訊、
      // 地理編碼服務逾時時第三方回的整段內容、啟動遷移失敗時的 DDL 敘述。
      // 而免登入的端點(邀請連結、安裝精靈)也走同一支 filter,把這些原文回出去
      // 等於對未登入的人揭露內部結構。所以 status >= 500 一律走通用 clientMessage,
      // 完整 message 只進 logger 與 error_logs。
      if (status < HttpStatus.INTERNAL_SERVER_ERROR) {
        clientMessage = message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      stack = exception.stack;
      // clientMessage 維持通用字串,不外洩內部細節
    }

    // token 在 query string 裡,任何要留存或輸出的地方都用遮蔽後的版本
    const safeUrl = redactUrl(req.url);

    // 4xx 用 user 級錯誤,通常不需 DB log
    const isClientError = status >= 400 && status < 500;
    if (!isClientError) {
      this.logger.error(`[${req.method} ${safeUrl}] ${status}: ${message}`, stack);
      // 只記 5xx + unknown,避免 4xx 灌爆
      void this.errors.record({
        level: 'error',
        message,
        stack,
        path: safeUrl,
        method: req.method,
        statusCode: status,
        userId: req.user?.sub,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }

    res.status(status).json({
      statusCode: status,
      message: clientMessage,
      timestamp: new Date().toISOString(),
      // 回應本體也遮:前端可能把整包錯誤丟進自己的前端監控,token 不該跟著跑出去
      path: safeUrl,
    });
  }
}
