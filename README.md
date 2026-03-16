# sgcc-electricity-scraper

自动抓取[国家电网 95598](https://95598.cn) 的**电费余额**与**每日用电量**数据，以 HTTP API 形式对外提供。

> 适用于国家电网（State Grid）覆盖区域的居民用户，南方电网用户不适用。

## 它是怎么工作的

国家电网没有开放的数据 API，本项目通过浏览器自动化模拟真人操作来获取数据。整个流程完全自动，无需人工干预：

```
┌─────────────-┐    ① 触发抓取（定时 / 手动）       ┌──────────────────┐
│  本服务       │ ──────────────────────────────→ │  Playwright      │
│  (Bun HTTP)  │                                 │  无头 Chromium    │
└──────┬───────┘                                 └────────┬─────────┘
       │                                                  │
       │                                          ② 打开 95598.cn
       │                                          ③ 输入手机号
       │                                          ④ 点击获取验证码
       │                                                   │
       │         ⑤ 95598 发送短信到你的手机                  │
       │                    │                              │
       │         ┌──────────▼──────────┐                   │
       │         │  SmsForwarder (手机) │                   │
       │         │  监听到短信，转发到    │                   │
       │         │  本服务的 webhook     │                  │
       │         └──────────┬──────────┘                   │
       │                    │                              │
       │  ⑥ POST /api/webhook/sms {"text":"验证码123456"}  │
       │◄───────────────────┘                              │
       │                                                   │
       │  ⑦ 提取6位验证码，传递给浏览器                        │
       │──────────────────────────────────────────────────→│
       │                                          ⑧ 填入验证码并登录
       │                                          ⑨ 进入「我的」页面
       │                                          ⑩ 读取账户余额
       │                                          ⑪ 进入「日用电量」
       │                                          ⑫ 展开峰谷明细
       │                                          ⑬ 提取所有数据
       │◄──────────────────────────────────────────────────│
       │                                                   │
  ⑭ 保存到本地 JSON                                         │
  ⑮ 通过 GET /api/data 对外提供                             │
```

**关键设计**：登录 95598 需要短信验证码，本服务通过内置的 webhook 端点接收验证码，配合手机上的 [SmsForwarder](https://github.com/pppscn/SmsForwarder) 实现全自动闭环——手机收到验证码短信后自动转发给本服务，服务再将验证码填入浏览器完成登录。

## 前置条件

- [Bun](https://bun.sh) >= 1.0
- 国家电网 95598 账号（已绑定手机号）
- Android 手机安装 [SmsForwarder](https://github.com/pppscn/SmsForwarder)，用于自动转发验证码短信

## 快速开始

```bash
# 克隆项目
# TODO: 替换为你的 GitHub 仓库地址
git clone https://github.com/a1245582339/sgcc-electricity-scraper.git
cd sgcc-electricity-scraper

# 安装依赖
bun install

# 安装 Chromium 浏览器（Playwright 需要）
bunx playwright install chromium

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的手机号

# 启动服务
bun run start
```

启动后访问 http://localhost:9559/health 确认服务正常运行。

## Docker 部署

```bash
# 构建镜像
docker build -t sgcc-electricity-scraper .

# 运行容器
docker run -d \
  --name sgcc-electricity \
  --restart unless-stopped \
  -p 9559:9559 \
  -v sgcc-electricity-data:/app/data \
  -e PHONE_NUMBER=你的手机号 \
  -e API_TOKEN=your-secret-token \
  -e CRON_SCHEDULE="0 8 * * *" \
  sgcc-electricity-scraper
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `PHONE_NUMBER` | **是** | - | 国网 95598 绑定的手机号 |
| `API_TOKEN` | 否 | 空（不鉴权） | API 访问令牌 |
| `PORT` | 否 | `9559` | HTTP 服务端口 |
| `CRON_SCHEDULE` | 否 | 空（不启用） | 定时抓取的 cron 表达式，如 `0 8 * * *` 表示每天 8:00 |
| `RUN_ON_START` | 否 | `false` | 设为 `true` 则服务启动时立即执行一次抓取 |

## API 文档

所有 `/api/*` 路由支持 Bearer Token 鉴权。设置了 `API_TOKEN` 环境变量后，请求时需在 Header 中携带：

```
Authorization: Bearer your-secret-token
```

未设置 `API_TOKEN` 时所有接口无需鉴权。

---

### `GET /api/data`

查询已抓取的用电数据。记录按日期降序排列。

**请求示例**

```bash
curl -H "Authorization: Bearer your-secret-token" http://localhost:9559/api/data
```

**响应** `200 OK`

```jsonc
{
  "records": [
    {
      "date": "2025-03-13",       // 日期
      "fetchedAt": "2025-03-14T00:05:12.000Z",  // 抓取时间
      "balance": "128.56",        // 账户余额（元）
      "usage": "12.34",           // 当日总用电量（kWh）
      "peakUsage": "8.20",        // 峰时段用电量（kWh）
      "valleyUsage": "4.14"       // 谷时段用电量（kWh）
    },
    {
      "date": "2025-03-12",
      "fetchedAt": "2025-03-14T00:05:12.000Z",
      "balance": "128.56",
      "usage": "10.87",
      "peakUsage": "7.11",
      "valleyUsage": "3.76"
    }
    // ... 更多记录
  ],
  "updatedAt": "2025-03-14T00:05:12.000Z"  // 最后一次抓取时间
}
```

**字段说明**

| 字段 | 类型 | 说明 |
|------|------|------|
| `records` | `ElectricityRecord[]` | 用电记录数组，按日期降序 |
| `records[].date` | `string` | 用电日期，格式 `YYYY-MM-DD` |
| `records[].fetchedAt` | `string` | 该记录的抓取时间（ISO 8601） |
| `records[].balance` | `string` | 抓取时的账户余额，单位：元 |
| `records[].usage` | `string` | 当日总用电量，单位：kWh |
| `records[].peakUsage` | `string` | 峰时段用电量，单位：kWh（无数据时为空字符串） |
| `records[].valleyUsage` | `string` | 谷时段用电量，单位：kWh（无数据时为空字符串） |
| `updatedAt` | `string` | 最后一次成功抓取的时间（ISO 8601），未抓取过时为空字符串 |

---

### `POST /api/trigger`

手动触发一次数据抓取。抓取在后台异步执行，接口立即返回。

**请求示例**

```bash
curl -X POST -H "Authorization: Bearer your-secret-token" http://localhost:9559/api/trigger
```

**响应**

| 状态码 | 响应体 | 说明 |
|--------|--------|------|
| `200` | `{"message": "抓取任务已触发"}` | 任务已开始 |
| `409` | `{"error": "抓取任务正在运行中"}` | 上一次抓取尚未完成，同一时间只能运行一个抓取任务 |

---

### `POST /api/webhook/sms`

接收短信转发工具推送的短信内容，从中提取 6 位数字验证码。此接口供 [SmsForwarder](https://github.com/pppscn/SmsForwarder) 等工具调用。

**请求体** `Content-Type: application/json`

```json
{
  "text": "【国家电网】验证码654321，您正在登录国网App，5分钟内有效。"
}
```

**响应**

| 状态码 | 响应体 | 说明 |
|--------|--------|------|
| `200` | `{"message": "验证码已接收"}` | 成功提取并接收验证码 |
| `400` | `{"message": "未找到6位验证码", "text": "..."}` | 短信内容中未匹配到 6 位数字 |
| `400` | `{"error": "缺少 text 字段"}` | 请求体缺少 `text` 字段 |
| `400` | `{"error": "请求体解析失败"}` | 请求体不是合法 JSON |

---

### `GET /health`

健康检查端点（无需鉴权）。

**响应** `200 OK`

```json
{
  "status": "ok",
  "running": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `string` | 固定为 `"ok"` |
| `running` | `boolean` | 是否有抓取任务正在执行 |

## 配置 SmsForwarder

在手机上安装 [SmsForwarder](https://github.com/pppscn/SmsForwarder) 后，添加一条转发规则：

1. **发送通道** - 新建一个 Webhook 通道：
   - URL：`http://<本服务的局域网地址>:9559/api/webhook/sms`
   - 请求方式：`POST`
   - Content-Type：`application/json`
   - 请求模板：`{"text": "[msg]"}`

2. **转发规则** - 新建一条规则：
   - 匹配字段：短信内容
   - 匹配模式：包含
   - 匹配值：`95598` 或 `国家电网`
   - 发送通道：选择上面创建的 Webhook 通道

配置完成后，当手机收到 95598 的验证码短信时，SmsForwarder 会自动将短信内容 POST 到本服务，服务从中提取验证码完成登录。

## 数据存储

数据以 JSON 文件存储在 `data/` 目录下：

```
data/
├── records.json      # 用电记录（按日期去重合并，新数据覆盖旧数据）
└── updated_at.txt    # 最后一次抓取时间
```

Docker 部署时建议挂载 volume 持久化此目录：`-v sgcc-electricity-data:/app/data`

## 注意事项

- 95598 网站前端使用 Vue，页面渲染较慢，单次抓取耗时约 1~3 分钟
- 同一时间只允许运行一个抓取任务，重复触发会返回 409
- 验证码有效期约 5 分钟，SmsForwarder 转发需在 1 分钟内完成（超时会失败）
- 建议抓取频率不超过每天 1~2 次，避免触发风控

## 与 [sgcc_electricity_new](https://github.com/ARC-MX/sgcc_electricity_new) 的区别

本项目与 ARC-MX 的 sgcc_electricity_new 解决的是同一个问题——从国家电网获取用电数据，但在技术选型和设计理念上有较大差异：

| 对比维度 | 本项目 | sgcc_electricity_new |
|---------|--------|---------------------|
| **技术栈** | TypeScript + Bun + Playwright | Python + Selenium + ONNX Runtime |
| **登录方式** | 短信验证码（配合 SmsForwarder 自动转发） | 账号密码 + 滑动验证码（YOLOv3 神经网络离线识别），失败后可回退扫码登录 |
| **数据输出** | HTTP API 对外提供（`GET /api/data`），平台无关 | 直接通过 REST API 推送到 HomeAssistant 传感器实体 |
| **数据存储** | JSON 文件，轻量无依赖 | SQLite / MySQL（可选） |
| **定时调度** | 标准 cron 表达式，灵活可配 | 固定起始时间 + 12 小时间隔 |
| **峰谷电量** | 支持，自动展开并提取峰/谷时段明细 | 不支持 |
| **余额告警** | 不内置，可通过下游消费 API 实现 | 内置 PushPlus / URL 推送 |
| **多用户** | 单账户（单手机号） | 多户号，支持忽略指定用户 ID |
| **HA 集成** | 解耦，不依赖 HomeAssistant | 深度绑定 HomeAssistant |
| **镜像体积** | 较小，无神经网络模型 | ~300MB，包含 ONNX Runtime + YOLOv3 模型 |
| **架构** | 模块化 HTTP 服务（server / scraper / sms / storage / cron） | 单体 Python 脚本 |

**简单来说：**

- **sgcc_electricity_new** 是一个为 HomeAssistant 量身定做的方案，开箱即用，通过密码+验证码识别登录，功能全面（多用户、余额告警、数据库存储），但体积较大且与 HA 强耦合。
- **本项目** 是一个轻量级、平台无关的数据服务。通过短信验证码登录避免了验证码识别的复杂性和不稳定性（国网有登录次数限制，验证码识别失败会消耗次数），以标准 HTTP API 输出数据，可以对接任何系统（HA、Grafana、自定义面板等），不局限于 HomeAssistant。代价是需要一台安装了 SmsForwarder 的 Android 手机来转发验证码。

## License

[MIT](LICENSE)
