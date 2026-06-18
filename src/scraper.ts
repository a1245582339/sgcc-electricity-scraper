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

async function showAccountLoginForm(page: Page, switchTab = true) {
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLElement>(".switch, .account-login, .code_form")
      .forEach((el) => {
        el.style.setProperty("display", "block", "important");
      });
  });
  if (switchTab) {
    const codeLoginTab = page.locator("div.code_login");
    if ((await codeLoginTab.count()) > 0) {
      await codeLoginTab.click({ force: true });
    }
  }
  await page.waitForTimeout(500);
}

async function setInputValue(
  page: Page,
  selector: string,
  value: string,
  label: string,
) {
  const input = page.locator(selector);
  if (await input.isVisible().catch(() => false)) {
    await input.fill(value);
    return;
  }

  const filled = await page.evaluate(
    ({ sel, val }) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (!el) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (nativeSetter) nativeSetter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { sel: selector, val: value },
  );
  if (!filled) throw new Error(`无法找到${label}`);
  console.log(`[scraper] 已通过 JS 注入${label}`);
}

async function ensureAgreementChecked(page: Page) {
  const unchecked = page.locator(".code_form .checked-box.un-checked");
  if ((await unchecked.count()) > 0) {
    await unchecked.first().click({ force: true });
    await page.waitForTimeout(300);
    return;
  }

  const checked = await page.evaluate(() => {
    const box = document.querySelector(".code_form .checked-box");
    if (!box) return true;
    return (
      box.classList.contains("checked") ||
      !box.classList.contains("un-checked")
    );
  });
  if (!checked) {
    await page.locator(".code_form .checked-box").first().click({ force: true });
    await page.waitForTimeout(300);
  }
}

async function readLoginFormState(page: Page) {
  return page.evaluate(() => {
    const phone = document.querySelector<HTMLInputElement>(
      '.account-login input[placeholder="手机号码"]',
    );
    const code = document.querySelector<HTMLInputElement>(
      '.account-login input[placeholder="请输入验证码"]',
    );
    const loginBtn = document.querySelector<HTMLButtonElement>(
      ".account-login .el-button--primary",
    );
    const agreement = document.querySelector(".code_form .checked-box");
    return {
      phone: phone?.value || "",
      code: code?.value || "",
      loginDisabled: loginBtn?.disabled ?? true,
      agreementChecked:
        !agreement?.classList.contains("un-checked") ||
        agreement?.classList.contains("checked") ||
        false,
    };
  });
}

async function submitLogin(page: Page) {
  const loginBtn = page.locator(".account-login .el-button--primary").last();
  const responsePromise = page
    .waitForResponse(
      (resp) =>
        resp.request().method() === "POST" &&
        /login|auth|verify|sms|code|member|user/i.test(resp.url()),
      { timeout: 20000 },
    )
    .catch(() => null);

  await loginBtn.click({ force: true, timeout: 10000 }).catch(async () => {
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".account-login .el-button--primary",
        ),
      );
      const btn = buttons.at(-1);
      btn?.click();
    });
  });

  const response = await responsePromise;
  if (response) {
    const status = response.status();
    console.log(`[scraper] 登录请求响应: ${status} ${response.url()}`);
    if (status >= 400) {
      const body = await response.text().catch(() => "");
      throw new Error(`登录接口返回 ${status}: ${body.slice(0, 200)}`);
    }
  }
}

async function detectLoginState(page: Page) {
  return page.evaluate(() => {
    const isVisible = (el: Element | null) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        (el as HTMLElement).offsetParent !== null
      );
    };

    const usernameEls = Array.from(document.querySelectorAll(".username"));
    for (const el of usernameEls) {
      if (!isVisible(el)) continue;
      const text = el.textContent?.trim() || "";
      if (text && !/登录|请登录|注册/.test(text)) return "ok";
    }

    const accountLogin = document.querySelector(".account-login");
    const phoneInput = document.querySelector<HTMLInputElement>(
      '.account-login input[placeholder="手机号码"]',
    );
    if (accountLogin && !isVisible(accountLogin) && !phoneInput?.offsetParent) {
      return "ok";
    }

    const topLogin = Array.from(
      document.querySelectorAll("#column_top span, #column_top a"),
    ).some(
      (el) =>
        isVisible(el) &&
        (el.textContent?.includes("登录") || el.textContent?.includes("请登录")),
    );
    const hasUserMenu = Array.from(
      document.querySelectorAll("#column_top span, #column_top a"),
    ).some(
      (el) =>
        isVisible(el) &&
        (el.textContent?.includes("我的") || el.textContent?.includes("退出")),
    );
    if (!topLogin && hasUserMenu) return "ok";

    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i) || "";
        if (/token|user(info)?|auth|session|login/i.test(key)) {
          const val = storage.getItem(key);
          if (val && val !== "null" && val !== "{}" && val !== "[]") {
            return "ok";
          }
        }
      }
    }

    const errorSelectors = [
      ".el-message",
      ".el-message-box",
      ".el-notification",
      ".el-form-item__error",
      ".el-message--error",
    ];
    for (const sel of errorSelectors) {
      for (const msg of Array.from(document.querySelectorAll(sel))) {
        const text = msg.textContent?.trim();
        if (text) return `error:${text}`;
      }
    }

    return "waiting";
  });
}

