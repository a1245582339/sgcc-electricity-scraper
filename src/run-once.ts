import { runScraper } from "./scraper.ts";
import { readRecords, readUpdatedAt } from "./storage.ts";

const PUSH_URL = process.env.PUSH_URL || "";
const PUSH_TOKEN = process.env.PUSH_TOKEN || "";

async function main() {
  console.log("[run-once] 开始单次抓取...");

  const records = await runScraper();
  console.log(`[run-once] 抓取完成，${records.length} 条记录`);

  if (PUSH_URL) {
    console.log("[run-once] 推送数据到目标服务器...");
    const body = JSON.stringify({
      records: readRecords(),
      updatedAt: readUpdatedAt(),
    });
    const res = await fetch(PUSH_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(PUSH_TOKEN ? { Authorization: `Bearer ${PUSH_TOKEN}` } : {}),
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`推送失败: ${res.status} ${await res.text()}`);
    }
    console.log("[run-once] 推送成功");
  }

  console.log("[run-once] 完成");
  process.exit(0);
}

main().catch((e) => {
  console.error("[run-once] 失败:", e);
  process.exit(1);
});
