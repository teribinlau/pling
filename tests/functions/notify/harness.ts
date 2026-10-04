// 推送测试的公共部分：环境变量、假服务、清库、造数据、调云函数。
// 每个 *_test.ts 调一次 setupNotifyTests()（Deno 的 beforeAll / afterAll 按文件算，每个文件是单独的 isolate）。
//
// 测试库：scripts/dev-db/up.sh --db pling_notify_test（PLING_NOTIFY_TEST_DB 可以换）。几个测试文件共用这个库，
// 每个测试开始前清空数据，所以不要用 --parallel 跑。
//
// team_webhooks.url 在迁移里要求 https:// 开头，假机器人在 http://127.0.0.1:<端口>：
// beforeAll 把这个约束换成「https:// 或 http://127.0.0.1:」，afterAll 清掉机器人后换回迁移里原来的约束（迁移文件不动）。
import postgres from 'npm:postgres@3.4.7';
import { createHash } from 'node:crypto';
import { closeDb, type Sql } from '../../../supabase/functions/_shared/db.ts';
import { HTTP_TIMEOUT } from '../../../supabase/functions/_shared/notify/util.ts';
import { LIMITS, runNotify, type RunOptions, type RunResult } from '../../../supabase/functions/_shared/notify/run.ts';
import notifyHandler from '../../../supabase/functions/notify/handler.ts';
import notifyTestHandler from '../../../supabase/functions/notify-test/handler.ts';
import wechatBindHandler from '../../../supabase/functions/wechat-bind/handler.ts';
import wechatMpHandler from '../../../supabase/functions/wechat-mp/handler.ts';
import { FakeAuth, FakeRobots, FakeWechat, SECRETS, serveFake, TEST } from './fakes.ts';

export const DB_URL = Deno.env.get('PLING_NOTIFY_TEST_DB') ?? 'postgres://postgres@127.0.0.1:54329/pling_notify_test';

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'PLING_PUBLIC_URL',
  'PLING_CRON_SECRET',
  'PLING_CORS_ORIGINS',
  'WECHAT_API_BASE',
  'WECHAT_MP_APPID',
  'WECHAT_MP_SECRET',
  'WECHAT_MP_TOKEN',
  'WECHAT_MP_TEMPLATE_ID',
  'WECHAT_MP_TEMPLATE_FIELDS',
];

const DEFAULT_TIMEOUTS = { ...HTTP_TIMEOUT };
/** 测试里同一个机器人的消息之间不用等（单独测间隔的地方再改） */
const TEST_LIMITS = { ...LIMITS, webhookGapMs: 0 };
const DEFAULT_LIMITS = { ...LIMITS };

export interface Person {
  id: string;
  name: string;
  /** 服务号 openid（没绑定是空串） */
  openid: string;
  jwt: string;
}

export interface Ctx {
  sql: Sql;
  wechat: FakeWechat;
  robots: FakeRobots;
  auth: FakeAuth;
  robotsUrl: string;
  /** 每个测试自动建的管理员（第一个用户），也是 reminder() 默认的创建人 */
  admin: Person;
  /** 本次测试里被测代码打的日志 */
  logs: string[];
}

const servers: Deno.HttpServer[] = [];
let ctx: Ctx | null = null;
let urls = { wechat: '', robots: '', auth: '' };
const realConsole = { error: console.error, warn: console.warn, log: console.log };

/** 和桌面版 / 生产一样，所有测试都不检查 Deno 的资源泄漏（数据库连接池是模块级单例，跨测试复用） */
export function test(name: string, fn: () => Promise<void> | void): void {
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
}

