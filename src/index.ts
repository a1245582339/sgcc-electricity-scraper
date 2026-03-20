import { createServer } from "./server.ts";
import { startCron } from "./cron.ts";
import { isRelayMode } from "./sms.ts";

const port = Number(process.env.PORT) || 9559;

const server = createServer(port);
console.log(`[server] HTTP 服务已启动: http://localhost:${server.port}`);
console.log(`[sms] 验证码模式: ${isRelayMode() ? "relay (轮询 CF Worker)" : "webhook (等待 POST /api/webhook/sms)"}`);

startCron();

console.log("[app] 国家电网电费查询服务已就绪");
