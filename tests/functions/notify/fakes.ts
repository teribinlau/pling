// 推送测试用的假服务：微信服务号接口、三家群机器人的接收端、GoTrue 的 /auth/v1/user。
// 都是 Deno.serve 在 127.0.0.1 的随机端口上；加签用 node:crypto 自己验一遍（和被测代码的 WebCrypto 实现无关）。
import { createHmac } from 'node:crypto';

export const TEST = {
  publicUrl: 'https://pling.example.cn',
  cronSecret: 'cron-secret-for-tests',
  anonKey: 'anon-key-for-tests',
  mp: {
    appid: 'wx-mp-test-appid',
    secret: 'wx-mp-test-appsecret-0123456789',
    token: 'mp-server-token',
    templateId: 'TPL-REMINDER-001',
    /** 模板字段：六个值都映射上（character_string 的截断在 unit_test 里单独测） */
    fields: 'title=thing1,time=time2,stage=phrase3,team=thing4,creator=name5,note=thing6',
  },
};

/** 这些字符串不能出现在日志、发送记录、机器人状态里 */
export const SECRETS = [TEST.mp.secret, TEST.cronSecret];

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

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 等 ms 毫秒；请求被客户端放弃（超时）就提前结束 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// 微信服务号接口
// ---------------------------------------------------------------------------
export interface WxError {
  errcode: number;
  errmsg: string;
}

export interface SentTemplate {
  touser: string;
  template_id: string;
  url?: string;
  data: Record<string, { value: string }>;
  token: string;
}

export class FakeWechat {
  /** 当前有效的令牌（stable_token 普通模式返回它） */
  current: string | null = null;
  /** 过期了的令牌（发消息 → 42001；stable_token 普通模式会换新的） */
  expired = new Set<string>();
  /** 微信不认的令牌（发消息 → 40001），即使它是 current（模拟「普通模式拿到的还是坏的」） */
  rejected = new Set<string>();
  /** true：不管什么令牌，发消息都回 40001 */
  rejectAll = false;
  expiresIn = 7200;
  /** stable_token 直接报错（如 40164 IP 不在白名单） */
  tokenError: WxError | null = null;
  tokenCalls: { force: boolean; appid: string }[] = [];
  /** 发出去了的模板消息 */
  sent: SentTemplate[] = [];
  /** 收到的发送请求（含失败的） */
  attempts: { touser: string; token: string; errcode: number }[] = [];
  /** 这些 openid 没关注（43004） */
  unsubscribed = new Set<string>();
  /** 某个 openid 的发送固定回这个错误 */
  sendErrors = new Map<string, WxError>();
  /** 某个 openid 的发送要等这么久（毫秒），用来测超时 */
  slow = new Map<string, number>();
  /** 所有发送都等这么久（测两次运行重叠） */
  sendDelayMs = 0;
  qrcodes: { body: Record<string, unknown>; ticket: string }[] = [];
  qrError: WxError | null = null;
  private seq = 0;

  reset(): void {
    this.current = null;
    this.expired.clear();
    this.rejected.clear();
    this.rejectAll = false;
    this.expiresIn = 7200;
    this.tokenError = null;
    this.tokenCalls = [];
    this.sent = [];
    this.attempts = [];
    this.unsubscribed.clear();
    this.sendErrors.clear();
    this.slow.clear();
    this.sendDelayMs = 0;
    this.qrcodes = [];
    this.qrError = null;
  }

  /** 发一个新令牌（旧的随之失效，和强制刷新一样） */
  issue(): string {
    this.current = `tok-${++this.seq}-${crypto.randomUUID().slice(0, 8)}`;
    return this.current;
  }

  /** 所有发出过的令牌（检查它们没进日志 / 数据库） */
  issued: string[] = [];

