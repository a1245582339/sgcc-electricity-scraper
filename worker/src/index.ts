interface Env {
  SMS_KV: KVNamespace;
  API_TOKEN: string;
}

const CODE_REGEX = /(?<!\d)(\d{6})(?!\d)/;
const TTL = 300; // 5 min

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!env.API_TOKEN || token !== env.API_TOKEN) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    // SmsForwarder pushes SMS text here
    if (request.method === 'POST' && url.pathname === '/sms') {
      const body = await request.json<{ text?: string }>();
      const match = body.text?.match(CODE_REGEX);
      if (!match) return json({ error: '未找到6位验证码' }, 400);
      await env.SMS_KV.put('latest_code', match[1], { expirationTtl: TTL });
      return json({ ok: true });
    }

    // Scraper polls for the code
    if (request.method === 'GET' && url.pathname === '/code') {
      const code = await env.SMS_KV.get('latest_code');
      if (!code) return json({ code: null });
      await env.SMS_KV.delete('latest_code');
      return json({ code });
    }

    // Clear any pending code (called before scraper starts login)
    if (request.method === 'DELETE' && url.pathname === '/code') {
      await env.SMS_KV.delete('latest_code');
      return json({ ok: true });
    }

    return json({ error: 'Not Found' }, 404);
  },
};
