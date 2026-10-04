// 登录测试的公共部分：设环境变量、起假服务、清库、模拟浏览器走一遍授权。
// 每个 *_test.ts 都调 setupAuthTests()（Deno 的 beforeAll / afterAll 按文件算）。
//
// 测试库：scripts/dev-db/up.sh --db pling_auth_test（PLING_AUTH_TEST_DB 可以换），
// 每个测试开始前清空 auth.users（profiles 等跟着 cascade 删掉）和 login_requests。
import postgres from 'npm:postgres@3.4.7';
import { closeDb, type Sql } from '../../../supabase/functions/_shared/db.ts';
import startHandler from '../../../supabase/functions/auth-start/handler.ts';
import callbackHandler from '../../../supabase/functions/auth-callback/handler.ts';
import finishHandler from '../../../supabase/functions/auth-finish/handler.ts';
import { FakeGoTrue, FakeQQ, FakeWechat, type Person, PERSON_HEADER, rememberPerson, SECRETS, serveFake, TEST } from './fakes.ts';

export const DB_URL = Deno.env.get('PLING_AUTH_TEST_DB') ?? 'postgres://postgres@127.0.0.1:54329/pling_auth_test';

export const FUNCTIONS_BASE = `${TEST.publicUrl}/api/functions/v1`;

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'PLING_PUBLIC_URL',
  'PLING_FUNCTIONS_URL',
  'PLING_CORS_ORIGINS',
  'WECHAT_API_BASE',
  'WECHAT_OPEN_BASE',
  'QQ_API_BASE',
  'WECHAT_OPEN_APPID',
  'WECHAT_OPEN_SECRET',
  'WECHAT_MP_APPID',
  'WECHAT_MP_SECRET',
  'QQ_APPID',
  'QQ_APPKEY',
];

export interface Ctx {
  sql: Sql;
  gotrue: FakeGoTrue;
  wechat: FakeWechat;
  qq: FakeQQ;
  /** 本次测试里云函数打出来的日志（console.error / warn / log），用来检查有没有把密钥写进日志 */
  logs: string[];
}

const servers: Deno.HttpServer[] = [];
let ctx: Ctx | null = null;
let urls = { gotrue: '', wechatApi: '', wechatOpen: '', qq: '' };
const realConsole = { error: console.error, warn: console.warn, log: console.log };

export function setupAuthTests(): () => Ctx {
  Deno.test.beforeAll(async () => {
    const sql = postgres(DB_URL, { max: 4, prepare: false, onnotice: () => {} });
    try {
      await sql`select 1 from public.login_requests limit 1`;
    } catch (e) {
      await sql.end({ timeout: 1 });
      throw new Error(`测试库没准备好（先跑 scripts/dev-db/up.sh --db pling_auth_test）：${(e as Error).message}`);
    }
    const gotrue = new FakeGoTrue(sql);
    const wechat = new FakeWechat();
    const qq = new FakeQQ();
    const g = serveFake('gotrue', gotrue.handle);
    const wa = serveFake('wechat-api', wechat.api);
    const wo = serveFake('wechat-open', wechat.open);
    const q = serveFake('qq', qq.handle);
    servers.push(g.server, wa.server, wo.server, q.server);
    urls = { gotrue: g.url, wechatApi: wa.url, wechatOpen: wo.url, qq: q.url };
    ctx = { sql, gotrue, wechat, qq, logs: [] };
  });

  Deno.test.beforeEach(async () => {
    const c = ctx!;
    for (const k of ENV_KEYS) Deno.env.delete(k);
    setEnv({
      SUPABASE_URL: urls.gotrue,
      SUPABASE_DB_URL: DB_URL,
      SUPABASE_SERVICE_ROLE_KEY: TEST.serviceKey,
      SUPABASE_ANON_KEY: TEST.anonKey,
      PLING_PUBLIC_URL: TEST.publicUrl,
      WECHAT_API_BASE: urls.wechatApi,
      WECHAT_OPEN_BASE: urls.wechatOpen,
      QQ_API_BASE: urls.qq,
      WECHAT_OPEN_APPID: TEST.wechatOpen.appid,
      WECHAT_OPEN_SECRET: TEST.wechatOpen.secret,
      WECHAT_MP_APPID: TEST.wechatMp.appid,
      WECHAT_MP_SECRET: TEST.wechatMp.secret,
      QQ_APPID: TEST.qq.appid,
      QQ_APPKEY: TEST.qq.appkey,
    });
    c.gotrue.reset();
    c.wechat.reset();
    c.qq.reset();
    c.logs = [];
    const capture = (...args: unknown[]) =>
      c.logs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
    console.error = capture;
    console.warn = capture;
    console.log = capture;
    await c.sql`delete from public.login_requests`;
    await c.sql`delete from auth.users`;
  });

  Deno.test.afterEach(() => {
    Object.assign(console, realConsole);
    // 云函数的日志里不能出现密钥
    const leaked = SECRETS.filter((s) => ctx!.logs.some((l) => l.includes(s)));
    if (leaked.length) throw new Error(`日志里出现了密钥：${leaked.join(', ')}\n${ctx!.logs.join('\n')}`);
  });

  Deno.test.afterAll(async () => {
    Object.assign(console, realConsole);
    await closeDb();
    for (const s of servers.splice(0)) await s.shutdown();
    if (ctx) {
      await ctx.sql.end({ timeout: 2 });
      ctx = null;
    }
  });

  return () => {
    if (!ctx) throw new Error('setupAuthTests: beforeAll 还没跑');
    return ctx;
  };
}

