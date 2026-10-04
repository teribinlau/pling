// auth-finish：pending / done / error、只能取一次、secret 不对、不存在、过期；网页版和桌面版回调的不同回应。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { type Person, TEST } from './fakes.ts';
import {
  authorize,
  callCallback,
  callFinish,
  finish,
  FUNCTIONS_BASE,
  requestRow,
  runLogin,
  setEnv,
  setupAuthTests,
  start,
} from './harness.ts';
import finishHandler from '../../../supabase/functions/auth-finish/handler.ts';

const ctx = setupAuthTests();

const alice: Person = { key: 'alice', unionid: 'union-alice', nickname: '爱丽丝', avatar: 'https://thirdwx.qlogo.cn/mmopen/alice/132' };

Deno.test('auth-finish：回调之前 → pending；回调之后 → done + token_hash；再取 → 404', async () => {
  const s = await start({ provider: 'wechat_open', client: 'desktop' });
  deepStrictEqual(await finish(s), { status: 200, body: { status: 'pending' } });
  deepStrictEqual(await finish(s), { status: 200, body: { status: 'pending' } }, '轮询多少次都行');

  const q = await authorize(s.url, alice);
  const cb = await callCallback(q);
  strictEqual(cb.status, 200);
  await cb.body?.cancel();

  const f = await finish(s);
  strictEqual(f.status, 200);
  deepStrictEqual(Object.keys(f.body).sort(), ['status', 'token_hash', 'type']);
  strictEqual(f.body.status, 'done');
  strictEqual(f.body.type, 'magiclink');
  strictEqual(f.body.token_hash, ctx().gotrue.links[0].hashedToken);

  const again = await finish(s);
  strictEqual(again.status, 404);
  strictEqual(again.body.error, 'not_found');
});

Deno.test('auth-finish：同时取两次，只有一个拿到令牌', async () => {
  const { started, callback } = await runLogin('qq', alice);
  await callback.body?.cancel();
  const results = await Promise.all([finish(started), finish(started), finish(started)]);
  const done = results.filter((r) => r.body.status === 'done');
  strictEqual(done.length, 1);
  strictEqual(results.filter((r) => r.status === 404).length, 2);
});

Deno.test('auth-finish：secret 不对 → 404（和不存在一样，不透露请求在不在）', async () => {
  const { started, callback } = await runLogin('qq', alice);
  await callback.body?.cancel();
  for (const secret of ['wrong', started.secret.slice(0, -1) + (started.secret.endsWith('A') ? 'B' : 'A'), started.secret + 'x']) {
    const f = await finish({ id: started.id, secret });
    strictEqual(f.status, 404, secret);
    strictEqual(f.body.error, 'not_found');
  }
  // 猜错几次不影响真正的客户端
  strictEqual((await finish(started)).body.status, 'done');
});

Deno.test('auth-finish：secret 不对时 pending 的请求也是 404', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  strictEqual((await finish({ id: s.id, secret: 'nope' })).status, 404);
  strictEqual((await finish(s)).body.status, 'pending');
});

Deno.test('auth-finish：不存在的 id → 404', async () => {
  const f = await finish({ id: crypto.randomUUID(), secret: 'x'.repeat(43) });
  strictEqual(f.status, 404);
  strictEqual(f.body.error, 'not_found');
});

Deno.test('auth-finish：参数不对 → 400 invalid_request / bad_json', async () => {
  const cases: [unknown, string][] = [
    [{}, 'invalid_request'],
    [{ id: 'not-a-uuid', secret: 'x' }, 'invalid_request'],
    [{ id: crypto.randomUUID() }, 'invalid_request'],
    [{ id: crypto.randomUUID(), secret: '' }, 'invalid_request'],
    [{ id: crypto.randomUUID(), secret: 42 }, 'invalid_request'],
    [{ id: crypto.randomUUID(), secret: 'x'.repeat(300) }, 'invalid_request'],
    ['[1,2]', 'invalid_request'],
    ['{oops', 'bad_json'],
  ];
  for (const [body, code] of cases) {
    const res = await callFinish(body);
    strictEqual(res.status, 400, JSON.stringify(body));
    strictEqual((await res.json()).error, code, JSON.stringify(body));
  }
});

Deno.test('auth-finish：发起超过 10 分钟、还没回调 → 404', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  await ctx().sql`update public.login_requests set created_at = now() - interval '10 minutes 1 second' where id = ${s.id}`;
  strictEqual((await finish(s)).status, 404);
});