  private check(token: string): WxError | null {
    if (this.rejectAll || this.rejected.has(token)) {
      return { errcode: 40001, errmsg: 'invalid credential, access_token is invalid or not latest' };
    }
    if (this.expired.has(token)) return { errcode: 42001, errmsg: 'access_token expired' };
    if (!token || token !== this.current) return { errcode: 40001, errmsg: 'invalid credential, access_token is invalid or not latest' };
    return null;
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== 'POST') return jsonRes({ errcode: 43002, errmsg: 'require POST method' });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (url.pathname === '/cgi-bin/stable_token') {
      const force = body.force_refresh === true;
      this.tokenCalls.push({ force, appid: String(body.appid) });
      if (this.tokenError) return jsonRes(this.tokenError);
      if (body.grant_type !== 'client_credential') return jsonRes({ errcode: 40002, errmsg: 'invalid grant_type' });
      if (body.appid !== TEST.mp.appid) return jsonRes({ errcode: 40013, errmsg: 'invalid appid' });
      if (body.secret !== TEST.mp.secret) return jsonRes({ errcode: 40125, errmsg: 'invalid appsecret' });
      if (force || !this.current || this.expired.has(this.current)) {
        this.issue();
        this.issued.push(this.current!);
      }
      return jsonRes({ access_token: this.current, expires_in: this.expiresIn });
    }
    const token = url.searchParams.get('access_token') ?? '';
    if (url.pathname === '/cgi-bin/message/template/send') {
      const touser = String(body.touser ?? '');
      await sleep(Math.max(this.sendDelayMs, this.slow.get(touser) ?? 0), req.signal);
      // 客户端已经超时走了：当作没发出去（真的微信可能已经发了，见报告）
      if (req.signal.aborted) return new Response(null, { status: 499 });
      const bad = this.check(token) ?? this.sendErrors.get(touser) ??
        (this.unsubscribed.has(touser) ? { errcode: 43004, errmsg: 'require subscribe' } : null);
      this.attempts.push({ touser, token, errcode: bad?.errcode ?? 0 });
      if (bad) return jsonRes(bad);
      this.sent.push({
        touser,
        template_id: String(body.template_id),
        url: body.url as string | undefined,
        data: body.data as SentTemplate['data'],
        token,
      });
      return jsonRes({ errcode: 0, errmsg: 'ok', msgid: 1000 + this.sent.length });
    }
    if (url.pathname === '/cgi-bin/qrcode/create') {
      const bad = this.check(token) ?? this.qrError;
      if (bad) return jsonRes(bad);
      const ticket = `gQH47joAAAAAAAAAASxodHRwOi8vd2VpeGluLnFxLmNvbS9xLzAy${this.qrcodes.length + 1}+/=`;
      this.qrcodes.push({ body, ticket });
      return jsonRes({ ticket, expire_seconds: body.expire_seconds, url: `http://weixin.qq.com/q/${this.qrcodes.length}` });
    }
    return jsonRes({ errcode: 404, errmsg: `no such api ${url.pathname}` }, 404);
  };
}

// ---------------------------------------------------------------------------
// 群机器人的接收端：/wecom/<名字>、/dingtalk/<名字>、/feishu/<名字>
// 钉钉 / 飞书按 secrets 里登记的密钥验签（和真的一样：签名不对就报错）
// ---------------------------------------------------------------------------
export interface RobotCall {
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** 收到的时间（毫秒） */
  at: number;
}

export class FakeRobots {
  calls: RobotCall[] = [];
  /** 路径 → 密钥（钉钉 / 飞书加签） */
  secrets = new Map<string, string>();
  /** 路径 → 固定的回应（raw = 原样回这段文字，不转成 JSON） */
  responses = new Map<string, { status?: number; body?: unknown; raw?: string }>();
  /** 路径 → 等多久再回（毫秒） */
  delays = new Map<string, number>();
  /** 验签用的「现在」（毫秒）；null = 不检查时间戳新不新 */
  clockMs: number | null = null;

  reset(): void {
    this.calls = [];
    this.secrets.clear();
    this.responses.clear();
    this.delays.clear();
    this.clockMs = null;
  }

  callsTo(path: string): RobotCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  handle = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return jsonRes({ errcode: 40035, errmsg: 'invalid json' });
    this.calls.push({ path: u.pathname, query: u.searchParams, body, at: Date.now() });
    await sleep(this.delays.get(u.pathname) ?? 0, req.signal);
    if (req.signal.aborted) return new Response(null, { status: 499 });
    const fixed = this.responses.get(u.pathname);
    if (fixed?.raw !== undefined) return new Response(fixed.raw, { status: fixed.status ?? 200, headers: { 'Content-Type': 'text/html' } });
    if (fixed) return jsonRes(fixed.body, fixed.status ?? 200);
    const secret = this.secrets.get(u.pathname);
    if (u.pathname.startsWith('/wecom/')) return jsonRes({ errcode: 0, errmsg: 'ok' });
    if (u.pathname.startsWith('/dingtalk/')) {
      if (secret) {
        const ts = u.searchParams.get('timestamp') ?? '';
        const sign = u.searchParams.get('sign') ?? '';
        const want = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
        if (sign !== want) return jsonRes({ errcode: 310000, errmsg: 'sign not match' });
      }
      return jsonRes({ errcode: 0, errmsg: 'ok' });
    }
    if (u.pathname.startsWith('/feishu/')) {
      if (secret) {
        const ts = String(body.timestamp ?? '');
        const want = createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
        if (body.sign !== want) {
          return jsonRes({ code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' });
        }
      }
      return jsonRes({ code: 0, msg: 'success', data: {} });
    }
    return jsonRes({ errcode: 404, errmsg: 'not found' }, 404);
  };
}

// ---------------------------------------------------------------------------
// GoTrue：只有 /auth/v1/user（requireMember / requireAdmin 用它验用户的 JWT）
// ---------------------------------------------------------------------------
export class FakeAuth {
  /** 令牌 → 用户 id */
  tokens = new Map<string, string>();

  reset(): void {
    this.tokens.clear();
  }

  jwtFor(userId: string): string {
    const t = `jwt-${userId}`;
    this.tokens.set(t, userId);
    return t;
  }

  handle = (req: Request): Response => {
    const u = new URL(req.url);
    if (u.pathname !== '/auth/v1/user') return jsonRes({ msg: 'not found' }, 404);
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
    const id = m ? this.tokens.get(m[1].trim()) : undefined;
    if (!id) return jsonRes({ code: 401, msg: 'invalid JWT' }, 401);
    return jsonRes({ id, email: '', aud: 'authenticated', role: 'authenticated' });
  };
}
