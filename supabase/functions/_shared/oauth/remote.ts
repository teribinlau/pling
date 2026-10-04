// 调微信 / QQ 接口用的小工具：带超时的 GET、宽松地解析返回内容、清理昵称 / 头像、打码的错误信息。

const TIMEOUT_MS = 10_000;

export type Json = Record<string, unknown>;

/** GET 一个地址，返回状态码和响应文本（HTTP 状态交给调用方判断）；连不上 / 超时（10 秒，含读完响应）会抛异常 */
export async function getText(url: string): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`timeout after ${TIMEOUT_MS / 1000}s`, 'TimeoutError')), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac.signal });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 是 JSON 对象才返回，否则 null（微信有时用 text/plain 回 JSON，所以不看 Content-Type） */
export function parseJsonObject(text: string): Json | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** 去掉控制字符，最多 n 个字（按字符算，emoji 不会被切成乱码） */
export function cleanText(s: string, n: number): string {
  // deno-lint-ignore no-control-regex
  return Array.from(s.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, n).join('');
}

/** 头像只收 http(s) 地址；qlogo.cn 的 http 地址换成 https（网页版是 https，http 图片会被浏览器拦掉） */
export function cleanAvatar(u: string): string {
  if (u.length > 1000 || !/^https?:\/\/[^\s"'<>]+$/i.test(u)) return '';
  return u.replace(/^http:\/\/([a-z0-9.-]*\.qlogo\.cn)\//i, 'https://$1/');
}

/**
 * 异常信息（写日志、显示在错误页上用）。Deno 的 fetch 报错可能带上完整的请求地址，里面有 AppSecret，
 * 所以把密钥类参数打码。
 */
export function errorMessage(e: unknown): string {
  return redact(e instanceof Error || e instanceof DOMException ? e.message || e.name : String(e));
}

/** 把地址参数里的密钥打码，最多留 300 个字符 */
export function redact(s: string): string {
  return s.replace(/\b((?:client_)?secret|appkey|access_token|code)=[^&\s)"']*/gi, '$1=***').slice(0, 300);
}
