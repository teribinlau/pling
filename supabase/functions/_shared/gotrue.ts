// GoTrue 管理接口（用 service role）：建用户、生成一次性登录令牌。
import { cfg } from './env.ts';

function adminHeaders(): HeadersInit {
  const key = cfg.serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${cfg.supabaseUrl()}/auth/v1${path}`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`GoTrue ${path} ${res.status}: ${String(data.msg ?? data.message ?? data.error_description ?? data.error ?? '')}`);
  }
  return data as T;
}

export interface NewUser {
  email: string;
  name: string;
  avatarUrl: string;
  provider: 'wechat_open' | 'wechat_mp' | 'qq';
}

/** 建一个已确认邮箱的用户（不发邮件），返回用户 id */
export async function createUser(u: NewUser): Promise<string> {
  const data = await call<{ id: string }>('/admin/users', {
    email: u.email,
    email_confirm: true,
    user_metadata: { name: u.name, avatar_url: u.avatarUrl, login_provider: u.provider },
  });
  return data.id;
}

/** 给这个邮箱的用户生成一次性的登录令牌：客户端 verifyOtp({ token_hash, type }) 换会话 */
export async function generateLoginToken(email: string): Promise<{ tokenHash: string; type: string }> {
  const data = await call<{ hashed_token?: string; verification_type?: string; properties?: { hashed_token?: string; verification_type?: string } }>(
    '/admin/generate_link',
    { type: 'magiclink', email },
  );
  const tokenHash = data.hashed_token ?? data.properties?.hashed_token;
  const type = data.verification_type ?? data.properties?.verification_type ?? 'magiclink';
  if (!tokenHash) throw new Error('GoTrue generate_link: no hashed_token in response');
  return { tokenHash, type };
}
