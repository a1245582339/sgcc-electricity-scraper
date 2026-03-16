import { EventEmitter } from "events";

const emitter = new EventEmitter();
const CODE_EVENT = "sms_code";
const CODE_REGEX = /(?<!\d)(\d{6})(?!\d)/;
const TIMEOUT_MS = 60 * 1000; // 1 minute

export function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeAllListeners(CODE_EVENT);
      reject(new Error("等待验证码超时 (1分钟)"));
    }, TIMEOUT_MS);

    emitter.once(CODE_EVENT, (code: string) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export function receiveCode(smsText: string): string | null {
  const match = smsText.match(CODE_REGEX);
  if (!match) return null;
  const code = match[1]!;
  emitter.emit(CODE_EVENT, code);
  return code;
}
