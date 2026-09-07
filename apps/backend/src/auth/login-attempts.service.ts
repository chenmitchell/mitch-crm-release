// ref:3687 mc/陳彥輔/米球®
/**
 * 登入失敗鎖定。key 是「帳號 + 來源 IP」,不是「帳號」。
 *
 * ── 原本的做法出了什麼事 ──────────────────────────────────────────
 * 鎖定原本記在 users.locked_until 上,key 只有帳號。任何人只要知道一個信箱,
 * 送五個**未認證**的錯誤密碼就能把那個帳號鎖 30 分鐘,連本人拿正確密碼都進不去,
 * 而系統沒有任何手動解鎖的端點。出廠的 rate limit 是按 IP 按 handler 計算的,
 * 換一個 IP 就能線性放大,對「定向阻斷某個人」這件事幾乎沒有阻力。
 *
 * 同時,鎖定的檢查擺在密碼驗證之前,而且丟的是另一句話(「帳號已暫時鎖定」),
 * 那條路徑不跑 argon2。結果是整套反帳號枚舉設計被這一個分支破掉:
 * 對每個候選信箱送六個請求,看第六個回哪一句話、花了幾毫秒,就知道這個人
 * 在不在系統裡 —— 訊息與時間同時分岔,而狀態碼全部是 401,所以「狀態碼一致」
 * 那一層防護完全沒有用。
 *
 * ── 現在的做法 ────────────────────────────────────────────────────
 * 1. 計數與鎖定的 key 是 `帳號 + 來源 IP`。別人從別的 IP 猜我的密碼,鎖到的是
 *    「他那個 IP 對我這個帳號」的桶子,不會鎖到我自己那一格。
 *    針對單一帳號的分散式猜測由 auth.controller 的每 IP 額度接手,
 *    兩道防線各管一面(見 SECURITY.md 的「已知的設計取捨」)。
 * 2. 鎖定狀態不再對外顯示。login() 把「鎖定中」併進通用失敗路徑:一樣跑一次
 *    dummy argon2.verify、一樣回「帳號或密碼錯誤」,未認證的呼叫端分不出
 *    「密碼錯」「帳號不存在」「被鎖了」。
 * 3. 帳號不存在時也照樣計數,否則「幾次之後才會被鎖」本身又是一個枚舉判準。
 *
 * ── 為什麼放在記憶體而不是資料庫 ──────────────────────────────────
 * 這一格是「這個 IP 對這個帳號最近的行為」,不是帳號本身的狀態,重啟後歸零是
 * 可以接受的(重啟不是攻擊者控制得了的事件,而且每 IP 額度仍在)。
 * 與 @nestjs/throttler 的記憶體儲存同一個口徑:單一 instance 夠用,
 * 多 instance 時每台各算一份,額度等效放大成台數倍,那是已知且可接受的上限。
 * users.failed_login_count 仍然照舊累計,那是給管理員看的「這個帳號最近被打了幾次」,
 * 不再是放行與否的依據。
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { loadEnv } from '../common/env';

/** 一個 (帳號, 來源 IP) 桶子的狀態 */
interface AttemptBucket {
  /** 這個桶子累積的失敗次數(鎖定成立後歸零) */
  count: number;
  /** 鎖到什麼時候(毫秒)。0 = 沒鎖 */
  lockedUntilMs: number;
  /** 最後一次更新時間,用來清掉不再有意義的桶子 */
  touchedMs: number;
}

/**
 * 桶子閒置多久之後可以丟掉。取「鎖定時長 + 額度視窗」的較大者再加一倍餘裕,
 * 確保不會把還在鎖定中的桶子掃掉(掃掉等於提前解鎖)。
 */
function idleTtlMs(): number {
  const env = loadEnv();
  return Math.max(env.LOGIN_LOCKOUT_MINUTES * 60_000, env.THROTTLE_TTL_SECONDS * 1000) * 2;
}

