import { EventEmitter } from "events";

const CODE_REGEX = /(?<!\d)(\d{6})(?!\d)/;

// --- Relay mode (Cloudflare Worker) ---
const SMS_RELAY_URL = process.env.SMS_RELAY_URL || "";
const SMS_RELAY_TOKEN = process.env.SMS_RELAY_TOKEN || "";
const RELAY_POLL_INTERVAL = 3000;  // 3s
const RELAY_POLL_TIMEOUT = 180000; // 3min

// --- Webhook mode (self-hosted) ---
const emitter = new EventEmitter();
const CODE_EVENT = "sms_code";
const WEBHOOK_TIMEOUT = 60000; // 1min

export function isRelayMode(): boolean {
  return SMS_RELAY_URL !== "";
}

/**
 * Wait for a verification code.
 * - Relay mode: polls CF Worker GET /code
 * - Webhook mode: waits for receiveCode() to emit the event
 */
export function waitForCode(): Promise<string> {
  if (isRelayMode()) {
    return pollRelay();
  }
  return waitWebhook();
}

/**
 * Clear any stale code on the relay before starting a new login.
 * No-op in webhook mode.
 */
export async function clearPendingCode(): Promise<void> {
  if (!isRelayMode()) return;
  try {
    await fetch(`${SMS_RELAY_URL}/code`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SMS_RELAY_TOKEN}` },
    });
  } catch {
    // best-effort
  }
}

/**
 * Webhook mode: called from server.ts when SmsForwarder POSTs to /api/webhook/sms
 */
export function receiveCode(smsText: string): string | null {
  const match = smsText.match(CODE_REGEX);
  if (!match) return null;
  const code = match[1]!;
  emitter.emit(CODE_EVENT, code);
  return code;
}

// --- Internal ---

async function pollRelay(): Promise<string> {
  const url = `${SMS_RELAY_URL}/code`;
  const headers = { Authorization: `Bearer ${SMS_RELAY_TOKEN}` };
  const maxAttempts = Math.floor(RELAY_POLL_TIMEOUT / RELAY_POLL_INTERVAL);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, RELAY_POLL_INTERVAL));
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = (await res.json()) as { code: string | null };
      if (data.code) {
        console.log("[sms-relay] 收到验证码");
        return data.code;
      }
    } catch {
      // network error, retry
    }
  }
  throw new Error(`等待验证码超时 (${RELAY_POLL_TIMEOUT / 1000}秒)`);
}

function waitWebhook(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeAllListeners(CODE_EVENT);
      reject(new Error("等待验证码超时 (1分钟)"));
    }, WEBHOOK_TIMEOUT);

    emitter.once(CODE_EVENT, (code: string) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
