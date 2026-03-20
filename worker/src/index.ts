interface Env {
  SMS_KV: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  API_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
}

const CODE_REGEX = /(?<!\d)(\d{6})(?!\d)/;
const CODE_TTL = 300;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function checkAuth(request: Request, env: Env): boolean {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  return !!env.API_TOKEN && token === env.API_TOKEN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);

    if (!checkAuth(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // GET /data 或 /api/data — 读取电费数据
    if (request.method === 'GET' && (url.pathname === '/data' || url.pathname === '/api/data')) {
      const data = await env.SMS_KV.get('electricity_data');
      if (!data) return json({ records: [], updatedAt: '' });
      return json(JSON.parse(data));
    }

    // POST /sms — SmsForwarder 推送短信
    if (request.method === 'POST' && url.pathname === '/sms') {
      const body = (await request.json()) as { text?: string };
      const match = (body.text ?? '').match(CODE_REGEX);
      if (!match) return json({ error: '未找到6位验证码' }, 400);
      await env.SMS_KV.put('latest_code', match[1]!, { expirationTtl: CODE_TTL });
      return json({ ok: true });
    }

    // GET /code — scraper 轮询验证码
    if (request.method === 'GET' && url.pathname === '/code') {
      const code = await env.SMS_KV.get('latest_code');
      if (!code) return json({ code: null });
      await env.SMS_KV.delete('latest_code');
      return json({ code });
    }

    // DELETE /code — 清除残留验证码
    if (request.method === 'DELETE' && url.pathname === '/code') {
      await env.SMS_KV.delete('latest_code');
      return json({ ok: true });
    }

    // PUT /data — scraper 存储电费数据
    if (request.method === 'PUT' && url.pathname === '/data') {
      const body = await request.text();
      await env.SMS_KV.put('electricity_data', body);
      return json({ ok: true });
    }

    // POST /trigger 或 /api/trigger — 触发 GitHub Actions 抓取
    if (request.method === 'POST' && (url.pathname === '/trigger' || url.pathname === '/api/trigger')) {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        return json({ error: 'GITHUB_TOKEN 或 GITHUB_REPO 未配置' }, 500);
      }
      const ghRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scrape.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'sms-relay-worker',
          },
          body: JSON.stringify({ ref: 'master' }),
        },
      );
      if (ghRes.status === 204) return json({ message: '抓取任务已触发' });
      const errText = await ghRes.text();
      return json({ error: `GitHub API 返回 ${ghRes.status}`, detail: errText }, ghRes.status);
    }

    return json({ error: 'Not Found' }, 404);
  },
};
