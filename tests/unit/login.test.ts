// 微信 / QQ 登录的客户端流程：hash 处理、auth-start / auth-finish 的调用、桌面版轮询、错误代码翻译。
// 第二部分用真的 SupabaseRepo + 假的 fetch，确认请求发到 /functions/v1/auth-start、auth-finish、/auth/v1/verify，
// 带对了 apikey / 用户 JWT，verifyOtp 之后真的有了会话。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finishWebLogin,
  isWechatBrowser,
  LOGIN_STORAGE_KEY,
  LoginFailure,
  loginChoices,
  loginErrorText,
  parseLoginHash,
  pollDesktopLogin,
  readPendingWebLogin,
  safeReturnTo,
  startWebLogin,
  stripLoginHash,
  type KV,
  type LoginRepo,
} from '../../src/lib/login';
import { FnError } from '../../src/lib/functions';
import { SupabaseRepo } from '../../src/lib/repo';

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeRepo(finish: Array<Awaited<ReturnType<LoginRepo['authFinish']>> | Error>) {
  const calls = { start: [] as unknown[], finish: 0, verify: [] as Array<[string, string]> };
  const repo: LoginRepo = {
    authStart: async (req) => {
      calls.start.push(req);
      return { id: 'req-1', secret: 's3cr3t', url: 'https://open.weixin.qq.com/connect/qrconnect?appid=x&state=req-1#wechat_redirect' };
    },
    authFinish: async (id, secret) => {
      expect(id).toBe('req-1');
      expect(secret).toBe('s3cr3t');
      const r = finish[Math.min(calls.finish, finish.length - 1)];
      calls.finish++;
      if (r instanceof Error) throw r;
      return r;
    },
    verifyTokenHash: async (h, t) => {
      calls.verify.push([h, t]);
    },
  };
  return { repo, calls };
}

describe('hash', () => {
  it('认出登录成功 / 失败的 hash', () => {
    expect(parseLoginHash('#pling-login=abc-123')).toEqual({ kind: 'done', id: 'abc-123' });
    expect(parseLoginHash('pling-login=abc')).toEqual({ kind: 'done', id: 'abc' });
    expect(parseLoginHash('#pling-login-error=cancelled')).toEqual({ kind: 'error', code: 'cancelled' });
    expect(parseLoginHash('#pling-login-error=')).toEqual({ kind: 'error', code: 'unknown' });
    expect(parseLoginHash('#foo=1&pling-login=xyz')).toEqual({ kind: 'done', id: 'xyz' });
    expect(parseLoginHash('')).toBeNull();
    expect(parseLoginHash('#/alert')).toBeNull();
    expect(parseLoginHash('#pling-login=')).toBeNull();
  });
  it('清掉登录参数，别的留着', () => {
    expect(stripLoginHash('#pling-login=abc')).toBe('');
    expect(stripLoginHash('#pling-login-error=expired')).toBe('');
    expect(stripLoginHash('#a=1&pling-login=abc')).toBe('#a=1');
    expect(stripLoginHash('')).toBe('');
  });
  it('returnTo 只接受本站路径（和云函数 isSafeReturnTo 一样）', () => {
    expect(safeReturnTo('/?r=1')).toBe('/?r=1');
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/?r=demo-hw1&o=2026-09-30T14%3A00%3A00.000Z')).toBe('/?r=demo-hw1&o=2026-09-30T14%3A00%3A00.000Z');
    expect(safeReturnTo('//evil.com')).toBeUndefined();
    expect(safeReturnTo('/\\evil.com')).toBeUndefined();
    expect(safeReturnTo('https://evil.com')).toBeUndefined();
    expect(safeReturnTo('')).toBeUndefined();
    // 云函数会 400 的：带 #、空格、中文没编码、太长
    expect(safeReturnTo('/#x')).toBeUndefined();
    expect(safeReturnTo('/a b')).toBeUndefined();
    expect(safeReturnTo('/班级')).toBeUndefined();
    expect(safeReturnTo('/' + 'a'.repeat(1000))).toBeUndefined();
  });
});

