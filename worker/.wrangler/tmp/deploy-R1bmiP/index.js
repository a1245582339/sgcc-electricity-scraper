var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var CODE_REGEX = /(?<!\d)(\d{6})(?!\d)/;
var CODE_TTL = 300;
function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}
__name(json, "json");
function checkAuth(request, env) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  return !!env.API_TOKEN && token === env.API_TOKEN;
}
__name(checkAuth, "checkAuth");
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
    const url = new URL(request.url);
    if (!checkAuth(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (request.method === "GET" && (url.pathname === "/data" || url.pathname === "/api/data")) {
      const data = await env.SMS_KV.get("electricity_data");
      if (!data) return json({ records: [], updatedAt: "" });
      return json(JSON.parse(data));
    }
    if (request.method === "POST" && url.pathname === "/sms") {
      const body = await request.json();
      const match = (body.text ?? "").match(CODE_REGEX);
      if (!match) return json({ error: "\u672A\u627E\u52306\u4F4D\u9A8C\u8BC1\u7801" }, 400);
      await env.SMS_KV.put("latest_code", match[1], { expirationTtl: CODE_TTL });
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/code") {
      const code = await env.SMS_KV.get("latest_code");
      if (!code) return json({ code: null });
      await env.SMS_KV.delete("latest_code");
      return json({ code });
    }
    if (request.method === "DELETE" && url.pathname === "/code") {
      await env.SMS_KV.delete("latest_code");
      return json({ ok: true });
    }
    if (request.method === "PUT" && url.pathname === "/data") {
      const body = await request.text();
      await env.SMS_KV.put("electricity_data", body);
      return json({ ok: true });
    }
    if (request.method === "POST" && (url.pathname === "/trigger" || url.pathname === "/api/trigger")) {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        return json({ error: "GITHUB_TOKEN \u6216 GITHUB_REPO \u672A\u914D\u7F6E" }, 500);
      }
      const ghRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scrape.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "sms-relay-worker"
          },
          body: JSON.stringify({ ref: "master" })
        }
      );
      if (ghRes.status === 204) return json({ message: "\u6293\u53D6\u4EFB\u52A1\u5DF2\u89E6\u53D1" });
      const errText = await ghRes.text();
      return json({ error: `GitHub API \u8FD4\u56DE ${ghRes.status}`, detail: errText }, ghRes.status);
    }
    return json({ error: "Not Found" }, 404);
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
