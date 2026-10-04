// auth-start：授权页地址、没配的登录方式、参数校验、加绑要登录、CORS。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { TEST } from './fakes.ts';
import { callStart, FUNCTIONS_BASE, requestRow, setEnv, setupAuthTests, start } from './harness.ts';
import startHandler from '../../../supabase/functions/auth-start/handler.ts';
import callbackHandler from '../../../supabase/functions/auth-callback/handler.ts';
import finishHandler from '../../../supabase/functions/auth-finish/handler.ts';

const ctx = setupAuthTests();
const CALLBACK = `${FUNCTIONS_BASE}/auth-callback`;

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test('auth-start wechat_open：扫码页地址（参数顺序、#wechat_redirect、state = 请求 id）', async () => {
  const s = await start({ provider: 'wechat_open', client: 'desktop' });
  match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const state = s.id.replace(/-/g, '');
  const base = Deno.env.get('WECHAT_OPEN_BASE');
  strictEqual(
    s.url,
    `${base}/connect/qrconnect?appid=${TEST.wechatOpen.appid}&redirect_uri=${encodeURIComponent(CALLBACK)}` +
      `&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`,
  );
});

Deno.test('auth-start wechat_mp：服务号网页授权地址（snsapi_userinfo）', async () => {
  const s = await start({ provider: 'wechat_mp', client: 'web' });
  const base = Deno.env.get('WECHAT_OPEN_BASE');
  strictEqual(
    s.url,
    `${base}/connect/oauth2/authorize?appid=${TEST.wechatMp.appid}&redirect_uri=${encodeURIComponent(CALLBACK)}` +
      `&response_type=code&scope=snsapi_userinfo&state=${s.id.replace(/-/g, '')}#wechat_redirect`,
  );
});

Deno.test('auth-start qq：QQ 互联授权地址', async () => {
  const s = await start({ provider: 'qq', client: 'web' });
  const u = new URL(s.url);
  strictEqual(`${u.origin}${u.pathname}`, `${Deno.env.get('QQ_API_BASE')}/oauth2.0/authorize`);
  deepStrictEqual([...u.searchParams.entries()], [
    ['response_type', 'code'],
    ['client_id', TEST.qq.appid],
    ['redirect_uri', CALLBACK],
    ['state', s.id.replace(/-/g, '')],
    ['scope', 'get_user_info'],
  ]);
  strictEqual(u.hash, '');
});

Deno.test('auth-start：PLING_FUNCTIONS_URL 优先于 <publicUrl>/api/functions/v1', async () => {
  setEnv({ PLING_FUNCTIONS_URL: 'https://fn.pling.test/functions/v1/' });
  const s = await start({ provider: 'qq', client: 'web' });
  strictEqual(new URL(s.url).searchParams.get('redirect_uri'), 'https://fn.pling.test/functions/v1/auth-callback');
});

Deno.test('auth-start：secret 是 32 字节 base64url，库里只存 sha256 十六进制；请求记下了 provider / client / returnTo', async () => {
  const s = await start({ provider: 'wechat_open', client: 'web', returnTo: '/?r=abc&o=2026-10-04T08:30:00.000Z' });
  match(s.secret, /^[A-Za-z0-9_-]{43}$/);
  const r = await requestRow(s.id);
  ok(r);
  strictEqual(r.secret_hash, await sha256Hex(s.secret));
  ok(!JSON.stringify(r).includes(s.secret), '库里不能有 secret 原文');
  strictEqual(r.provider, 'wechat_open');
  strictEqual(r.client, 'web');
  strictEqual(r.return_to, '/?r=abc&o=2026-10-04T08:30:00.000Z');
  strictEqual(r.status, 'pending');
  strictEqual(r.link_user_id, null);
  const s2 = await start({ provider: 'wechat_open', client: 'web' });
  ok(s2.secret !== s.secret && s2.id !== s.id);
});

Deno.test('auth-start：client 不填默认 web', async () => {
  const s = await start({ provider: 'qq' });
  strictEqual((await requestRow(s.id))?.client, 'web');
});

Deno.test('auth-start：没配的登录方式 → 400 provider_disabled（appid 或 secret 少一个都算）', async () => {
  const cases: [string, Record<string, undefined>][] = [
    ['wechat_open', { WECHAT_OPEN_APPID: undefined }],
    ['wechat_open', { WECHAT_OPEN_SECRET: undefined }],
    ['wechat_mp', { WECHAT_MP_APPID: undefined }],
    ['wechat_mp', { WECHAT_MP_SECRET: undefined }],
    ['qq', { QQ_APPID: undefined }],
    ['qq', { QQ_APPKEY: undefined }],
  ];
  for (const [provider, unset] of cases) {
    const saved = Object.fromEntries(Object.keys(unset).map((k) => [k, Deno.env.get(k)]));
    setEnv(unset);
    const res = await callStart({ provider, client: 'web' });
    strictEqual(res.status, 400, `${provider} ${Object.keys(unset)}`);
    strictEqual((await res.json()).error, 'provider_disabled');
    setEnv(saved);
  }
  const n = await ctx().sql`select count(*)::int as n from public.login_requests`;
  strictEqual(n[0].n, 0, '没配的时候不建请求');
  // 别的照样能用
  strictEqual((await callStart({ provider: 'qq', client: 'web' })).status, 200);
});

