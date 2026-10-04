// 云函数（docs/架构.md §6）的请求 / 回应类型，和统一的错误。
import type { LoginProvider } from './types';

export type PlingFunction = 'auth-start' | 'auth-finish' | 'wechat-bind' | 'notify-test';

/** 云函数报错：code 是服务器给的英文代码（{ error: code }），没有就是 http_<状态码> / network */
export class FnError extends Error {
  constructor(
    public code: string,
    message = code,
    public status = 0,
  ) {
    super(message);
    this.name = 'FnError';
  }
}

export interface AuthStartRequest {
  provider: LoginProvider;
  client: 'web' | 'desktop';
  returnTo?: string;
  /** 给当前登录的账号加绑这个身份（请求要带用户的 JWT，supabase-js 会自动带） */
  link?: boolean;
}

export interface AuthStartResponse {
  id: string;
  secret: string;
  url: string;
}

/** auth-finish 的回应（docs §6.3）：登录拿到一次性令牌；加绑完成是 linked: true，没有令牌（本来就登录着） */
export type AuthFinishResponse =
  | { status: 'pending' }
  | { status: 'done'; token_hash: string; type: string; linked?: false }
  | { status: 'done'; linked: true; token_hash?: undefined; type?: undefined }
  | { status: 'error'; error: string };

export interface WechatBindResponse {
  qrUrl: string;
  expiresAt: string;
}

export interface NotifyTestResponse {
  ok: boolean;
  error?: string;
}

/** 从 supabase-js 的 functions.invoke 错误里取出服务器给的代码 */
export async function fnErrorFrom(error: unknown): Promise<FnError> {
  const e = error as { message?: string; context?: unknown; name?: string };
  const ctx = e?.context;
  if (ctx && typeof (ctx as Response).status === 'number' && typeof (ctx as Response).clone === 'function') {
    const res = ctx as Response;
    let code = '';
    let message = e.message ?? '';
    try {
      const j = (await res.clone().json()) as { error?: unknown; message?: unknown };
      if (typeof j.error === 'string') code = j.error;
      if (typeof j.message === 'string') message = j.message;
    } catch {
      /* 不是 JSON */
    }
    return new FnError(code || `http_${res.status}`, message || code, res.status);
  }
  return new FnError('network', e?.message ?? String(error));
}
