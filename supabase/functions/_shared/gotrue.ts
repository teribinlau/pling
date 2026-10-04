// GoTrue 管理接口（用 service role）：建用户、删用户、生成一次性登录令牌。
import { cfg } from './env.ts';

const TIMEOUT_MS = 15_000;

function adminHeaders(): HeadersInit {
  const key = cfg.serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function call<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`GoTrue ${method} ${path}: timeout`, 'TimeoutError')), TIMEOUT_MS);
  let res: Response;
  let data: Record<string, unknown>;
  try {
    res = await fetch(`${cfg.supabaseUrl()}/auth/v1${path}`, {
      method,
      headers: adminHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(
      `GoTrue ${method} ${path} ${res.status}: ${String(data.msg ?? data.message ?? data.error_description ?? data.error ?? '')}`,
    );
  }
  return data as T;
}

export interface NewUser {
  email: string;
  name: string;
  avatarUrl: string;
  provider: 'wechat_open' | 'wechat_mp' | 'qq';
}

/**
 * 建一个已确认邮箱的用户（不发邮件），返回用户 id。
 * GoTrue 往 auth.users 插一行 → 触发 handle_new_user() 建 profile（login_provider 不是 email 时 profile 里 email 存空）。
 */
export async function createUser(u: NewUser): Promise<string> {
  const data = await call<{ id: string }>('POST', '/admin/users', {
    email: u.email,
    email_confirm: true,
    user_metadata: { name: u.name, avatar_url: u.avatarUrl, login_provider: u.provider },
  });
  if (!data.id) throw new Error('GoTrue POST /admin/users: no id in response');
  return data.id;
}

/** 删用户（登录没走完时清掉刚建的空账号）；profile 等跟着 on delete cascade 删掉 */
export async function deleteUser(id: string): Promise<void> {
  await call('DELETE', `/admin/users/${encodeURIComponent(id)}`);
}

/**
 * 给这个邮箱的用户生成一次性的登录令牌：客户端 verifyOtp({ token_hash, type }) 换会话。
 * 注意：同一个用户再生成一次，上一个还没用的令牌就失效了（GoTrue 每个用户只留一个 recovery 令牌）。
 */
export async function generateLoginToken(email: string): Promise<{ tokenHash: string; type: string }> {
  const data = await call<
    { hashed_token?: string; verification_type?: string; properties?: { hashed_token?: string; verification_type?: string } }
  >(
    'POST',
    '/admin/generate_link',
    { type: 'magiclink', email },
  );
  const tokenHash = data.hashed_token ?? data.properties?.hashed_token;
  const type = data.verification_type ?? data.properties?.verification_type ?? 'magiclink';
  if (!tokenHash) throw new Error('GoTrue generate_link: no hashed_token in response');
  return { tokenHash, type };
}
