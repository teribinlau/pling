// 测试用的假服务，都用 Deno.serve 起在 127.0.0.1 的随机端口上：
// - GoTrue（SUPABASE_URL）：/auth/v1/admin/users（建 / 删用户：直接写测试库的 auth.users，handle_new_user 触发器会真的跑）、
//   /auth/v1/admin/generate_link、/auth/v1/user（验用户 JWT）
// - 微信开放平台授权页（WECHAT_OPEN_BASE）：模拟用户扫码 / 点同意，302 回 redirect_uri?code=…&state=…
// - 微信接口（WECHAT_API_BASE）：/sns/oauth2/access_token、/sns/userinfo
// - QQ 互联（QQ_API_BASE）：/oauth2.0/authorize（模拟用户同意）、/oauth2.0/token、/oauth2.0/me、/user/get_user_info
import type { Sql } from '../../../supabase/functions/_shared/db.ts';

export const TEST = {
  publicUrl: 'https://pling.test',
  serviceKey: 'service-role-key-for-tests',
  anonKey: 'anon-key-for-tests',
  wechatOpen: { appid: 'wx0pen00000000test', secret: 'open-secret-DO-NOT-LEAK' },
  wechatMp: { appid: 'wxmp0000000000test', secret: 'mp-secret-DO-NOT-LEAK' },
  qq: { appid: '101000001', appkey: 'qq-appkey-DO-NOT-LEAK' },
};

export const SECRETS = [TEST.serviceKey, TEST.wechatOpen.secret, TEST.wechatMp.secret, TEST.qq.appkey];

/** 和云函数一样算回调地址（PLING_FUNCTIONS_URL 优先），假授权页拿它校验 redirect_uri */
export function expectedCallbackUrl(): string {
  const base = Deno.env.get('PLING_FUNCTIONS_URL') || `${Deno.env.get('PLING_PUBLIC_URL') ?? ''}/api/functions/v1`;
  return `${base.replace(/\/+$/, '')}/auth-callback`;
}

/** 在微信 / QQ 授权页上扫码的人 */
export interface Person {
  key: string;
  /** 微信 unionid（网站应用和服务号挂在同一个开放平台下才有） */
  unionid?: string;
  /** QQ unionid */
  qqUnionid?: string;
  nickname?: string;
  /** 微信 headimgurl / QQ figureurl_qq_2 */
  avatar?: string;
  /** 朋友圈快照页里的授权：微信只给虚拟 openid */
  snapshot?: boolean;
}

/** 同一个人在不同应用下 openid 不同 */
export function openidOf(p: Person, appid: string): string {
  return `o-${appid}-${p.key}`;
}

/**
 * 授权页上「谁在扫码」通过这个请求头告诉假授权页：值是 rememberPerson() 给的编号，或者 cancel（点了取消）。
 * （不直接放 JSON：请求头只能是 ASCII，昵称里有中文和 emoji）
 */
export const PERSON_HEADER = 'x-fake-person';

const people = new Map<string, Person>();

export function rememberPerson(p: Person): string {
  const ref = `p${people.size + 1}`;
  people.set(ref, structuredClone(p));
  return ref;
}

/** 注入的失败：raw 有值 → 原样回这段文本；否则回 JSON（去掉 status / raw） */
export type Fail = { status?: number; raw?: string; [k: string]: unknown };

function failResponse(f: Fail): Response {
  const { status = 200, raw, ...body } = f;
  if (raw !== undefined) return new Response(raw, { status, headers: { 'Content-Type': 'text/html' } });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'text/plain' } });
}

function bad(msg: string): Response {
  return new Response(`fake authorize page refused: ${msg}`, { status: 400 });
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function personFrom(req: Request): Person | 'cancel' | null {
  const v = req.headers.get(PERSON_HEADER);
  if (!v) return null;
  return v === 'cancel' ? 'cancel' : people.get(v) ?? null;
}

export function serveFake(
  name: string,
  handler: (req: Request) => Response | Promise<Response>,
): { server: Deno.HttpServer<Deno.NetAddr>; url: string } {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      return new Response(`[fake ${name}] ${e instanceof Error ? e.stack : String(e)}`, { status: 500 });
    }
  });
  return { server, url: `http://127.0.0.1:${server.addr.port}` };
}

