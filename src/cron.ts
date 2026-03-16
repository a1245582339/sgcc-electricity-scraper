import cron from "node-cron";
import { runScraper, isRunning } from "./scraper.ts";

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "";
const RUN_ON_START = process.env.RUN_ON_START === "true";

async function trigger() {
  if (isRunning()) {
    console.log("[cron] 抓取任务正在运行中，跳过");
    return;
  }
  try {
    await runScraper();
    console.log("[cron] 抓取完成");
  } catch (e) {
    console.error("[cron] 抓取失败:", e);
  }
}

export function startCron() {
  if (CRON_SCHEDULE) {
    if (!cron.validate(CRON_SCHEDULE)) {
      console.error(`[cron] 无效的 CRON_SCHEDULE: ${CRON_SCHEDULE}`);
      return;
    }
    cron.schedule(CRON_SCHEDULE, () => {
      console.log("[cron] 定时任务触发:", new Date().toISOString());
      trigger();
    });
    console.log(`[cron] 定时任务已启动 (${CRON_SCHEDULE})`);
  } else {
    console.log("[cron] 未设置 CRON_SCHEDULE，定时任务未启动");
  }

  if (RUN_ON_START) {
    console.log("[cron] 启动时自动获取...");
    trigger();
  }
}