export function setupNotifyTests(): () => Ctx {
  Deno.test.beforeAll(async () => {
    const sql = postgres(DB_URL, { max: 4, prepare: false, onnotice: () => {} });
    try {
      await sql`select 1 from public.notification_log limit 1`;
    } catch (e) {
      await sql.end({ timeout: 1 });
      throw new Error(`测试库没准备好（先跑 scripts/dev-db/up.sh --db pling_notify_test）：${(e as Error).message}`);
    }
    await sql`delete from public.team_webhooks`;
    await sql`alter table public.team_webhooks drop constraint if exists team_webhooks_url_check`;
    await sql.unsafe(`alter table public.team_webhooks add constraint team_webhooks_url_check
      check (url ~ '^https://' or url ~ '^http://127\\.0\\.0\\.1:[0-9]+/')`);
    const wechat = new FakeWechat();
    const robots = new FakeRobots();
    const auth = new FakeAuth();
    const w = serveFake('wechat', wechat.handle);
    const r = serveFake('robots', robots.handle);
    const a = serveFake('auth', auth.handle);
    servers.push(w.server, r.server, a.server);
    urls = { wechat: w.url, robots: r.url, auth: a.url };
    ctx = { sql, wechat, robots, auth, robotsUrl: r.url, admin: null as unknown as Person, logs: [] };
  });

  Deno.test.beforeEach(async () => {
    const c = ctx!;
    resetEnv();
    Object.assign(HTTP_TIMEOUT, DEFAULT_TIMEOUTS);
    Object.assign(LIMITS, TEST_LIMITS);
    c.wechat.reset();
    c.robots.reset();
    c.auth.reset();
    c.logs = [];
    const capture = (...args: unknown[]) =>
      c.logs.push(
        args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : Deno.inspect(x))).join(' '),
      );
    console.error = capture;
    console.warn = capture;
    console.log = capture;
    await wipe(c.sql);
    c.admin = await createPerson(c, '王老师', { bind: false });
  });

  Deno.test.afterEach(async () => {
    Object.assign(console, realConsole);
    const c = ctx!;
    // 密钥、口令、access_token 不能出现在日志、发送记录、机器人状态里
    const secrets = [...SECRETS, ...c.wechat.issued];
    const rows = await c.sql<{ t: string }[]>`
      select error as t from public.notification_log union all select last_status from public.team_webhooks`;
    const places = [...c.logs, ...rows.map((r) => r.t)];
    const leaked = secrets.filter((s) => places.some((p) => p.includes(s)));
    if (leaked.length) throw new Error(`密钥泄漏到日志 / 数据库：${leaked.join(', ')}\n${places.join('\n')}`);
  });

  Deno.test.afterAll(async () => {
    Object.assign(console, realConsole);
    Object.assign(HTTP_TIMEOUT, DEFAULT_TIMEOUTS);
    Object.assign(LIMITS, DEFAULT_LIMITS);
    await closeDb();
    for (const s of servers.splice(0)) await s.shutdown();
    if (ctx) {
      const sql = ctx.sql;
      await wipe(sql);
      await sql`alter table public.team_webhooks drop constraint if exists team_webhooks_url_check`;
      await sql`alter table public.team_webhooks add constraint team_webhooks_url_check check (url ~ '^https://')`;
      await sql.end({ timeout: 2 });
      ctx = null;
    }
  });

  return () => {
    if (!ctx) throw new Error('setupNotifyTests: beforeAll 还没跑');
    return ctx;
  };
}

function resetEnv(): void {
  for (const k of ENV_KEYS) Deno.env.delete(k);
  setEnv({
    SUPABASE_URL: urls.auth,
    SUPABASE_DB_URL: DB_URL,
    SUPABASE_ANON_KEY: TEST.anonKey,
    PLING_PUBLIC_URL: TEST.publicUrl,
    PLING_CRON_SECRET: TEST.cronSecret,
    WECHAT_API_BASE: urls.wechat,
    WECHAT_MP_APPID: TEST.mp.appid,
    WECHAT_MP_SECRET: TEST.mp.secret,
    WECHAT_MP_TOKEN: TEST.mp.token,
    WECHAT_MP_TEMPLATE_ID: TEST.mp.templateId,
    WECHAT_MP_TEMPLATE_FIELDS: TEST.mp.fields,
  });
}

export function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

/** 清掉所有业务数据（profiles 等跟着 auth.users 级联删掉），机构设置恢复默认；节假日保留迁移里的 2026 年安排 */
async function wipe(sql: Sql): Promise<void> {
  await sql`delete from public.notification_log`;
  await sql`delete from public.kv_cache`;
  await sql`delete from public.team_webhooks`;
  await sql`delete from auth.users`;
  await sql`delete from public.teams`;
  await sql`update public.app_settings set org_name = '', team_label = '小组', org_label = '全体', timezone = 'Asia/Shanghai', push_overdue_max = 2`;
}

// ---------------------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------------------

/** 上海时间 → Date：sh('2026-10-09 17:00') */
export function sh(local: string): Date {
  return new Date(`${local.replace(' ', 'T')}:00+08:00`);
}

export interface PersonOpts {
  active?: boolean;
  station?: boolean;
  team?: string | null;
  /** 兼任的小组 */
  teams?: string[];
  phone?: string;
  admin?: boolean;
  /** 绑定服务号（默认绑，openid = openid-<序号>） */
  bind?: boolean;
  subscribed?: boolean;
}

