import { chromium, type Browser, type Page } from "playwright";
import { waitForCode, clearPendingCode } from "./sms.ts";
import { saveRecords, type ElectricityRecord } from "./storage.ts";

const LOGIN_URL =
  "https://95598.cn/osgweb/electricityCharge?partNo=P02021703";

let running = false;

export function isRunning() {
  return running;
}

async function waitForVueRender(page: Page, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    await page.waitForTimeout(2000);
    const len = await page
      .evaluate(() => document.getElementById("app")?.innerHTML?.length || 0)
      .catch(() => -1);
    if (len > 1000) {
      console.log(`[scraper] Vue 渲染完成 (poll ${i + 1}, ${len} chars)`);
      return;
    }
  }
  throw new Error("Vue 页面渲染超时");
}

/** Wait for URL to change away from the given one */
async function waitForUrlChange(page: Page, fromUrl: string, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (page.url() !== fromUrl) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`页面未跳转，仍停留在 ${fromUrl}`);
}

export async function runScraper(): Promise<ElectricityRecord[]> {
  if (running) throw new Error("抓取任务正在运行中");
  running = true;

  let browser: Browser | null = null;
  try {
    const phoneNumber = process.env.PHONE_NUMBER;
    if (!phoneNumber) throw new Error("未设置 PHONE_NUMBER 环境变量");

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // === Login on electricityCharge page ===
    console.log("[scraper] 打开95598页面...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 90000 });
    await waitForVueRender(page);

    console.log("[scraper] 切换到账号登录...");
    await page.evaluate(() => {
      const sw = document.querySelector(".switch") as HTMLElement;
      const al = document.querySelector(".account-login") as HTMLElement;
      if (sw) sw.style.display = "";
      if (al) al.style.display = "";
    });
    await page.waitForTimeout(500);

    console.log("[scraper] 切换到短信验证码登录...");
    await page.locator("div.code_login").click({ force: true });
    await page.waitForTimeout(1000);

    console.log("[scraper] 输入手机号...");
    await page
      .locator('.account-login input[placeholder="手机号码"]')
      .fill(phoneNumber);

    console.log("[scraper] 勾选同意协议...");
    await page
      .locator(".code_form .checked-box.un-checked")
      .click({ force: true });
    await page.waitForTimeout(500);

    console.log("[scraper] 点击获取验证码...");
    await clearPendingCode();
    await page.locator("a.yanzheng").click({ force: true });

    console.log("[scraper] 等待短信验证码...");
    const code = await waitForCode();
    console.log("[scraper] 收到验证码，填入中...");

    await page
      .locator('.account-login input[placeholder="请输入验证码"]')
      .fill(code);

    console.log("[scraper] 点击登录...");
    await page.locator(".account-login .el-button--primary").last().click();

    // Verify login success
    console.log("[scraper] 等待登录结果...");
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      const loginState = await page.evaluate(() => {
        const userEl = document.querySelector(
          ".username.userlatent"
        ) as HTMLElement;
        if (userEl) {
          const style = window.getComputedStyle(userEl);
          if (style.display !== "none") return "ok";
        }
        const msgs = document.querySelectorAll(
          ".el-message, .el-message-box, .el-notification"
        );
        for (const msg of Array.from(msgs)) {
          const text = msg.textContent?.trim();
          if (text) return `error:${text}`;
        }
        return "waiting";
      });

      if (loginState === "ok") {
        console.log(`[scraper] 登录成功, URL: ${page.url()}`);
        break;
      }
      if (loginState.startsWith("error:")) {
        throw new Error(`登录失败: ${loginState.slice(6)}`);
      }
      if (i === 14) {
        throw new Error("登录超时：30秒内未检测到登录成功状态");
      }
      console.log(`[scraper] 等待登录中... (${i + 1}/15)`);
    }

    // Wait for post-login redirects to fully settle before navigating
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    console.log(`[scraper] 登录后页面稳定, URL: ${page.url()}`);

    // === Step 1: Click "我的" in top nav ===
    console.log("[scraper] 点击右上角「我的」...");
    await page
      .locator("#column_top span")
      .filter({ hasText: "我的" })
      .click({ timeout: 10000 });

    console.log("[scraper] 等待「我的」页面加载...");
    await page.locator("b.cff8").waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(1000);
    console.log(`[scraper] 我的页面已加载, URL: ${page.url()}`);

    // === Step 2: Extract account balance (wait for real number) ===
    let balance = "";
    for (let i = 0; i < 10; i++) {
      balance = await page.evaluate(() => {
        const el = document.querySelector("b.cff8");
        if (!el) return "";
        const match = el.textContent?.match(/([0-9.]+)/);
        return match?.[1] || "";
      });
      if (balance) break;
      await page.waitForTimeout(1000);
    }
    console.log(`[scraper] 账户余额: ${balance} 元`);

    // === Step 3: Click sidebar "电量电费查询" ===
    console.log("[scraper] 点击侧边栏「电量电费查询」...");
    let urlBefore = page.url();
    await page
      .locator("a.SelectMenu")
      .filter({ hasText: "电量电费查询" })
      .click({ timeout: 10000 });

    await waitForUrlChange(page, urlBefore);
    await page.waitForLoadState("networkidle");
    await waitForVueRender(page);
    console.log(`[scraper] 电费查询页面, URL: ${page.url()}`);

    // === Step 4: Click "日用电量" tab ===
    console.log("[scraper] 点击「日用电量」tab...");
    await page
      .locator("#tab-second")
      .or(page.locator(".el-tabs__item").filter({ hasText: "日用电量" }))
      .first()
      .click({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // === Step 5: Read all daily usage rows ===
    const allDailyData = await page.evaluate(() => {
      const table = document.querySelector(".about-table");
      if (!table) return [];
      const rows = table.querySelectorAll(
        ".el-table__body .el-table__row",
      );
      return Array.from(rows).map((row) => {
        const cells = row.querySelectorAll(".cell");
        return {
          date: cells[0]?.textContent?.trim() || "",
          usage: cells[1]?.textContent?.trim() || "",
        };
      });
    });

    if (allDailyData.length === 0) throw new Error("未找到日用电量数据");
    console.log(`[scraper] 发现 ${allDailyData.length} 天的用电数据`);

    // === Step 6: Expand all rows for peak/valley breakdown ===
    console.log("[scraper] 展开所有行的峰谷详情...");
    const expandIcons = page.locator(
      ".about-table .el-table__expand-icon",
    );
    const expandCount = await expandIcons.count();
    for (let i = 0; i < expandCount; i++) {
      await expandIcons.nth(i).click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(2000);

    // Read all data from the expanded DOM at once
    const allData = await page.evaluate(() => {
      const table = document.querySelector(".about-table");
      if (!table) return [];
      const tbody = table.querySelector(".el-table__body tbody");
      if (!tbody) return [];

      const trs = Array.from(tbody.children) as HTMLTableRowElement[];
      const result: Array<{
        date: string;
        usage: string;
        peak: string;
        valley: string;
      }> = [];

      for (let i = 0; i < trs.length; i++) {
        const tr = trs[i]!;
        if (tr.querySelector(".el-table__expanded-cell")) continue;

        const cells = tr.querySelectorAll(".cell");
        const date = cells[0]?.textContent?.trim() || "";
        if (!date) continue;

        let peak = "",
          valley = "";
        const nextTr = trs[i + 1];
        if (nextTr) {
          const expanded =
            nextTr.querySelector(".el-table__expanded-cell") ||
            nextTr.querySelector(".drop-down");
          if (expanded) {
            const text = expanded.textContent || "";
            const pm = text.match(/峰[^0-9]*([0-9.]+)/);
            const vm = text.match(/谷[^0-9]*([0-9.]+)/);
            peak = pm?.[1] || "";
            valley = vm?.[1] || "";
          }
        }

        result.push({
          date,
          usage: cells[1]?.textContent?.trim() || "",
          peak,
          valley,
        });
      }
      return result;
    });

    // === Save all records ===
    const now = new Date().toISOString();
    const records: ElectricityRecord[] = allData.map((d) => ({
      date: d.date,
      fetchedAt: now,
      balance,
      usage: d.usage,
      peakUsage: d.peak,
      valleyUsage: d.valley,
    }));

    await saveRecords(records);
    console.log(
      `[scraper] 已保存 ${records.length} 条记录:`,
      records.map((r) => `${r.date} ${r.usage}kWh`).join(", "),
    );
    return records;
  } finally {
    if (browser) await browser.close();
    running = false;
  }
}
