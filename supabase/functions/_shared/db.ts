// 直连数据库（SUPABASE_DB_URL，服务端身份，绕过 RLS —— 权限要在函数里自己判断）。
import postgres from 'npm:postgres@3.4.7';
import { cfg } from './env.ts';

export type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function db(): Sql {
  if (!client) {
    const url = cfg.dbUrl();
    if (!url) throw new Error('SUPABASE_DB_URL is not set');
    client = postgres(url, { max: 4, idle_timeout: 20, prepare: false, onnotice: () => {} });
  }
  return client;
}

/** 测试结束时关连接 */
export async function closeDb(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    await c.end({ timeout: 2 });
  }
}
