// 微信 / QQ 登录的客户端流程（docs/架构.md §6.1–6.3）。和界面、store 无关，单元测试直接测这里。
//
// 网页版：auth-start → 把 { id, secret } 存 sessionStorage → 跳到微信 / QQ 授权页
//        → 授权完 auth-callback 302 回 `<publicUrl>[returnTo]#pling-login=<id>`（失败：#pling-login-error=<代码>）
//        → auth-finish 取一次性令牌 → auth.verifyOtp({ token_hash, type }) 换成会话 → 清掉 hash
// 桌面版：auth-start(client: 'desktop') → 系统浏览器打开授权页 → 每 2 秒问一次 auth-finish，最多 10 分钟
// 加绑（设置 → 账户）：auth-start 带 link: true（请求带着当前用户的 JWT），完成后不换会话，只刷新数据
import type { LoginProvider } from './types';
import type { AuthFinishResponse, AuthStartResponse } from './functions';
import { FnError } from './functions';
import i18n from '../i18n';

/** 登录这一步要用到的 repo 方法（SupabaseRepo 和测试里的假对象都行） */
export interface LoginRepo {
  authStart(req: { provider: LoginProvider; client: 'web' | 'desktop'; returnTo?: string; link?: boolean }): Promise<AuthStartResponse>;
  authFinish(id: string, secret: string): Promise<AuthFinishResponse>;
  verifyTokenHash(tokenHash: string, type: string): Promise<void>;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 网页版跳走之前存下的登录请求 */
export interface PendingWebLogin {
  id: string;
  secret: string;
  provider: LoginProvider;
  link: boolean;
  at: number;
}

export const LOGIN_STORAGE_KEY = 'pling-login';
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;

/** 登录失败：code 是给人看之前的英文代码（见 loginErrorText） */
export class LoginFailure extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'LoginFailure';
  }
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

export type LoginHash = { kind: 'done'; id: string } | { kind: 'error'; code: string };