Deno.test('auth-finish：回调在 10 分钟内完成，客户端稍后（2 分钟内）再取 → 还能取到；超过 2 分钟 → 404', async () => {
  const a = await runLogin('qq', alice);
  await a.callback.body?.cancel();
  await ctx().sql`
    update public.login_requests set created_at = now() - interval '11 minutes', finished_at = now() - interval '90 seconds' where id = ${a.started.id}`;
  strictEqual((await finish(a.started)).body.status, 'done');

  const b = await runLogin('qq', alice);
  await b.callback.body?.cancel();
  await ctx().sql`
    update public.login_requests set created_at = now() - interval '13 minutes', finished_at = now() - interval '3 minutes' where id = ${b.started.id}`;
  strictEqual((await finish(b.started)).status, 404);
});

Deno.test('auth-finish：回调在第 9 分 59 秒开始处理、过了 10 分钟还没处理完 → 还是 pending（不是 404）', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  await ctx().sql`
    update public.login_requests set created_at = now() - interval '10 minutes 20 seconds', finished_at = now() - interval '21 seconds'
     where id = ${s.id}`;
  deepStrictEqual((await finish(s)).body, { status: 'pending' });
});

Deno.test('auth-finish：回调抢到请求后 2 分钟还没处理完（函数挂了）→ error internal，不让客户端一直等', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  await ctx().sql`update public.login_requests set finished_at = now() - interval '30 seconds' where id = ${s.id}`;
  deepStrictEqual((await finish(s)).body, { status: 'pending' }, '正在处理');
  await ctx().sql`update public.login_requests set finished_at = now() - interval '3 minutes' where id = ${s.id}`;
  deepStrictEqual((await finish(s)).body, { status: 'error', error: 'internal' });
  // 这时回调地址再被打开：也是失败页，不是「正在登录」
  const res = await callCallback(`code=x&state=${s.id}`);
  strictEqual(res.status, 400);
  match(await res.text(), /登录没有完成/);
});

Deno.test('auth-finish：失败的请求 → { status: error, error }，可以多次取', async () => {
  ctx().wechat.fail.access_token = { errcode: 40029, errmsg: 'invalid code' };
  const { started, callback } = await runLogin('wechat_open', alice);
  await callback.body?.cancel();
  deepStrictEqual((await finish(started)).body, { status: 'error', error: 'wechat_error' });
  deepStrictEqual((await finish(started)).body, { status: 'error', error: 'wechat_error' });
});

Deno.test('auth-finish：CORS 头 + 不缓存；只收 POST', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  const res = await callFinish({ id: s.id, secret: s.secret }, { origin: 'tauri://localhost' });
  strictEqual(res.headers.get('access-control-allow-origin'), 'tauri://localhost');
  strictEqual(res.headers.get('cache-control'), 'no-store');
  await res.body?.cancel();
  const nf = await callFinish({ id: crypto.randomUUID(), secret: 'x' }, { origin: TEST.publicUrl });
  strictEqual(nf.status, 404);
  strictEqual(nf.headers.get('access-control-allow-origin'), TEST.publicUrl);
  await nf.body?.cancel();

  const get = await finishHandler(new Request(`${FUNCTIONS_BASE}/auth-finish`, { method: 'GET' }));
  strictEqual(get.status, 405);
  await get.body?.cancel();
});

// ---------------------------------------------------------------------------
// 网页版和桌面版的回调回应
// ---------------------------------------------------------------------------

Deno.test('网页版：回调 302 到 {publicUrl}/#pling-login=<id>', async () => {
  const { started, callback } = await runLogin('wechat_mp', alice, { client: 'web' });
  strictEqual(callback.status, 302);
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}/#pling-login=${started.id}`);
  strictEqual(callback.headers.get('cache-control'), 'no-store');
  strictEqual(callback.headers.get('referrer-policy'), 'no-referrer');
  strictEqual((await finish(started)).body.status, 'done');
});

Deno.test('网页版：有 returnTo → 302 到 {publicUrl}{returnTo}#pling-login=<id>', async () => {
  const returnTo = '/?r=0b7c&o=2026-10-04T08:30:00.000Z';
  const { started, callback } = await runLogin('qq', alice, { client: 'web', returnTo });
  strictEqual(callback.status, 302);
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}${returnTo}#pling-login=${started.id}`);
});