/** 桶子數量上限。超過就先掃一次過期的,還是超過就整個清掉,寧可放寬也不要無限成長 */
const MAX_BUCKETS = 20_000;

@Injectable()
export class LoginAttemptsService {
  private readonly buckets = new Map<string, AttemptBucket>();

  /**
   * 桶子的 key。email 不以明文當 key —— 這個 Map 會出現在 heap dump 裡,
   * 沒必要在記憶體中多留一份全站信箱清單。同一個 email 的所有 IP 桶子要能
   * 一次清掉(解鎖 / 登入成功),所以 email 的雜湊放前段,用前綴比對。
   */
  private emailKey(email: string): string {
    return createHash('sha256').update(email).digest('hex').slice(0, 32);
  }

  private bucketKey(email: string, ip: string): string {
    return `${this.emailKey(email)}|${ip || 'unknown'}`;
  }

  /** 這個 (帳號, IP) 現在是不是鎖定中 */
  isLocked(email: string, ip: string, nowMs: number = Date.now()): boolean {
    const b = this.buckets.get(this.bucketKey(email, ip));
    if (!b) return false;
    if (b.lockedUntilMs <= nowMs) return false;
    return true;
  }

  /**
   * 記一次登入失敗。累積到 LOGIN_MAX_ATTEMPTS 就鎖 LOGIN_LOCKOUT_MINUTES 分鐘。
   * 回傳這次記完之後是不是鎖定中(呼叫端不需要它來決定訊息,只用來寫紀錄)。
   */
  registerFailure(email: string, ip: string, nowMs: number = Date.now()): boolean {
    this.sweep(nowMs);
    const key = this.bucketKey(email, ip);
    const b = this.buckets.get(key) ?? { count: 0, lockedUntilMs: 0, touchedMs: nowMs };
    // 已經在鎖定中就不再往上疊,免得攻擊者靠持續打擊把鎖定無限延長
    if (b.lockedUntilMs > nowMs) {
      b.touchedMs = nowMs;
      this.buckets.set(key, b);
      return true;
    }
    // loadEnv 有快取,而且刻意在方法裡呼叫而不是在模組載入時:
    // 這支服務被 UsersService 間接 import,模組載入時就讀環境變數的話,
    // 沒有設定 env 的單元測試會在 import 的那一行整個掛掉。
    const env = loadEnv();
    b.count += 1;
    b.touchedMs = nowMs;
    if (b.count >= env.LOGIN_MAX_ATTEMPTS) {
      b.lockedUntilMs = nowMs + env.LOGIN_LOCKOUT_MINUTES * 60_000;
      b.count = 0;
    }
    this.buckets.set(key, b);
    return b.lockedUntilMs > nowMs;
  }

  /**
   * 清掉這個帳號的所有桶子(每一個來源 IP)。
   * 呼叫時機:登入成功、管理員手動解鎖、管理員重設密碼。
   */
  clearAccount(email: string): void {
    const prefix = `${this.emailKey(email)}|`;
    for (const key of this.buckets.keys()) {
      if (key.startsWith(prefix)) this.buckets.delete(key);
    }
  }

  /** 測試與「全部重來」用 */
  clearAll(): void {
    this.buckets.clear();
  }

  /** 目前保留的桶子數。只給測試與日後的觀測用 */
  size(): number {
    return this.buckets.size;
  }

  /** 掃掉已經沒有意義的桶子(沒鎖定、而且很久沒動過) */
  private sweep(nowMs: number): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    const ttl = idleTtlMs();
    for (const [key, b] of this.buckets) {
      if (b.lockedUntilMs <= nowMs && nowMs - b.touchedMs > ttl) this.buckets.delete(key);
    }
    // 掃完還是滿的話整個清掉:寧可放寬到「大家重新計數」,也不要讓記憶體無上限成長
    if (this.buckets.size >= MAX_BUCKETS) this.buckets.clear();
  }
}
// ref:3687 mc/陳彥輔/米球®