describe('网页版', () => {
  it('auth-start 带 client: web，存好 id + secret，返回授权页地址', async () => {
    const kv = memoryKV();
    const { repo, calls } = fakeRepo([]);
    const url = await startWebLogin(repo, kv, 'wechat_open', { returnTo: '/?r=x', now: 1000 });
    expect(url).toMatch(/^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect/);
    expect(calls.start).toEqual([{ provider: 'wechat_open', client: 'web', returnTo: '/?r=x' }]);
    expect(readPendingWebLogin(kv)).toEqual({ id: 'req-1', secret: 's3cr3t', provider: 'wechat_open', link: false, at: 1000 });
  });
  it('加绑：auth-start 带 link: true', async () => {
    const kv = memoryKV();
    const { repo, calls } = fakeRepo([]);
    await startWebLogin(repo, kv, 'qq', { link: true });
    expect(calls.start).toEqual([{ provider: 'qq', client: 'web', returnTo: undefined, link: true }]);
    expect(readPendingWebLogin(kv)?.link).toBe(true);
  });
  it('回来：auth-finish → verifyOtp(token_hash, type)，用掉的请求清掉', async () => {
    const kv = memoryKV();
    const { repo, calls } = fakeRepo([{ status: 'done', token_hash: 'th-1', type: 'magiclink' }]);
    await startWebLogin(repo, kv, 'wechat_mp');
    const r = await finishWebLogin(repo, kv, { kind: 'done', id: 'req-1' });
    expect(r).toEqual({ link: false, provider: 'wechat_mp' });
    expect(calls.verify).toEqual([['th-1', 'magiclink']]);
    expect(kv.data.has(LOGIN_STORAGE_KEY)).toBe(false);
  });
  it('回调和这边几乎同时到：先 pending 再 done，再问一次就好', async () => {
    const kv = memoryKV();
    const { repo, calls } = fakeRepo([{ status: 'pending' }, { status: 'done', token_hash: 'th-2', type: 'magiclink' }]);
    await startWebLogin(repo, kv, 'qq');
    await finishWebLogin(repo, kv, { kind: 'done', id: 'req-1' }, { sleep: async () => undefined });
    expect(calls.finish).toBe(2);
    expect(calls.verify).toEqual([['th-2', 'magiclink']]);
  });
  it('加绑完成不换会话（服务器回 { status: done, linked: true }，没有令牌）', async () => {
    const kv = memoryKV();
    const { repo, calls } = fakeRepo([{ status: 'done', linked: true }]);
    await startWebLogin(repo, kv, 'qq', { link: true });
    const r = await finishWebLogin(repo, kv, { kind: 'done', id: 'req-1' });
    expect(r.link).toBe(true);
    expect(calls.verify).toEqual([]);
  });
  it('登录却没拿到令牌 → internal（不会假装登录成功）', async () => {
    const kv = memoryKV();
    const { repo } = fakeRepo([{ status: 'done', linked: true }]);
    await startWebLogin(repo, kv, 'qq');
    // 服务器说这是加绑：照样当加绑处理，不换会话
    await expect(finishWebLogin(repo, kv, { kind: 'done', id: 'req-1' })).resolves.toMatchObject({ link: true });
    const b = fakeRepo([{ status: 'done', token_hash: '', type: 'magiclink' }]);
    await startWebLogin(b.repo, kv, 'qq');
    await expect(finishWebLogin(b.repo, kv, { kind: 'done', id: 'req-1' })).rejects.toMatchObject({ code: 'internal' });
  });
  it('#pling-login-error=<代码> → LoginFailure(代码)，也清掉存着的请求', async () => {
    const kv = memoryKV();
    const { repo } = fakeRepo([]);
    await startWebLogin(repo, kv, 'qq');
    await expect(finishWebLogin(repo, kv, { kind: 'error', code: 'already_linked' })).rejects.toMatchObject({ code: 'already_linked' });
    expect(kv.data.has(LOGIN_STORAGE_KEY)).toBe(false);
  });
  it('id 对不上 / 没存过 → invalid_request', async () => {
    const kv = memoryKV();
    const { repo } = fakeRepo([]);
    await expect(finishWebLogin(repo, kv, { kind: 'done', id: 'other' })).rejects.toMatchObject({ code: 'invalid_request' });
    await startWebLogin(repo, kv, 'qq');
    await expect(finishWebLogin(repo, kv, { kind: 'done', id: 'other' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('auth-finish 回 error / 404', async () => {
    const kv = memoryKV();
    const a = fakeRepo([{ status: 'error', error: 'wechat_error' }]);
    await startWebLogin(a.repo, kv, 'wechat_open');
    await expect(finishWebLogin(a.repo, kv, { kind: 'done', id: 'req-1' })).rejects.toMatchObject({ code: 'wechat_error' });
    const b = fakeRepo([new FnError('not_found', 'not found', 404)]);
    await startWebLogin(b.repo, kv, 'wechat_open');
    await expect(finishWebLogin(b.repo, kv, { kind: 'done', id: 'req-1' })).rejects.toMatchObject({ code: 'expired' });
  });
});

describe('桌面版轮询', () => {
  it('每 2 秒问一次，done 就 verifyOtp', async () => {
    const { repo, calls } = fakeRepo([{ status: 'pending' }, { status: 'pending' }, { status: 'done', token_hash: 'th-d', type: 'magiclink' }]);
    const sleeps: number[] = [];
    await pollDesktopLogin(repo, 'req-1', 's3cr3t', { sleep: async (ms) => void sleeps.push(ms) });
    expect(calls.finish).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
    expect(calls.verify).toEqual([['th-d', 'magiclink']]);
  });
  it('最多 10 分钟', async () => {
    const { repo, calls } = fakeRepo([{ status: 'pending' }]);
    let now = 0;
    await expect(
      pollDesktopLogin(repo, 'req-1', 's3cr3t', {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(calls.finish).toBe(301); // 第 0、2、4 … 600 秒各问一次
  });
  it('断网接着等，回来了照样完成', async () => {
    const { repo, calls } = fakeRepo([new FnError('network', 'fetch failed'), { status: 'pending' }, { status: 'done', token_hash: 'th', type: 'magiclink' }]);
    await pollDesktopLogin(repo, 'req-1', 's3cr3t', { sleep: async () => undefined });
    expect(calls.finish).toBe(3);
    expect(calls.verify.length).toBe(1);
  });
  it('取消', async () => {
    const { repo } = fakeRepo([{ status: 'pending' }]);
    const ctl = new AbortController();
    const p = pollDesktopLogin(repo, 'req-1', 's3cr3t', { signal: ctl.signal, intervalMs: 50 });
    setTimeout(() => ctl.abort(), 120);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('服务器说失败 → 停', async () => {
    const { repo } = fakeRepo([{ status: 'pending' }, { status: 'error', error: 'already_linked' }]);
    await expect(pollDesktopLogin(repo, 'req-1', 's3cr3t', { sleep: async () => undefined })).rejects.toMatchObject({ code: 'already_linked' });
  });
  it('加绑模式不换会话', async () => {
    const { repo, calls } = fakeRepo([{ status: 'pending' }, { status: 'done', linked: true }]);
    await pollDesktopLogin(repo, 'req-1', 's3cr3t', { link: true, sleep: async () => undefined });
    expect(calls.verify).toEqual([]);
  });
});

describe('错误代码翻译', () => {
  it('认识的代码都有中文', () => {
    // 云函数 LOGIN_ERROR_CODES 的全部 + auth-start 自己的 400 / 401 / 500 + 前端的 network
    for (const c of ['invalid_request', 'expired', 'cancelled', 'provider_disabled', 'wechat_error', 'wechat_snapshot', 'qq_error', 'already_linked', 'internal', 'network', 'unauthorized', 'invalid_return_to', 'not_configured', 'not_found']) {
      const s = loginErrorText(c);
      expect(s).not.toContain('login.errors');
      expect(/[一-鿿]/.test(s)).toBe(true);
    }
    expect(loginErrorText('already_linked')).toContain('已经绑定');
    expect(loginErrorText('cancelled')).toContain('取消');
  });
  it('不认识的代码也给一句话，带上代码', () => {
    expect(loginErrorText('weird_code')).toContain('weird_code');
    expect(loginErrorText('')).toContain('unknown');
  });
});

describe('登录按钮', () => {
  const all = { wechat: true, wechatMp: true, qq: true };
  it('微信里打开：一键登录 + QQ', () => {
    const r = loginChoices(all, { desktop: false, wechat: true, mobile: true });
    expect(r.choices.map((c) => c.provider)).toEqual(['wechat_mp', 'qq']);
    expect(r.openInWechatHint).toBe(false);
  });
  it('电脑浏览器 / 桌面版：扫码登录 + QQ', () => {
    expect(loginChoices(all, { desktop: false, wechat: false, mobile: false }).choices.map((c) => c.provider)).toEqual(['wechat_open', 'qq']);
    expect(loginChoices(all, { desktop: true, wechat: false, mobile: false }).choices.map((c) => c.provider)).toEqual(['wechat_open', 'qq']);
  });
  it('手机普通浏览器：不显示微信，提示去微信里打开', () => {
    const r = loginChoices(all, { desktop: false, wechat: false, mobile: true });
    expect(r.choices.map((c) => c.provider)).toEqual(['qq']);
    expect(r.openInWechatHint).toBe(true);
  });
  it('没配的不显示', () => {
    expect(loginChoices({ wechat: false, wechatMp: false, qq: false }, { desktop: false, wechat: false, mobile: false }).choices).toEqual([]);
  });
  it('认出微信内置浏览器（企业微信不算）', () => {
    expect(isWechatBrowser('Mozilla/5.0 (iPhone) MicroMessenger/8.0.50')).toBe(true);
    expect(isWechatBrowser('Mozilla/5.0 MicroMessenger/3.1 wxwork/4.1')).toBe(false);
    expect(isWechatBrowser('Mozilla/5.0 Chrome/120')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 真的 SupabaseRepo + 假的 fetch
// ---------------------------------------------------------------------------

const BASE = 'https://pling.example.cn/api';
const ANON = 'anon-key-123';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fakeJwt(sub: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub, exp, role: 'authenticated', aud: 'authenticated' }))}.sig`;
}

describe('SupabaseRepo：真的请求长什么样', () => {
  let requests: Array<{ url: string; method: string; headers: Headers; body: unknown }>;
  let fetchMock: typeof fetch;
  const jwt = fakeJwt('11111111-2222-4333-8444-555555555555');

  beforeEach(() => {
    requests = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const raw = init?.body ?? null;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      requests.push({ url, method: init?.method ?? 'GET', headers, body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
      if (url === `${BASE}/functions/v1/auth-start`) return json({ id: 'req-9', secret: 'sec-9', url: 'https://graph.qq.com/oauth2.0/authorize?state=req-9' });
      if (url === `${BASE}/functions/v1/auth-finish`) {
        const b = body as { id: string };
        if (b.id === 'gone') return json({ error: 'not_found' }, 404);
        return json({ status: 'done', token_hash: 'hashed-xyz', type: 'magiclink' });
      }
      if (url.startsWith(`${BASE}/auth/v1/verify`)) {
        return json({
          access_token: jwt,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'rt-1',
          user: { id: '11111111-2222-4333-8444-555555555555', aud: 'authenticated', email: 'qq.abc@login.pling.invalid', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        });
      }
      if (url.startsWith(`${BASE}/rest/v1/rpc/redeem_invite`)) return json({ ok: true, team_id: 't1', was_active: false });
      return json({ message: `unexpected ${url}` }, 500);
    }) as unknown as typeof fetch;
  });

  it('整个网页版登录：auth-start → auth-finish → /auth/v1/verify → 有了会话 → rpc redeem_invite', async () => {
    const kv = memoryKV();
    const repo = new SupabaseRepo({ url: BASE, anonKey: ANON, fetch: fetchMock, storage: memoryKV() });
    const url = await startWebLogin(repo, kv, 'qq', { returnTo: '/?invite=ABC123' });
    expect(url).toContain('graph.qq.com');
    const start = requests.find((r) => r.url.endsWith('/functions/v1/auth-start'))!;
    expect(start.method).toBe('POST');
    expect(start.body).toEqual({ provider: 'qq', client: 'web', returnTo: '/?invite=ABC123' });
    expect(start.headers.get('apikey')).toBe(ANON);

    await finishWebLogin(repo, kv, { kind: 'done', id: 'req-9' });
    const finish = requests.find((r) => r.url.endsWith('/functions/v1/auth-finish'))!;
    expect(finish.body).toEqual({ id: 'req-9', secret: 'sec-9' });
    const verify = requests.find((r) => r.url.includes('/auth/v1/verify'))!;
    expect(verify.method).toBe('POST');
    expect(verify.body).toMatchObject({ token_hash: 'hashed-xyz', type: 'magiclink' });
    const session = await repo.getSession();
    expect(session?.userId).toBe('11111111-2222-4333-8444-555555555555');

    // 登录后用邀请码：带的是用户的 JWT
    const r = await repo.redeemInvite('ABC123');
    expect(r).toEqual({ ok: true, team_id: 't1', was_active: false });
    const rpc = requests.find((x) => x.url.includes('/rest/v1/rpc/redeem_invite'))!;
    expect(rpc.body).toEqual({ p_code: 'ABC123' });
    expect(rpc.headers.get('Authorization')).toBe(`Bearer ${jwt}`);
  });

  it('auth-finish 404 → FnError(not_found, 404) → 登录流程翻成 expired', async () => {
    const repo = new SupabaseRepo({ url: BASE, anonKey: ANON, fetch: fetchMock, storage: memoryKV() });
    await expect(repo.authFinish('gone', 'x')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(pollDesktopLogin(repo, 'gone', 'x', { sleep: async () => undefined })).rejects.toBeInstanceOf(LoginFailure);
    await expect(pollDesktopLogin(repo, 'gone', 'x', { sleep: async () => undefined })).rejects.toMatchObject({ code: 'expired' });
  });

  it('桌面版：auth-start 带 client: desktop，轮询拿到令牌后换会话', async () => {
    const repo = new SupabaseRepo({ url: BASE, anonKey: ANON, fetch: fetchMock, storage: memoryKV() });
    const res = await repo.authStart({ provider: 'wechat_open', client: 'desktop' });
    expect(requests[0].body).toEqual({ provider: 'wechat_open', client: 'desktop' });
    await pollDesktopLogin(repo, res.id, res.secret, { sleep: async () => undefined });
    expect((await repo.getSession())?.userId).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('加绑：登录状态下 auth-start 带 link: true 和用户 JWT', async () => {
    const repo = new SupabaseRepo({ url: BASE, anonKey: ANON, fetch: fetchMock, storage: memoryKV() });
    await repo.verifyTokenHash('hashed-xyz', 'magiclink');
    requests = [];
    await repo.authStart({ provider: 'qq', client: 'web', link: true });
    expect(requests[0].body).toEqual({ provider: 'qq', client: 'web', link: true });
    expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${jwt}`);
  });
});
