// 推送相关的小工具：notify / notify-test / wechat-bind / wechat-mp 和 _shared/{wechat-mp,webhooks}.ts 共用。
const enc = new TextEncoder();

/**
 * 发往微信 / 机器人的每个请求的超时（毫秒）。最坏情况一条服务号消息要 4 个请求（发送 → 令牌失效 → 换令牌 → 重发），
 * notify 的时间预算按这个算（见 notify/run.ts）。测试里会改小。
 */
export const HTTP_TIMEOUT = { wechat: 6000, webhook: 6000 };

/** 定长比较（口令、签名），不因为前几位对上了就提前返回 */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function sha1Hex(s: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(s)));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256，结果 base64（钉钉加签、飞书签名） */
export async function hmacSha256Base64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** n 位随机串（[a-z0-9]，均匀分布） */
export function randomToken(n: number): string {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      // 252 = 36 × 7：丢掉 252–255，不然前几个字符出现得多一点
      if (b < 252 && out.length < n) out += ALNUM[b % 36];
    }
  }
  return out;
}

/** 按字符（不是 UTF-16 码元）截断；ellipsis = 截掉时最后一位换成「…」 */
export function clipChars(s: string, max: number, ellipsis = false): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return ellipsis ? chars.slice(0, Math.max(0, max - 1)).join('') + '…' : chars.slice(0, max).join('');
}

/** 去掉错误信息里网址的路径和参数（access_token、机器人的 key / 签名都在里面），只留协议和主机 */
export function scrubUrls(s: string): string {
  return s.replace(/(https?:\/\/[^/\s?#'")<>]+)[^\s'")<>]*/gi, '$1/…');
}

/** 错误信息写进发送记录 / last_status / 日志：短、能看出原因、不带密钥 */
export function errText(e: unknown): string {
  let s: string;
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) s = 'timeout';
  else if (e instanceof TypeError) s = `network: ${e.message}`;
  else if (e instanceof Error) s = e.message;
  else s = String(e);
  return clipChars(scrubUrls(s), 300);
}

/** 最多等 ms 毫秒：超时或出错都返回 fallback（原来的 promise 在后台接着跑，出错只记日志） */
export async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = p.catch((e) => {
    console.error(e);
    return fallback;
  });
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([guarded, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** 并发跑一组任务，最多 limit 个同时进行 */
export async function runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  if (!tasks.length) return;
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
}
