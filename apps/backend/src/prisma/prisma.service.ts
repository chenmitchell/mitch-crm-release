import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService — 包一層 lifecycle 讓 Nest 正確關閉連線。
 *
 * log 等級固定只開 warn 與 error,不分環境。
 * (原本這裡有一個三元運算,兩邊寫的是一模一樣的陣列,而註解說生產與開發不同。
 *  query log 會把 SQL 連同參數印出來,那裡面就是客戶姓名、地址與座標,
 *  開發機的終端機同樣不該出現這些,所以兩邊本來就該一樣 —— 拿掉分支,留下事實。)
 *
 * ── 資料庫連不上時的行為 ──────────────────────────────────────────
 * 起不來的資料庫**不擋服務啟動**:$connect() 失敗只記一行警告,程序繼續跑完啟動流程。
 * 這與容器 entrypoint 的做法一致(deploy/backend-entrypoint.sh 的 db push 失敗也只警告)。
 * 兩個健康檢查端點分工不同:
 *   /healthz  只證明「程序活著」(liveness)。DB 掛掉時它仍然 200。
 *   /readyz   證明「這台現在可以服務」(readiness)。DB 連不上時回 503,body 標 db:down。
 *
 * 出廠設定裡,容器自己的 HEALTHCHECK(Dockerfile 與 docker-compose.yml)打的是
 * /healthz,是刻意的:DB 短暫抖動時不要讓容器被判 unhealthy 而進重啟迴圈
 * (見下一段)。也就是說,「把這台從流量輪替裡拿掉」這件事,出廠的單機 compose
 * 沒有任何東西在做 —— 單機部署本來就沒有輪替可言。
 *
 * 要讓「DB 不通就停止送流量進來」真的生效,必須有一個編排器(Kubernetes、
 * Nomad、或前面的負載平衡器)把它的 readiness probe 指到 /readyz,由它依 503
 * 把這台移出後端池。這一步要部署者自己接,做法見 docs/安裝與部署.md 的健康檢查一節。
 *
 * 相反的做法(連不上就 exit 1)會讓容器進入重啟迴圈,log 被啟動訊息洗掉,
 * 而且 /readyz 根本來不及回答任何事 —— 那正是最難查的一種壞法。
 * Prisma 本來就是 lazy connect:資料庫之後恢復,下一次查詢會自己接上,不必重啟。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { level: 'warn', emit: 'stdout' },
        { level: 'error', emit: 'stdout' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Prisma connected');
    } catch (err) {
      // 只記錯誤型別與訊息,不記連線字串:DATABASE_URL 裡有密碼
      const kind = err instanceof Error ? err.name : 'UnknownError';
      this.logger.error(
        `資料庫連線失敗(${kind}),服務仍會啟動。/readyz 會回 503 並標示 db:down,` +
          '資料庫恢復後不需要重啟,下一次查詢會自動接上。',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
  // ref:3687 mc/陳彥輔/米球® 姓名表示權保留,見 LICENSE
}