async function dumpLoginFailure(page: Page) {
  const formState = await readLoginFormState(page).catch(() => null);
  const loginState = await detectLoginState(page).catch(() => "unknown");
  console.log("[scraper] 登录失败诊断:", { formState, loginState, url: page.url() });
  await page.screenshot({ path: "scrape-debug.png", fullPage: true }).catch(() => {});
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

    // Switch to account login & SMS code login with retry,
    // because Vue may re-render and revert direct style changes.
    const phoneInput = page.locator('.account-login input[placeholder="手机号码"]');
    const MAX_LOGIN_SWITCH_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_LOGIN_SWITCH_ATTEMPTS; attempt++) {
      console.log(`[scraper] 切换到账号登录 (尝试 ${attempt}/${MAX_LOGIN_SWITCH_ATTEMPTS})...`);
      await showAccountLoginForm(page);

      if (await phoneInput.isVisible().catch(() => false)) break;

      if (attempt === MAX_LOGIN_SWITCH_ATTEMPTS) {
        console.log("[scraper] 输入框始终不可见，回退到 JS 直接注入");
      }
    }

    console.log("[scraper] 输入手机号...");
    await setInputValue(
      page,
      '.account-login input[placeholder="手机号码"]',
      phoneNumber,
      "手机号",
    );

    console.log("[scraper] 勾选同意协议...");
    await ensureAgreementChecked(page);

    console.log("[scraper] 点击获取验证码...");
    await clearPendingCode();
    await page.locator("a.yanzheng").click({ force: true });

    console.log("[scraper] 等待短信验证码...");
    const code = await waitForCode();
    console.log("[scraper] 收到验证码，准备提交登录...");

    // 等待验证码期间 Vue 可能重渲染，提交前重新确保表单可见并补全字段（不切换 tab，避免验证码失效）
    await showAccountLoginForm(page, false);
    await setInputValue(
      page,
      '.account-login input[placeholder="手机号码"]',
      phoneNumber,
      "手机号",
    );
    await ensureAgreementChecked(page);
    await setInputValue(
      page,
      '.account-login input[placeholder="请输入验证码"]',
      code,
      "验证码",
    );

    const formState = await readLoginFormState(page);
    console.log("[scraper] 提交前表单状态:", formState);
    if (!formState.phone || !formState.code) {
      throw new Error(
        `登录表单不完整: phone=${formState.phone ? "已填" : "空"}, code=${formState.code ? "已填" : "空"}`,
      );
    }

    console.log("[scraper] 点击登录...");
    await submitLogin(page);

    // Verify login success
    console.log("[scraper] 等待登录结果...");
    const MAX_LOGIN_WAIT = 30;
    for (let i = 0; i < MAX_LOGIN_WAIT; i++) {
      await page.waitForTimeout(2000);
      const loginState = await detectLoginState(page);

      if (loginState === "ok") {
        console.log(`[scraper] 登录成功, URL: ${page.url()}`);
        break;
      }
      if (loginState.startsWith("error:")) {
        await dumpLoginFailure(page);
        throw new Error(`登录失败: ${loginState.slice(6)}`);
      }
      if (i === MAX_LOGIN_WAIT - 1) {
        await dumpLoginFailure(page);
        throw new Error("登录超时：60秒内未检测到登录成功状态");
      }
      console.log(`[scraper] 等待登录中... (${i + 1}/${MAX_LOGIN_WAIT})`);
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
    console.log("[scraper] 账户余额已获取");

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
