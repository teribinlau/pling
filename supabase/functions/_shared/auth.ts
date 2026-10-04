// 验证调用者身份：客户端带 Authorization: Bearer <用户 JWT>，交给 GoTrue 的 /auth/v1/user 验。
import { cfg } from './env.ts';
import { db } from './db.ts';
import { HttpError } from './http.ts';

export interface Caller {
  id: string;
  email: string;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** 没带 / 无效的令牌 → null */
export async function getCaller(req: Request): Promise<Caller | null> {
  const token = bearer(req);
  if (!token) return null;
  const res = await fetch(`${cfg.supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: cfg.anonKey() || cfg.serviceKey(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as { id?: string; email?: string };
  return u.id ? { id: u.id, email: u.email ?? '' } : null;
}

/** 必须是已激活的成员 */
export async function requireMember(req: Request): Promise<Caller & { role: string }> {
  const c = await getCaller(req);
  if (!c) throw new HttpError(401, 'unauthorized');
  const rows = await db()<{ role: string; active: boolean }[]>`select role, active from public.profiles where id = ${c.id}`;
  if (!rows.length || !rows[0].active) throw new HttpError(403, 'inactive');
  return { ...c, role: rows[0].role };
}

/** 必须是管理员 */
export async function requireAdmin(req: Request): Promise<Caller> {
  const c = await requireMember(req);
  if (c.role !== 'admin') throw new HttpError(403, 'admin_only');
  return c;
}
