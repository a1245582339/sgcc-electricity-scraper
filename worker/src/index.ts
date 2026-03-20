interface Env {
  SMS_KV: KVNamespace;
  API_TOKEN: string;
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

    // GET /data 或 /api/data — 公开接口，读取电费数据
    if (request.method === 'GET' && (url.pathname === '/data' || url.pathname === '/api/data')) {
      const data = await env.SMS_KV.get('electricity_data');
      if (!data) return json({ records: [], updatedAt: '' });
      return new Response(data, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 以下接口需要鉴权
    if (!checkAuth(request, env)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // POST /sms — SmsForwarder 推送短信
    if (request.method === 'POST' && url.pathname === '/sms') {
      const body = await request.json<{ text?: string }>();
      const match = body.text?.match(CODE_REGEX);
      if (!match) return json({ error: '未找到6位验证码' }, 400);
      await env.SMS_KV.put('latest_code', match[1], { expirationTtl: CODE_TTL });
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

    return json({ error: 'Not Found' }, 404);
  },
};