// ---------------------------------------------------------------------------
// 微信
// ---------------------------------------------------------------------------
export class FakeWechat {
  codes = new Map<string, { appid: string; person: Person; used: boolean }>();
  tokens = new Map<string, { appid: string; person: Person }>();
  fail: { access_token?: Fail; userinfo?: Fail } = {};
  /** 调过的 sns 接口路径 */
  calls: string[] = [];

  reset(): void {
    this.codes.clear();
    this.tokens.clear();
    this.fail = {};
    this.calls = [];
  }

  /** WECHAT_OPEN_BASE：网站应用扫码页 / 服务号授权页。微信对授权链接做强匹配，参数顺序也要对 */
  open = (req: Request): Response => {
    const u = new URL(req.url);
    const kind = u.pathname === '/connect/qrconnect' ? 'open' : u.pathname === '/connect/oauth2/authorize' ? 'mp' : null;
    if (!kind) return new Response('not found', { status: 404 });
    const q = u.searchParams;
    const keys = [...q.keys()].join(',');
    if (keys !== 'appid,redirect_uri,response_type,scope,state') return bad(`参数顺序不对：${keys}`);
    const app = kind === 'open' ? TEST.wechatOpen : TEST.wechatMp;
    if (q.get('appid') !== app.appid) return bad('appid');
    if (q.get('redirect_uri') !== expectedCallbackUrl()) return bad(`redirect_uri 和回调域不符：${q.get('redirect_uri')}`);
    if (q.get('response_type') !== 'code') return bad('response_type');
    if (q.get('scope') !== (kind === 'open' ? 'snsapi_login' : 'snsapi_userinfo')) return bad('scope');
    const state = q.get('state') ?? '';
    if (!/^[a-zA-Z0-9]{1,128}$/.test(state)) return bad(`state 只能是 128 字节以内的字母数字：${state}`);

    const who = personFrom(req);
    if (!who) return bad(`没有 ${PERSON_HEADER} 请求头`);
    const back = new URL(q.get('redirect_uri')!);
    if (who !== 'cancel') {
      const code = `wxcode_${randomHex(8)}`;
      this.codes.set(code, { appid: app.appid, person: who, used: false });
      back.searchParams.set('code', code);
    }
    // 用户拒绝授权：只带 state
    back.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  };

