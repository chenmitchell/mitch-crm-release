// ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
/**
 * 「這一格不准夾帶 NUL」的欄位驗證。
 *
 * 擋的錯誤:UTF-16 存出來的試算表(Excel 的「Unicode 文字」)每個 ASCII 字後面
 * 跟著一個 0x00 位元組,而 0x00 本身是合法的 UTF-8,fatal 解碼一聲不吭就解完了,
 * 解出來是「T<NUL>a<NUL>x<NUL>I<NUL>d」這種東西。前端的匯入解析已經有兩道擋這件事
 * (見 apps/frontend/src/lib/csv-import.ts 的 hasNulChar),但那兩道都在前端 ——
 * 直接打 POST /admin/crm/import 塞一個帶 NUL 的字串仍然會一路走到 PostgreSQL,
 * 而 PostgreSQL 的 text 型別不接受 0x00,錯誤在驅動層冒出來變成 500 加一列
 * error_logs。那是輸入問題,應該回 400 並指出是哪一欄,跟其他欄位驗證一致。
 *
 * 只擋 NUL,不擋換行與 Tab:備註本來就會有換行,公司名貼進來帶個 Tab 也不該被退。
 *
 * ── 掛在哪裡 ────────────────────────────────────────────────────────
 * 一開始只掛在匯入 DTO 上,因為那是 UTF-16 試算表最常進來的那條路。但 NUL
 * 進得來的路不只一條:手動建客戶(CreateDevCustomerDto)、打卡備註、日報內容、
 * 後台設定、安裝精靈,任何一個字串欄位貼上一段從壞掉的檔案複製出來的文字都會撞到,
 * 而症狀完全一樣(500 加一列 error_logs,錯誤訊息看不出是哪一欄)。
 * 所以規則是:**只要這一格會被寫進資料庫,就掛一個 @NoNulChar**。
 * 陣列欄位用 `{ each: true }`,自由形狀的 Json 欄位用 @NoNulCharDeep。
 *
 * 不掛的有兩種:純查詢參數(不寫進去)、以及密碼(存的是 argon2 雜湊,不是原文)。
 */
import { registerDecorator, type ValidationOptions } from 'class-validator';

/** 空字元(U+0000)。PostgreSQL 的 text / varchar 一律不接受 */
export const NUL_CHAR = '\u0000';

/** 這個字串裡有沒有 NUL。非字串一律回 false(型別由 @IsString 負責) */
export function hasNulChar(value: unknown): boolean {
  return typeof value === 'string' && value.includes(NUL_CHAR);
}

/**
 * 欄位不得含有 NUL。搭 @IsOptional / @IsString 一起用。
 * @param label 錯誤訊息裡的欄位名稱(中文),說得出是哪一欄
 */
export function NoNulChar(label: string, options?: ValidationOptions): PropertyDecorator {
  return function (target: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'noNulChar',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown): boolean {
          return !hasNulChar(value);
        },
        defaultMessage(): string {
          return `${label}含有無法儲存的空字元(常見原因:試算表另存成 UTF-16 文字檔),請改以 UTF-8 或 CSV 另存後再匯入`;
        },
      },
    });
  };
}

/**
 * 自由形狀的 Json 欄位不得含有 NUL(遞迴檢查鍵與值)。
 *
 * jsonb 跟 text 一樣不接受 U+0000(PostgreSQL 的訊息是
 * 「unsupported Unicode escape sequence ... \u0000 cannot be converted to text」),
 * 所以 `@IsObject()` 收下來、原樣存進 Json 欄位的那幾格(日報的 stats、
 * 設定裡的 areaColors / lookupFieldMap / photoChecklist)有同一個問題,
 * 而 @NoNulChar 只看得懂單一字串。
 *
 * 深度上限 8:設定與統計都是淺物件,而遞迴檢查的輸入是外面來的,
 * 不設上限的話一個夠深的巢狀結構可以把堆疊吃完。超過就當成不合格(退 400),
 * 不是靜靜放行 —— 那種形狀本來就不該存進這幾格。
 * @param label 錯誤訊息裡的欄位名稱(中文),說得出是哪一欄
 */
export function NoNulCharDeep(label: string, options?: ValidationOptions): PropertyDecorator {
  return function (target: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'noNulCharDeep',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown): boolean {
          return !hasNulCharDeep(value);
        },
        defaultMessage(): string {
          return `${label}含有無法儲存的空字元(常見原因:試算表另存成 UTF-16 文字檔),請改以 UTF-8 或 CSV 另存後再匯入`;
        },
      },
    });
  };
}

/** 這個值(字串、陣列、物件的任何一層)裡有沒有 NUL。太深一律當成有 */
export function hasNulCharDeep(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof value === 'string') return value.includes(NUL_CHAR);
  if (Array.isArray(value)) return value.some((v) => hasNulCharDeep(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.includes(NUL_CHAR) || hasNulCharDeep(v, depth + 1),
    );
  }
  return false;
}
