import { createServer } from "./server.ts";
import { startCron } from "./cron.ts";

const port = Number(process.env.PORT) || 9559;

const server = createServer(port);
console.log(`[server] HTTP 服务已启动: http://localhost:${server.port}`);

startCron();

console.log("[app] 国家电网电费查询服务已就绪");