  /** WECHAT_API_BASE：sns 接口（出错也是 HTTP 200 + { errcode, errmsg }，Content-Type 是 text/plain） */
  api = (req: Request): Response => {
    const u = new URL(req.url);
    const q = u.searchParams;
    this.calls.push(u.pathname);
    const wx = (errcode: number, errmsg: string) => failResponse({ errcode, errmsg: `${errmsg}, rid: ${randomHex(4)}` });

    if (u.pathname === '/sns/oauth2/access_token') {
      if (this.fail.access_token) return failResponse(this.fail.access_token);
      const app = [TEST.wechatOpen, TEST.wechatMp].find((a) => a.appid === q.get('appid'));
      if (!app) return wx(40013, 'invalid appid');
      if (q.get('secret') !== app.secret) return wx(40125, 'invalid appsecret');
      if (q.get('grant_type') !== 'authorization_code') return wx(40002, 'invalid grant_type');
      const c = this.codes.get(q.get('code') ?? '');
      if (!c || c.appid !== app.appid) return wx(40029, 'invalid code');
      if (c.used) return wx(40163, 'code been used');
      c.used = true;
      const accessToken = `wxat_${randomHex(12)}`;
      this.tokens.set(accessToken, { appid: app.appid, person: c.person });
      const body: Record<string, unknown> = {
        access_token: accessToken,
        expires_in: 7200,
        refresh_token: `wxrt_${randomHex(12)}`,
        openid: openidOf(c.person, app.appid),
        scope: app === TEST.wechatOpen ? 'snsapi_login' : 'snsapi_userinfo',
      };
      if (c.person.unionid) body.unionid = c.person.unionid;
      if (c.person.snapshot) body.is_snapshotuser = 1;
      return failResponse(body);
    }

    if (u.pathname === '/sns/userinfo') {
      if (this.fail.userinfo) return failResponse(this.fail.userinfo);
      const t = this.tokens.get(q.get('access_token') ?? '');
      if (!t) return wx(40001, 'invalid credential, access_token is invalid or not latest');
      const openid = openidOf(t.person, t.appid);
      if (q.get('openid') !== openid) return wx(40003, 'invalid openid');
      const body: Record<string, unknown> = {
        openid,
        nickname: t.person.nickname ?? '',
        sex: 0,
        language: '',
        city: '',
        province: '',
        country: '',
        headimgurl: t.person.avatar ?? '',
        privilege: [],
      };
      if (t.person.unionid) body.unionid = t.person.unionid;
      return failResponse(body);
    }
    return new Response('not found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// QQ 互联
// ---------------------------------------------------------------------------
export class FakeQQ {
  codes = new Map<string, { person: Person; redirectUri: string; used: boolean }>();
  tokens = new Map<string, Person>();
  fail: { token?: Fail; me?: Fail; get_user_info?: Fail } = {};
  /** token / me 用 JSONP 回（callback( {...} );） */
  jsonp = false;
  calls: string[] = [];

  reset(): void {
    this.codes.clear();
    this.tokens.clear();
    this.fail = {};
    this.jsonp = false;
    this.calls = [];
  }

  private reply(body: Record<string, unknown>, jsonp: boolean): Response {
    const text = jsonp ? `callback( ${JSON.stringify(body)} );\n` : JSON.stringify(body);
    return new Response(text, { headers: { 'Content-Type': 'text/html' } });
  }

  handle = (req: Request): Response => {
    const u = new URL(req.url);
    const q = u.searchParams;

    if (u.pathname === '/oauth2.0/authorize') {
      if (q.get('response_type') !== 'code') return bad('response_type');
      if (q.get('client_id') !== TEST.qq.appid) return bad('client_id');
      if (q.get('redirect_uri') !== expectedCallbackUrl()) return bad(`redirect_uri：${q.get('redirect_uri')}`);
      if (q.get('scope') !== 'get_user_info') return bad('scope');
      const state = q.get('state') ?? '';
      if (!state) return bad('state');
      const who = personFrom(req);
      if (!who) return bad(`没有 ${PERSON_HEADER} 请求头`);
      const back = new URL(q.get('redirect_uri')!);
      if (who === 'cancel') {
        back.searchParams.set('usercancel', '1');
      } else {
        const code = `qqcode_${randomHex(8)}`;
        this.codes.set(code, { person: who, redirectUri: q.get('redirect_uri')!, used: false });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }

    this.calls.push(u.pathname);
    if (u.pathname === '/oauth2.0/token') {
      if (this.fail.token) return failResponse(this.fail.token);
      const err = (error: number, d: string) => this.reply({ error, error_description: d }, this.jsonp);
      if (q.get('grant_type') !== 'authorization_code' || q.get('fmt') !== 'json') return err(100000, 'param error');
      if (q.get('client_id') !== TEST.qq.appid || q.get('client_secret') !== TEST.qq.appkey) return err(100016, 'client check failed');
      const c = this.codes.get(q.get('code') ?? '');
      if (!c || c.used) return err(100019, 'code to access token error');
      if (q.get('redirect_uri') !== c.redirectUri) return err(100010, 'redirect uri is illegal');
      c.used = true;
      const token = `qqat_${randomHex(12)}`;
      this.tokens.set(token, c.person);
      return this.reply({ access_token: token, expires_in: '7776000', refresh_token: `qqrt_${randomHex(12)}` }, this.jsonp);
    }

    if (u.pathname === '/oauth2.0/me') {
      if (this.fail.me) return failResponse(this.fail.me);
      const p = this.tokens.get(q.get('access_token') ?? '');
      if (!p) return this.reply({ error: 100016, error_description: 'access token check failed' }, this.jsonp);
      const body: Record<string, unknown> = { client_id: TEST.qq.appid, openid: openidOf(p, TEST.qq.appid) };
      if (q.get('unionid') === '1' && p.qqUnionid) body.unionid = p.qqUnionid;
      return this.reply(body, this.jsonp);
    }

    if (u.pathname === '/user/get_user_info') {
      if (this.fail.get_user_info) return failResponse(this.fail.get_user_info);
      const p = this.tokens.get(q.get('access_token') ?? '');
      if (!p || q.get('oauth_consumer_key') !== TEST.qq.appid || q.get('openid') !== openidOf(p, TEST.qq.appid)) {
        return this.reply({ ret: 1002, msg: '请先登录' }, false);
      }
      const small = p.avatar ? p.avatar.replace(/\/100$/, '/40') : '';
      return this.reply({
        ret: 0,
        msg: '',
        is_lost: 0,
        nickname: p.nickname ?? '',
        gender: '男',
        figureurl: small,
        figureurl_1: small,
        figureurl_2: p.avatar ?? '',
        figureurl_qq_1: small,
        figureurl_qq_2: p.avatar ?? '',
      }, false);
    }
    return new Response('not found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// GoTrue 管理接口
// ---------------------------------------------------------------------------

// GoTrue 用 badoux/checkmail 校验邮箱格式
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function gotrueError(status: number, errorCode: string, msg: string): Response {
  return Response.json({ code: status, error_code: errorCode, msg }, { status });
}

export class FakeGoTrue {
  /** 通过管理接口建的用户 id */
  created: string[] = [];
  deleted: string[] = [];
  /** 调过 DELETE /admin/users/<id> 的 id（不管用户在不在） */
  deleteAttempts: string[] = [];
  /** generate_link 发出去的令牌 */
  links: { userId: string; email: string; hashedToken: string }[] = [];
  /** GoTrue 每个用户只留最新的一个 magiclink（recovery）令牌 */
  latestToken = new Map<string, string>();
  /** 用户 JWT → 用户 id（/auth/v1/user 用） */
  sessions = new Map<string, string>();
  failCreate = false;
  failGenerateLink = false;
  createDelayMs = 0;
  /** 建好用户、回应之前调用（模拟并发） */
  onCreate: ((userId: string) => Promise<void>) | null = null;

  constructor(private sql: Sql) {}

  reset(): void {
    this.created = [];
    this.deleted = [];
    this.deleteAttempts = [];
    this.links = [];
    this.latestToken.clear();
    this.sessions.clear();
    this.failCreate = false;
    this.failGenerateLink = false;
    this.createDelayMs = 0;
    this.onCreate = null;
  }

  jwtFor(userId: string): string {
    const jwt = `eyJfake.${randomHex(16)}.sig`;
    this.sessions.set(jwt, userId);
    return jwt;
  }

  private userJson(u: { id: string; email: string; raw_user_meta_data: unknown; created_at: Date }): Record<string, unknown> {
    return {
      id: u.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: u.email,
      email_confirmed_at: u.created_at,
      phone: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: u.raw_user_meta_data ?? {},
      identities: [],
      created_at: u.created_at,
      updated_at: u.created_at,
      is_anonymous: false,
    };
  }

  handle = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, '');

    if (path === '/auth/v1/user' && req.method === 'GET') {
      const apikey = req.headers.get('apikey');
      if (apikey !== TEST.anonKey && apikey !== TEST.serviceKey) return gotrueError(401, 'no_authorization', 'Invalid API key');
      const jwt = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
      const id = this.sessions.get(jwt);
      if (!id) return gotrueError(403, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
      const [row] = await this.sql<{ id: string; email: string; raw_user_meta_data: unknown; created_at: Date }[]>`
        select id, email, raw_user_meta_data, created_at from auth.users where id = ${id}`;
      if (!row) return gotrueError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
      return Response.json(this.userJson(row));
    }

    if (!path.startsWith('/auth/v1/admin/')) return new Response('not found', { status: 404 });
    if (req.headers.get('apikey') !== TEST.serviceKey || req.headers.get('authorization') !== `Bearer ${TEST.serviceKey}`) {
      return gotrueError(401, 'no_authorization', 'This endpoint requires a valid service role key');
    }

    if (path === '/auth/v1/admin/users' && req.method === 'POST') {
      const body = (await req.json()) as { email?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> };
      const email = body.email ?? '';
      if (!email) return gotrueError(400, 'validation_failed', 'Cannot create a user without either an email or phone');
      if (email.length > 255 || !EMAIL_RE.test(email)) {
        return gotrueError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      }
      const lower = email.toLowerCase();
      const dup = await this.sql`select 1 from auth.users where lower(email) = ${lower}`;
      if (dup.length) return gotrueError(422, 'email_exists', 'A user with this email address has already been registered');
      if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
      if (this.failCreate) return gotrueError(500, 'unexpected_failure', 'Database error creating new user');
      const meta = (body.user_metadata ?? {}) as Record<string, string>;
      const [row] = await this.sql<{ id: string; email: string; raw_user_meta_data: unknown; created_at: Date }[]>`
        insert into auth.users (email, raw_user_meta_data) values (${lower}, ${this.sql.json(meta)})
        returning id, email, raw_user_meta_data, created_at`;
      this.created.push(row.id);
      if (this.onCreate) await this.onCreate(row.id);
      return Response.json(this.userJson(row));
    }

    const del = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(path);
    if (del && req.method === 'DELETE') {
      this.deleteAttempts.push(del[1]);
      const rows = await this.sql`delete from auth.users where id = ${del[1]} returning id`;
      if (!rows.length) return gotrueError(404, 'user_not_found', 'User not found');
      this.deleted.push(del[1]);
      return Response.json({});
    }

    if (path === '/auth/v1/admin/generate_link' && req.method === 'POST') {
      const body = (await req.json()) as { type?: string; email?: string };
      if (body.type !== 'magiclink') return gotrueError(400, 'validation_failed', `fake GoTrue only expects magiclink, got ${body.type}`);
      const email = (body.email ?? '').toLowerCase();
      if (!EMAIL_RE.test(email)) return gotrueError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      const [row] = await this.sql<{ id: string; email: string; raw_user_meta_data: unknown; created_at: Date }[]>`
        select id, email, raw_user_meta_data, created_at from auth.users where lower(email) = ${email}`;
      // 真的 GoTrue 在这里会悄悄注册一个新用户（magiclink → signup），这是 bug，让测试直接失败
      if (!row) return gotrueError(500, 'fake_unknown_email', `magiclink for unknown email ${email}: real GoTrue would sign up a new user`);
      if (this.failGenerateLink) return gotrueError(500, 'unexpected_failure', 'Database error updating user for recovery');
      const otp = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      const hashedToken = randomHex(28);
      this.latestToken.set(row.id, hashedToken);
      this.links.push({ userId: row.id, email, hashedToken });
      return Response.json({
        ...this.userJson(row),
        action_link: `${u.origin}/auth/v1/verify?token=${hashedToken}&type=magiclink&redirect_to=${encodeURIComponent(TEST.publicUrl)}`,
        email_otp: otp,
        hashed_token: hashedToken,
        verification_type: 'magiclink',
        redirect_to: TEST.publicUrl,
      });
    }

    return new Response('not found', { status: 404 });
  };
}