let seq = 0;

async function createPerson(c: Ctx, name: string, o: PersonOpts = {}): Promise<Person> {
  const id = crypto.randomUUID();
  await c.sql`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${`u${++seq}@example.cn`}, ${
    JSON.stringify({ name })
  }::jsonb)`;
  await c.sql`
    update public.profiles
       set name = ${name}, active = ${o.active ?? true}, is_station = ${o.station ?? false}, team_id = ${o.team ?? null},
           phone = ${o.phone ?? ''}, role = case when ${o.admin ?? false} then 'admin' else role end, name_confirmed = true
     where id = ${id}`;
  for (const t of o.teams ?? []) await c.sql`insert into public.profile_teams (profile_id, team_id) values (${id}, ${t})`;
  let openid = '';
  if (o.bind ?? true) {
    openid = `openid-${seq}-${name}`;
    await c.sql`insert into public.wechat_bindings (user_id, openid, subscribed) values (${id}, ${openid}, ${o.subscribed ?? true})`;
  }
  return { id, name, openid, jwt: c.auth.jwtFor(id) };
}

export function makeBuilders(get: () => Ctx) {
  const c = () => get();
  return {
    /** 成员（默认已激活、绑定了服务号、关注着） */
    person: (name: string, o: PersonOpts = {}) => createPerson(c(), name, o),

    team: async (name: string): Promise<string> => {
      const [t] = await c().sql<{ id: string }[]>`insert into public.teams (name) values (${name}) returning id`;
      return t.id;
    },

    reminder: async (o: {
      title?: string;
      due: Date;
      rrule?: string | null;
      skipHolidays?: boolean;
      before?: number;
      repeat?: number;
      visibility?: 'private' | 'team' | 'company';
      team?: string | null;
      mode?: 'any' | 'each';
      by?: string;
      notes?: string;
      users?: string[];
      teams?: string[];
      archived?: boolean;
    }): Promise<string> => {
      const s = c().sql;
      const [r] = await s<{ id: string }[]>`
        insert into public.reminders (title, notes, due_at, rrule, skip_holidays, remind_before_min, overdue_repeat_min, visibility,
                                      team_id, created_by, completion_mode, archived)
        values (${o.title ?? '交物理实验报告'}, ${o.notes ?? ''}, ${o.due}, ${o.rrule ?? null}, ${o.skipHolidays ?? true}, ${
        o.before ?? 15
      },
                ${o.repeat ?? 30}, ${o.visibility ?? 'team'}, ${o.team ?? null}, ${o.by ?? c().admin.id}, ${o.mode ?? 'any'},
                ${o.archived ?? false})
        returning id`;
      for (const u of o.users ?? []) await s`insert into public.reminder_assignees (reminder_id, user_id) values (${r.id}, ${u})`;
      for (const t of o.teams ?? []) await s`insert into public.reminder_assignees (reminder_id, team_id) values (${r.id}, ${t})`;
      return r.id;
    },

    complete: async (reminderId: string, at: Date, userId: string, byName = '') => {
      await c().sql`insert into public.completions (reminder_id, occurrence_at, completed_by, completed_by_name)
                    values (${reminderId}, ${at}, ${userId}, ${byName})`;
    },

    snooze: async (reminderId: string, userId: string, at: Date, until: Date) => {
      await c()
        .sql`insert into public.snoozes (reminder_id, user_id, occurrence_at, until) values (${reminderId}, ${userId}, ${at}, ${until})
                    on conflict (reminder_id, user_id, occurrence_at) do update set until = excluded.until`;
    },

    prefs: async (userId: string, p: { wechat?: boolean; dnd?: boolean; from?: string; to?: string; restDays?: boolean }) => {
      await c().sql`
        insert into public.notify_prefs (user_id, wechat, dnd_enabled, dnd_from, dnd_to, dnd_rest_days)
        values (${userId}, ${p.wechat ?? true}, ${p.dnd ?? true}, ${p.from ?? '21:30'}, ${p.to ?? '07:00'}, ${p.restDays ?? true})
        on conflict (user_id) do update set wechat = excluded.wechat, dnd_enabled = excluded.dnd_enabled, dnd_from = excluded.dnd_from,
          dnd_to = excluded.dnd_to, dnd_rest_days = excluded.dnd_rest_days`;
    },

    /** 群机器人；path 形如 /wecom/a（假接收端按前缀区分是哪家） */
    webhook: async (o: {
      kind: 'wecom' | 'dingtalk' | 'feishu';
      path: string;
      team?: string | null;
      secret?: string;
      stages?: string[];
      enabled?: boolean;
      name?: string;
    }): Promise<string> => {
      if (o.secret) c().robots.secrets.set(o.path, o.secret);
      const [w] = await c().sql<{ id: string }[]>`
        insert into public.team_webhooks (team_id, kind, name, url, secret, stages, enabled)
        values (${o.team ?? null}, ${o.kind}, ${o.name ?? o.path}, ${c().robotsUrl + o.path}, ${o.secret ?? ''},
                ${o.stages ?? ['due']}::text[], ${o.enabled ?? true})
        returning id`;
      return w.id;
    },

    settings: async (p: { push_overdue_max?: number; timezone?: string; org_label?: string; org_name?: string }) => {
      const s = c().sql;
      if (p.push_overdue_max !== undefined) await s`update public.app_settings set push_overdue_max = ${p.push_overdue_max}`;
      if (p.timezone !== undefined) await s`update public.app_settings set timezone = ${p.timezone}`;
      if (p.org_label !== undefined) await s`update public.app_settings set org_label = ${p.org_label}`;
      if (p.org_name !== undefined) await s`update public.app_settings set org_name = ${p.org_name}`;
    },
  };
}

