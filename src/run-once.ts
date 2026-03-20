import { runScraper } from "./scraper.ts";
import { readRecords, readUpdatedAt } from "./storage.ts";

const SMS_RELAY_URL = process.env.SMS_RELAY_URL || "";
const SMS_RELAY_TOKEN = process.env.SMS_RELAY_TOKEN || "";

async function main() {
  console.log("[run-once] 开始单次抓取...");

  const records = await runScraper();
  console.log(`[run-once] 抓取完成，${records.length} 条记录`);

  if (SMS_RELAY_URL) {
    console.log("[run-once] 保存数据到 Cloudflare...");
    const body = JSON.stringify({
      records: readRecords(),
      updatedAt: readUpdatedAt(),
    });
    const res = await fetch(`${SMS_RELAY_URL}/data`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SMS_RELAY_TOKEN}`,
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`保存失败: ${res.status} ${await res.text()}`);
    }
    console.log("[run-once] 数据已保存");
  }

  console.log("[run-once] 完成");
  process.exit(0);
}

main().catch((e) => {
  console.error("[run-once] 失败:", e);
  process.exit(1);
});