/** 认 `#pling-login=<id>` / `#pling-login-error=<代码>`（前后可能还有别的参数）；不是登录回来的返回 null */
export function parseLoginHash(hash: string): LoginHash | null {
  const h = (hash ?? '').replace(/^#/, '');
  if (!h) return null;
  const params = new URLSearchParams(h);
  const err = params.get('pling-login-error');
  if (err !== null) return { kind: 'error', code: err.trim() || 'unknown' };
  const id = params.get('pling-login');
  if (id !== null && id.trim()) return { kind: 'done', id: id.trim() };
  return null;
}

/** 去掉 hash 里登录用的参数（别的参数留着）；返回新的 hash（可能是空串） */
export function stripLoginHash(hash: string): string {
  const params = new URLSearchParams((hash ?? '').replace(/^#/, ''));
  params.delete('pling-login');
  params.delete('pling-login-error');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

// ---------------------------------------------------------------------------
// 网页版
// ---------------------------------------------------------------------------

/**
 * 网页版 returnTo：和云函数 auth-start 的 isSafeReturnTo 同一套规则 —— 以 / 开头、第二个字符不是 / 或 \，
 * 只含可见 ASCII（中文要先编码），不含 # 和 \，最长 1000。不合格就不带（回首页），免得整个登录被 400 invalid_return_to 挡掉。
 */
export function safeReturnTo(path: string | null | undefined): string | undefined {
  if (!path || path.length > 1000) return undefined;
  if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(path) || path.includes('#') || path.includes('\\')) return undefined;
  return path;
}

/**
 * 网页版开始登录：调 auth-start，存好 { id, secret }，返回要跳转的授权页地址（调用的人负责 location.assign）。
 */
export async function startWebLogin(
  repo: LoginRepo,
  storage: KV,
  provider: LoginProvider,
  opts: { returnTo?: string; link?: boolean; now?: number } = {},
): Promise<string> {
  const res = await repo.authStart({ provider, client: 'web', returnTo: safeReturnTo(opts.returnTo), ...(opts.link ? { link: true } : {}) });
  if (!res?.id || !res?.secret || !res?.url) throw new LoginFailure('internal');
  const pending: PendingWebLogin = { id: res.id, secret: res.secret, provider, link: !!opts.link, at: opts.now ?? Date.now() };
  storage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(pending));
  return res.url;
}

export function readPendingWebLogin(storage: KV): PendingWebLogin | null {
  try {
    const raw = storage.getItem(LOGIN_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingWebLogin;
    return p && typeof p.id === 'string' && typeof p.secret === 'string' ? p : null;
  } catch {
    return null;
  }
}

export interface FinishResult {
  /** 加绑：没有换会话 */
  link: boolean;
  provider: LoginProvider | null;
}

/**
 * 网页版从授权页回来：按 hash 里的 id 找到存着的 secret，调 auth-finish，拿到令牌就 verifyOtp 换会话。
 * 不管成功失败都会清掉存着的请求（只能用一次）。失败抛 LoginFailure(code)。
 * auth-finish 偶尔会先回 pending（回调和这边几乎同时到）：再问几次。
 */
export async function finishWebLogin(
  repo: LoginRepo,
  storage: KV,
  hash: LoginHash,
  opts: { retries?: number; retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<FinishResult> {
  const pending = readPendingWebLogin(storage);
  storage.removeItem(LOGIN_STORAGE_KEY);
  if (hash.kind === 'error') throw new LoginFailure(hash.code);
  if (!pending || pending.id !== hash.id) throw new LoginFailure('invalid_request');
  if (Date.now() - pending.at > LOGIN_TIMEOUT_MS + 60000) throw new LoginFailure('expired');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 5;
  for (let i = 0; ; i++) {
    const r = await callFinish(repo, pending.id, pending.secret);
    if (r.status === 'done') {
      const link = pending.link || r.linked === true;
      if (!link) {
        if (!r.token_hash) throw new LoginFailure('internal');
        await verify(repo, r.token_hash, r.type ?? 'magiclink');
      }
      return { link, provider: pending.provider };
    }
    if (r.status === 'error') throw new LoginFailure(r.error || 'unknown');
    if (i >= retries) throw new LoginFailure('expired');
    await sleep(opts.retryDelayMs ?? 1000);
  }
}

async function callFinish(repo: LoginRepo, id: string, secret: string): Promise<AuthFinishResponse> {
  try {
    return await repo.authFinish(id, secret);
  } catch (e) {
    throw new LoginFailure(finishErrorCode(e));
  }
}

async function verify(repo: LoginRepo, tokenHash: string, type: string): Promise<void> {
  try {
    await repo.verifyTokenHash(tokenHash, type || 'magiclink');
  } catch (e) {
    console.warn('verifyOtp failed', e);
    throw new LoginFailure('internal');
  }
}

/** auth-finish 的错误：404 = 请求不存在 / 过期 / 已经用过 */
function finishErrorCode(e: unknown): string {
  if (e instanceof LoginFailure) return e.code;
  if (e instanceof FnError) {
    if (e.status === 404 || e.code === 'not_found') return 'expired';
    if (e.code === 'network') return 'network';
    return e.code || 'unknown';
  }
  return 'network';
}

// ---------------------------------------------------------------------------
// 桌面版：每 2 秒问一次，最多 10 分钟
// ---------------------------------------------------------------------------

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 加绑：拿到 done 就结束，不换会话 */
  link?: boolean;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LoginFailure('cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LoginFailure('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 桌面版：等用户在浏览器里登录完。done → verifyOtp 换会话（加绑模式不换）；error → LoginFailure(代码)；
 * 超过 10 分钟 → LoginFailure('expired')；取消（signal.abort()）→ LoginFailure('cancelled')。
 * 网络一时不通不算失败，接着问（直到超时）。
 */
export async function pollDesktopLogin(repo: LoginRepo, id: string, secret: string, opts: PollOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const timeout = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const started = now();
  for (;;) {
    if (opts.signal?.aborted) throw new LoginFailure('cancelled');
    let r: AuthFinishResponse | null = null;
    try {
      r = await repo.authFinish(id, secret);
    } catch (e) {
      const code = finishErrorCode(e);
      // 断网：接着等；请求没了（过期 / 用过）或者别的错误：停
      if (code !== 'network') throw new LoginFailure(code);
    }
    if (opts.signal?.aborted) throw new LoginFailure('cancelled');
    if (r?.status === 'done') {
      if (!opts.link && r.linked !== true) {
        if (!r.token_hash) throw new LoginFailure('internal');
        await verify(repo, r.token_hash, r.type ?? 'magiclink');
      }
      return;
    }
    if (r?.status === 'error') throw new LoginFailure(r.error || 'unknown');
    if (now() - started + interval > timeout) throw new LoginFailure('expired');
    await sleep(interval, opts.signal);
  }
}

// ---------------------------------------------------------------------------
// 错误代码 → 中文
// ---------------------------------------------------------------------------

const KNOWN = ['invalid_request', 'expired', 'cancelled', 'provider_disabled', 'wechat_error', 'wechat_snapshot', 'qq_error', 'already_linked', 'internal', 'network', 'unauthorized', 'invalid_return_to', 'not_configured'];

export function loginErrorText(code: string | null | undefined): string {
  const c = (code ?? '').trim() || 'unknown';
  if (KNOWN.includes(c)) return i18n.t(`login.errors.${c}`);
  if (c === 'not_found') return i18n.t('login.errors.expired');
  if (c === 'access_denied') return i18n.t('login.errors.cancelled');
  return i18n.t('login.errors.unknown', { code: c });
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

/** 微信内置浏览器（企业微信不算：服务号网页授权在企业微信里用不了） */
export function isWechatBrowser(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /MicroMessenger/i.test(ua) && !/wxwork/i.test(ua);
}

/** 手机 / 平板 */
export function isMobileBrowser(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua);
}

export interface LoginChoice {
  provider: LoginProvider;
  key: 'wechatMp' | 'wechatOpen' | 'qq';
}

/**
 * 登录页显示哪些按钮（docs §6.1）：
 *   微信里打开 → 微信一键登录（服务号网页授权）
 *   电脑浏览器 / 桌面版 → 微信扫码登录（开放平台网站应用）；手机上的普通浏览器不显示（扫不了自己），提示去微信里打开
 *   QQ 登录 → 哪里都行
 */
export function loginChoices(
  logins: { wechat: boolean; wechatMp: boolean; qq: boolean },
  env: { desktop: boolean; wechat: boolean; mobile: boolean },
): { choices: LoginChoice[]; openInWechatHint: boolean } {
  const choices: LoginChoice[] = [];
  let hint = false;
  if (env.wechat && !env.desktop && logins.wechatMp) choices.push({ provider: 'wechat_mp', key: 'wechatMp' });
  if (logins.wechat && (env.desktop || (!env.mobile && !env.wechat))) choices.push({ provider: 'wechat_open', key: 'wechatOpen' });
  if (!env.desktop && env.mobile && !env.wechat && (logins.wechatMp || logins.wechat)) hint = true;
  if (logins.qq) choices.push({ provider: 'qq', key: 'qq' });
  return { choices, openInWechatHint: hint };
}