// ---------------------------------------------------------------------------
// 跑 / 调
// ---------------------------------------------------------------------------

/** 跑一次 notify（不经过 HTTP），now 是假的当前时间 */
export async function run(now: Date, opts: Omit<RunOptions, 'now'> = {}): Promise<RunResult> {
  const r = await runNotify({ ...opts, now });
  if ('skipped' in r && r.skipped === 'busy') throw new Error('notify 返回了 busy');
  return r as RunResult;
}

export function callNotify(headers: Record<string, string> = { 'x-cron-secret': TEST.cronSecret }, method = 'POST'): Promise<Response> {
  return notifyHandler(new Request('http://functions:9000/notify', { method, headers, body: method === 'POST' ? '{}' : undefined }));
}

export function callNotifyTest(body: unknown, jwt?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return notifyTestHandler(
    new Request(`${TEST.publicUrl}/api/functions/v1/notify-test`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

export function callWechatBind(jwt?: string, method = 'POST'): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return wechatBindHandler(
    new Request(`${TEST.publicUrl}/api/functions/v1/wechat-bind`, { method, headers, body: method === 'POST' ? '{}' : undefined }),
  );
}

/** 微信服务器的签名（用 node:crypto 自己算，和被测代码无关） */
export function wxSign(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');
}

export function signedQuery(extra: Record<string, string> = {}, token = TEST.mp.token): URLSearchParams {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = String(Math.floor(Math.random() * 1e9));
  return new URLSearchParams({ signature: wxSign(token, timestamp, nonce), timestamp, nonce, ...extra });
}

export function callWechatMp(method: 'GET' | 'POST', query: URLSearchParams, body?: string): Promise<Response> {
  return wechatMpHandler(
    new Request(`${TEST.publicUrl}/api/functions/v1/wechat-mp?${query}`, {
      method,
      body,
      headers: body ? { 'Content-Type': 'text/xml' } : {},
    }),
  );
}

/** 微信推过来的事件 XML */
export function eventXml(openid: string, event: string, eventKey?: string, extra = ''): string {
  return `<xml><ToUserName><![CDATA[gh_pling_test]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event}]]></Event>` +
    (eventKey !== undefined ? `<EventKey><![CDATA[${eventKey}]]></EventKey>` : '') + extra + `</xml>`;
}

export function textXml(openid: string, content: string): string {
  return `<xml><ToUserName><![CDATA[gh_pling_test]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${content}]]></Content><MsgId>1234567890123456</MsgId></xml>`;
}

// ---------------------------------------------------------------------------
// 查结果
// ---------------------------------------------------------------------------

export interface LogRow {
  dedupe_key: string;
  channel: string;
  user_id: string | null;
  webhook_id: string | null;
  reminder_id: string | null;
  occurrence_at: Date | null;
  stage: string;
  status: string;
  error: string;
}

export async function logRows(sql: Sql): Promise<LogRow[]> {
  return await sql<LogRow[]>`
    select dedupe_key, channel, user_id, webhook_id, reminder_id, occurrence_at, stage, status, error
      from public.notification_log order by id`;
}

/** 服务号这次收到的：[openid, 阶段文字] */
export function wxSent(c: Ctx): Array<[string, string]> {
  return c.wechat.sent.map((s) => [s.touser, s.data.phrase3?.value ?? '']);
}
