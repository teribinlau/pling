// 登录请求 id、一次性 secret、returnTo 的处理。

const UUID_RE = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

/** 请求 id：标准写法或去掉连字符的 32 位十六进制都认，统一成小写的标准写法；不是 uuid → null */
export function parseRequestId(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = UUID_RE.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase() : null;
}

/** 放进授权页 state 的写法：去掉连字符（微信要求 state 只用字母和数字，最长 128 字节） */
export function compactId(id: string): string {
  return id.replace(/-/g, '');
}

/** 32 字节随机数，base64url（43 个字符，不带 =） */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 库里只存 sha256(secret) 的十六进制 */
export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常数时间比较（长度不同直接 false；两边都是 sha256 十六进制，长度本来就一样） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 网页版登录完回到哪里：只接受本站的路径。
 * 以 `/` 开头，第二个字符不是 `/` 或 `\`（有的浏览器把 `/\` 当成 `//`），只含可见 ASCII，不带 `#`（后面要拼 `#pling-login=`），最长 1000。
 * 跳转地址是 `{PUBLIC}{returnTo}`，所以就算放过了奇怪的路径也跳不出本站；这里是为了不拼出坏地址。
 */
export function isSafeReturnTo(v: unknown): v is string {
  return typeof v === 'string' &&
    v.length <= 1000 &&
    /^\/(?![/\\])[\x21-\x7e]*$/.test(v) &&
    !v.includes('#') &&
    !v.includes('\\');
}
