import { runScraper, isRunning } from "./scraper.ts";
import { receiveCode } from "./sms.ts";
import { readRecords, readUpdatedAt } from "./storage.ts";

const API_TOKEN = process.env.API_TOKEN || "";

if (!API_TOKEN) {
  console.warn(
    "\x1b[33m[WARNING] API_TOKEN 未设置，所有接口无鉴权，任何人均可访问。" +
    "强烈建议在 .env 中设置 API_TOKEN。\x1b[0m",
  );
}

function checkAuth(req: Request): boolean {
  if (!API_TOKEN) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${API_TOKEN}`;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function createServer(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Auth check for all /api routes
      if (path.startsWith("/api") && !checkAuth(req)) {
        return json({ error: "未授权" }, 401);
      }

      // POST /api/trigger - manual trigger
      if (req.method === "POST" && path === "/api/trigger") {
        if (isRunning()) {
          return json({ error: "抓取任务正在运行中" }, 409);
        }
        // Run in background, return immediately
        runScraper()
          .then((records) => {
            console.log(`[trigger] 抓取完成: ${records.length} 条记录`);
          })
          .catch((e) => console.error("[trigger] 抓取失败:", e));
        return json({ message: "抓取任务已触发" });
      }

      // POST /api/webhook/sms - receive SMS from SmsForwarder
      if (req.method === "POST" && path === "/api/webhook/sms") {
        try {
          const body = (await req.json()) as { text?: string };
          if (!body.text) {
            return json({ error: "缺少 text 字段" }, 400);
          }
          const code = receiveCode(body.text);
          if (code) {
            console.log("[webhook] 收到验证码");
            return json({ message: "验证码已接收" });
          }
          return json({ message: "未找到6位验证码", text: body.text }, 400);
        } catch {
          return json({ error: "请求体解析失败" }, 400);
        }
      }

      // GET /api/data - query stored data
      if (req.method === "GET" && path === "/api/data") {
        const records = readRecords();
        const updatedAt = readUpdatedAt();
        return json({ records, updatedAt });
      }

      // Health check
      if (path === "/health") {
        return json({ status: "ok", running: isRunning() });
      }

      return json({ error: "Not Found" }, 404);
    },
  });
}