Deno.test('auth-start：参数校验', async () => {
  const cases: [unknown, number, string][] = [
    [{ provider: 'weibo', client: 'web' }, 400, 'invalid_provider'],
    [{ client: 'web' }, 400, 'invalid_provider'],
    [{ provider: 'qq', client: 'android' }, 400, 'invalid_client'],
    ['not json', 400, 'bad_json'],
    ['[]', 400, 'bad_json'],
    ['null', 400, 'bad_json'],
  ];
  for (const [body, status, code] of cases) {
    const res = await callStart(typeof body === 'string' ? body : (body as Record<string, unknown>));
    strictEqual(res.status, status, JSON.stringify(body));
    strictEqual((await res.json()).error, code, JSON.stringify(body));
  }
});

Deno.test('auth-start：returnTo 只接受本站路径', async () => {
  const good = ['/', '/settings', '/?r=1&o=2', '/a/b?c=%2F%2F', "/x(y)!*'~:@;=+$,"];
  for (const returnTo of good) {
    const res = await callStart({ provider: 'qq', client: 'web', returnTo });
    strictEqual(res.status, 200, returnTo);
    await res.body?.cancel();
  }
  const bad: unknown[] = [
    '//evil.example.com',
    '//evil.example.com/path',
    '/\\evil.example.com',
    '/\\/evil.example.com',
    'https://evil.example.com',
    'javascript:alert(1)',
    'settings',
    '/a#b',
    '/a b',
    '/a\nb',
    '/中文',
    `/${'a'.repeat(1000)}`,
    42,
    ['/'],
  ];
  for (const returnTo of bad) {
    const res = await callStart({ provider: 'qq', client: 'web', returnTo });
    strictEqual(res.status, 400, JSON.stringify(returnTo));
    strictEqual((await res.json()).error, 'invalid_return_to', JSON.stringify(returnTo));
  }
  // 不填 / 空串 / null = 回首页
  for (const returnTo of [undefined, '', null]) {
    const res = await callStart({ provider: 'qq', client: 'web', returnTo });
    strictEqual(res.status, 200, JSON.stringify(returnTo));
    strictEqual((await requestRow((await res.json()).id))?.return_to, '');
  }
});

Deno.test('auth-start：加绑（link: true）要带有效的用户 JWT', async () => {
  const noJwt = await callStart({ provider: 'qq', client: 'web', link: true });
  strictEqual(noJwt.status, 401);
  strictEqual((await noJwt.json()).error, 'unauthorized');

  const badJwt = await callStart({ provider: 'qq', client: 'web', link: true }, { jwt: 'eyJnot.a.valid.jwt' });
  strictEqual(badJwt.status, 401);
  await badJwt.body?.cancel();

  const [u] = await ctx().sql<{ id: string }[]>`insert into auth.users (email) values ('teacher@school.test') returning id`;
  const jwt = ctx().gotrue.jwtFor(u.id);
  const s = await start({ provider: 'qq', client: 'web', link: true }, { jwt });
  strictEqual((await requestRow(s.id))?.link_user_id, u.id);

  // 只带 JWT、没有 link: true = 普通登录（比如登录过期了重新登录）
  const plain = await start({ provider: 'qq', client: 'web' }, { jwt });
  strictEqual((await requestRow(plain.id))?.link_user_id, null);
});

Deno.test('auth-start：只收 POST', async () => {
  const res = await startHandler(new Request(`${FUNCTIONS_BASE}/auth-start`, { method: 'GET' }));
  strictEqual(res.status, 405);
  strictEqual((await res.json()).error, 'method_not_allowed');
});

Deno.test('auth-start：没配 PLING_PUBLIC_URL → 500 not_configured', async () => {
  setEnv({ PLING_PUBLIC_URL: undefined });
  const res = await callStart({ provider: 'qq', client: 'web' });
  strictEqual(res.status, 500);
  strictEqual((await res.json()).error, 'not_configured');
});

Deno.test('CORS：三个函数的 OPTIONS 预检 + 回应里带 Allow-Origin（只给允许的来源）', async () => {
  const handlers = { 'auth-start': startHandler, 'auth-callback': callbackHandler, 'auth-finish': finishHandler };
  for (const [name, h] of Object.entries(handlers)) {
    for (const origin of [TEST.publicUrl, 'tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420']) {
      const res = await h(
        new Request(`${FUNCTIONS_BASE}/${name}`, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type',
          },
        }),
      );
      strictEqual(res.status, 204, `${name} ${origin}`);
      strictEqual(res.headers.get('access-control-allow-origin'), origin, `${name} ${origin}`);
      match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
      match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
      match(res.headers.get('access-control-allow-headers') ?? '', /content-type/);
    }
    const evil = await h(new Request(`${FUNCTIONS_BASE}/${name}`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } }));
    strictEqual(evil.status, 204);
    strictEqual(evil.headers.get('access-control-allow-origin'), null, `${name} 不能给别的网站开 CORS`);
  }

  const res = await callStart({ provider: 'qq', client: 'web' }, { origin: 'tauri://localhost' });
  strictEqual(res.status, 200);
  strictEqual(res.headers.get('access-control-allow-origin'), 'tauri://localhost');
  strictEqual(res.headers.get('cache-control'), 'no-store');
  await res.body?.cancel();

  const err = await callStart({ provider: 'nope' }, { origin: TEST.publicUrl });
  strictEqual(err.status, 400);
  strictEqual(err.headers.get('access-control-allow-origin'), TEST.publicUrl, '出错的回应也要带 CORS 头，前端才读得到错误代码');
  await err.body?.cancel();
});
