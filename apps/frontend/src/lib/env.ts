import { z } from 'zod';

/**
 * 前端可讀 env var
 * 所有 NEXT_PUBLIC_* 會被 bundle 進 client,不要放 secret
 * 後端 API URL 一律用 env var,不要在程式碼裡寫死埠號
 */
const publicEnvSchema = z.object({
  apiBaseUrl: z.string().url({ message: 'NEXT_PUBLIC_API_BASE_URL must be a valid URL' }),
  siteUrl: z.string().url({ message: 'NEXT_PUBLIC_SITE_URL must be a valid URL' }),
  appEnv: z.enum(['development', 'staging', 'production']).default('development'),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

let cached: PublicEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cached) return cached;

  const parsed = publicEnvSchema.safeParse({
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `[@mitchcrm/frontend] 環境變數驗證失敗。請參考 apps/frontend/.env.example:\n${issues}`,
    );
  }

  cached = parsed.data;
  return cached;
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}

/** 取得後端 API base URL(去掉尾端 / 統一處理) */
export function getApiBase(): string {
  const url = getPublicEnv().apiBaseUrl;
  return url.replace(/\/$/, '');
}