export function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// 调云函数
// ---------------------------------------------------------------------------

export type Provider = 'wechat_open' | 'wechat_mp' | 'qq';

export interface StartBody {
  provider?: unknown;
  client?: unknown;
  returnTo?: unknown;
  link?: unknown;
}

export async function callStart(body: StartBody | string, opts: { jwt?: string; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jwt) headers.Authorization = `Bearer ${opts.jwt}`;
  if (opts.origin) headers.Origin = opts.origin;
  return await startHandler(
    new Request(`${FUNCTIONS_BASE}/auth-start`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  );
}

export interface Started {
  id: string;
  secret: string;
  url: string;
}

export async function start(body: StartBody, opts: { jwt?: string } = {}): Promise<Started> {
  const res = await callStart(body, opts);
  const data = await res.json();
  if (res.status !== 200) throw new Error(`auth-start ${res.status}: ${JSON.stringify(data)}`);
  return data as Started;
}

export async function callCallback(query: string | URLSearchParams): Promise<Response> {
  return await callbackHandler(new Request(`${FUNCTIONS_BASE}/auth-callback?${query}`, { method: 'GET' }));
}

export async function callFinish(body: unknown, opts: { origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.origin) headers.Origin = opts.origin;
  return await finishHandler(
    new Request(`${FUNCTIONS_BASE}/auth-finish`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  );
}

export async function finish(s: { id: string; secret: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await callFinish({ id: s.id, secret: s.secret });
  return { status: res.status, body: await res.json() };
}

/**
 * 模拟浏览器打开授权页：person 在微信 / QQ 里同意（或 'cancel' 取消），
 * 假授权页 302 回 auth-callback（地址就是 auth-start 给的 redirect_uri），返回去掉主机的回调查询串。
 */
export async function authorize(url: string, person: Person | 'cancel'): Promise<URLSearchParams> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { [PERSON_HEADER]: person === 'cancel' ? 'cancel' : rememberPerson(person) },
  });
  const body = await res.text();
  if (res.status !== 302) throw new Error(`授权页没有跳回：${res.status} ${body}`);
  const back = new URL(res.headers.get('location')!);
  if (`${back.origin}${back.pathname}` !== `${FUNCTIONS_BASE}/auth-callback`) throw new Error(`跳回的地址不对：${back}`);
  return back.searchParams;
}

/** 完整走一遍：auth-start → 授权页 → auth-callback，返回回调的回应（网页版是 302，桌面版是 HTML） */
export async function runLogin(
  provider: Provider,
  person: Person | 'cancel',
  opts: { client?: 'web' | 'desktop'; returnTo?: string; link?: boolean; jwt?: string } = {},
): Promise<{ started: Started; callback: Response }> {
  const started = await start({ provider, client: opts.client ?? 'desktop', returnTo: opts.returnTo, link: opts.link }, { jwt: opts.jwt });
  const query = await authorize(started.url, person);
  const callback = await callCallback(query);
  return { started, callback };
}

/** 登录成功并取走令牌，返回用户 id（令牌对应的用户） */
export async function loginAs(provider: Provider, person: Person, opts: { client?: 'web' | 'desktop' } = {}): Promise<string> {
  const c = ctx!;
  const { started, callback } = await runLogin(provider, person, opts);
  const text = await callback.text();
  if (opts.client === 'web' ? callback.status !== 302 : callback.status !== 200) {
    throw new Error(`回调失败：${callback.status} ${callback.headers.get('location') ?? text}`);
  }
  const f = await finish(started);
  if (f.body.status !== 'done') throw new Error(`auth-finish 没有完成：${JSON.stringify(f.body)}`);
  const link = c.gotrue.links.find((l) => l.hashedToken === f.body.token_hash);
  if (!link) throw new Error('auth-finish 返回的令牌不是假 GoTrue 发的');
  return link.userId;
}

export interface ProfileRow {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  avatar_url: string;
  name_confirmed: boolean;
}

export async function profile(userId: string): Promise<ProfileRow | undefined> {
  const [p] = await ctx!.sql<ProfileRow[]>`
    select id, email, name, role, active, avatar_url, name_confirmed from public.profiles where id = ${userId}`;
  return p;
}

export async function requestRow(id: string): Promise<Record<string, unknown> | undefined> {
  const [r] = await ctx!.sql`select * from public.login_requests where id = ${id}`;
  return r;
}

/** 已有的邮箱账号（模拟 GoTrue 的邮箱验证码注册：直接插 auth.users，login_provider = email） */
export async function createEmailUser(email: string, name = ''): Promise<string> {
  const meta = name ? { name } : {};
  const [u] = await ctx!.sql<{ id: string }[]>`
    insert into auth.users (email, raw_user_meta_data) values (${email}, ${ctx!.sql.json(meta)}) returning id`;
  return u.id;
}