Deno.test('网页版：失败 → 302 到 {publicUrl}{returnTo}#pling-login-error=<代码>', async () => {
  ctx().qq.fail.token = { error: 100019, error_description: 'code to access token error' };
  const { callback } = await runLogin('qq', alice, { client: 'web', returnTo: '/settings' });
  strictEqual(callback.status, 302);
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}/settings#pling-login-error=qq_error`);
});

Deno.test('网页版：加绑成功也是 #pling-login=<id>（客户端调 auth-finish 拿到 linked: true）', async () => {
  const [u] = await ctx().sql<{ id: string }[]>`insert into auth.users (email) values ('t@school.test') returning id`;
  const jwt = ctx().gotrue.jwtFor(u.id);
  const { started, callback } = await runLogin('qq', alice, { client: 'web', link: true, jwt, returnTo: '/settings' });
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}/settings#pling-login=${started.id}`);
  deepStrictEqual((await finish(started)).body, { status: 'done', linked: true });
});

Deno.test('桌面版：回调返回中文 HTML 页（成功），手机上也能看（viewport），不缓存、不带 Referer', async () => {
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  strictEqual(callback.status, 200);
  strictEqual(callback.headers.get('content-type'), 'text/html; charset=utf-8');
  strictEqual(callback.headers.get('cache-control'), 'no-store');
  strictEqual(callback.headers.get('referrer-policy'), 'no-referrer');
  match(callback.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const page = await callback.text();
  match(page, /^<!doctype html>/);
  match(page, /<html lang="zh-CN">/);
  match(page, /<meta name="viewport" content="width=device-width/);
  match(page, /<title>登录成功 · 叮一下<\/title>/);
  match(page, /登录成功，可以回到叮一下了，这个页面可以关掉/);
  match(page, /<style>/);
  ok(!page.includes(started.id), '页面上不需要请求 id');
  ok(!page.includes('<script'), '页面里没有脚本');
  ok(!page.includes(`href="${TEST.publicUrl}`), '桌面版不放网页版的链接');
});

Deno.test('桌面版：失败页按代码给中文说明', async () => {
  const cases: [string, () => void, Person | 'cancel', RegExp][] = [
    ['cancelled', () => {}, 'cancel', /已取消登录/],
    [
      'wechat_error',
      () => (ctx().wechat.fail.userinfo = { errcode: 40003, errmsg: 'invalid openid' }),
      alice,
      /微信返回了错误[\s\S]*40003 invalid openid/,
    ],
    ['wechat_snapshot', () => {}, { ...alice, snapshot: true }, /朋友圈的预览页/],
  ];
  for (const [code, arrange, who, re] of cases) {
    ctx().wechat.reset();
    arrange();
    const { started, callback } = await runLogin(code === 'wechat_snapshot' ? 'wechat_mp' : 'wechat_open', who, { client: 'desktop' });
    strictEqual(callback.status, 400, code);
    strictEqual(callback.headers.get('content-type'), 'text/html; charset=utf-8');
    match(await callback.text(), re, code);
    strictEqual((await finish(started)).body.error, code);
  }
});

Deno.test('结果页：昵称 / 错误信息里的 HTML 被转义', async () => {
  ctx().wechat.fail.access_token = { errcode: 40029, errmsg: '<img src=x onerror=alert(1)>' };
  const { callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  const page = await callback.text();
  ok(!page.includes('<img src=x'));
  match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

Deno.test('找不到请求（不知道是网页版还是桌面版）→ 中文页面，网页能打开叮一下', async () => {
  const res = await callCallback(`code=x&state=${crypto.randomUUID()}`);
  strictEqual(res.status, 400);
  const page = await res.text();
  match(page, /登录链接无效/);
  match(page, new RegExp(`href="${TEST.publicUrl}/"`));
});

Deno.test('网页版但没配 PLING_PUBLIC_URL（只配了 PLING_FUNCTIONS_URL）：回调退回显示页面', async () => {
  setEnv({ PLING_FUNCTIONS_URL: `${TEST.publicUrl}/api/functions/v1` });
  const s = await start({ provider: 'qq', client: 'web' });
  const q = await authorize(s.url, alice);
  setEnv({ PLING_PUBLIC_URL: undefined });
  const res = await callCallback(q);
  strictEqual(res.status, 200);
  match(await res.text(), /登录成功/);
  strictEqual((await requestRow(s.id))?.status, 'done');
});
