// 回调的各种失败：用户取消、过期、微信 / QQ 返回错误、找不到请求、GoTrue 出错、回调地址被打开两次。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { type Person, TEST } from './fakes.ts';
import {
  authorize,
  callCallback,
  finish,
  FUNCTIONS_BASE,
  loginAs,
  requestRow,
  runLogin,
  setEnv,
  setupAuthTests,
  start,
} from './harness.ts';
import callbackHandler from '../../../supabase/functions/auth-callback/handler.ts';

const ctx = setupAuthTests();

const alice: Person = { key: 'alice', unionid: 'union-alice', nickname: '爱丽丝', avatar: 'https://thirdwx.qlogo.cn/mmopen/alice/132' };

async function errorOf(s: { id: string; secret: string }): Promise<unknown> {
  const f = await finish(s);
  strictEqual(f.status, 200);
  strictEqual(f.body.status, 'error');
  return f.body.error;
}

async function userCount(): Promise<number> {
  return (await ctx().sql<{ n: number }[]>`select count(*)::int as n from auth.users`)[0].n;
}

Deno.test('用户在微信里点了取消（回调没有 code）→ cancelled', async () => {
  const { started, callback } = await runLogin('wechat_open', 'cancel', { client: 'desktop' });
  strictEqual(callback.status, 400);
  const page = await callback.text();
  match(page, /已取消登录/);
  match(page, /你在微信里取消了授权/);
  strictEqual(await errorOf(started), 'cancelled');
  strictEqual(ctx().wechat.calls.length, 0, '没有 code 就不调微信接口');
  strictEqual(await userCount(), 0);
});

Deno.test('用户在 QQ 里点了取消 → cancelled（网页版跳回 #pling-login-error=cancelled）', async () => {
  const { started, callback } = await runLogin('qq', 'cancel', { client: 'web', returnTo: '/settings' });
  strictEqual(callback.status, 302);
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}/settings#pling-login-error=cancelled`);
  strictEqual(await errorOf(started), 'cancelled');
});

Deno.test('回调带 error=access_denied → cancelled；带别的 error → 微信 / QQ 返回错误', async () => {
  const a = await start({ provider: 'qq', client: 'desktop' });
  const ra = await callCallback(new URLSearchParams({ state: a.id.replace(/-/g, ''), error: 'access_denied' }));
  await ra.body?.cancel();
  strictEqual(await errorOf(a), 'cancelled');

  const b = await start({ provider: 'qq', client: 'desktop' });
  const rb = await callCallback(
    new URLSearchParams({ state: b.id.replace(/-/g, ''), error: '100010', error_description: 'redirect uri is illegal' }),
  );
  strictEqual(rb.status, 400);
  const page = await rb.text();
  match(page, /QQ 返回了错误/);
  match(page, /100010 redirect uri is illegal/);
  strictEqual(await errorOf(b), 'qq_error');
});

Deno.test('发起登录超过 10 分钟才回调 → expired（不调微信接口、不建用户）', async () => {
  const s = await start({ provider: 'wechat_open', client: 'desktop' });
  const q = await authorize(s.url, alice);
  await ctx().sql`update public.login_requests set created_at = now() - interval '11 minutes' where id = ${s.id}`;
  const res = await callCallback(q);
  strictEqual(res.status, 400);
  match(await res.text(), /登录已过期/);
  strictEqual(ctx().wechat.calls.length, 0);
  strictEqual(await userCount(), 0);
  strictEqual((await requestRow(s.id))?.status, 'error');
  strictEqual((await requestRow(s.id))?.error, 'expired');
  // 回调刚处理完的 2 分钟里，auth-finish 能拿到这个错误代码；再往后就是 404
  strictEqual(await errorOf(s), 'expired');
  await ctx().sql`update public.login_requests set finished_at = now() - interval '3 minutes' where id = ${s.id}`;
  strictEqual((await finish(s)).status, 404);
});

Deno.test('过期：网页版跳回 #pling-login-error=expired', async () => {
  const s = await start({ provider: 'qq', client: 'web' });
  const q = await authorize(s.url, alice);
  await ctx().sql`update public.login_requests set created_at = now() - interval '10 minutes 1 second' where id = ${s.id}`;
  const res = await callCallback(q);
  strictEqual(res.status, 302);
  strictEqual(res.headers.get('location'), `${TEST.publicUrl}/#pling-login-error=expired`);
});

Deno.test('第 9 分 59 秒回调：照常登录', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  const q = await authorize(s.url, alice);
  await ctx().sql`update public.login_requests set created_at = now() - interval '9 minutes 59 seconds' where id = ${s.id}`;
  const res = await callCallback(q);
  strictEqual(res.status, 200);
  await res.body?.cancel();
  strictEqual((await finish(s)).body.status, 'done', '回调刚完成，过了 10 分钟也还能取（有 2 分钟宽限）');
});

Deno.test('微信 access_token 接口报错（HTTP 200 + errcode）→ wechat_error，页面上有错误码、没有 AppSecret', async () => {
  ctx().wechat.fail.access_token = { errcode: 40029, errmsg: 'invalid code, rid: 6512ab' };
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  strictEqual(callback.status, 400);
  const page = await callback.text();
  match(page, /微信返回了错误/);
  match(page, /access_token: 40029 invalid code/);
  ok(!page.includes(TEST.wechatOpen.secret));
  strictEqual(await errorOf(started), 'wechat_error');
  strictEqual(await userCount(), 0);
});

Deno.test('微信 userinfo 接口报错 → wechat_error（网页版 #pling-login-error=wechat_error）', async () => {
  ctx().wechat.fail.userinfo = { errcode: 40001, errmsg: 'invalid credential' };
  const { started, callback } = await runLogin('wechat_mp', alice, { client: 'web' });
  strictEqual(callback.status, 302);
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}/#pling-login-error=wechat_error`);
  strictEqual(await errorOf(started), 'wechat_error');
  strictEqual((await ctx().sql`select count(*)::int as n from public.wechat_bindings`)[0].n, 0);
});

Deno.test('微信接口返回的不是 JSON（网关错误页）/ HTTP 500 → wechat_error', async () => {
  ctx().wechat.fail.access_token = { status: 502, raw: '<html>502 Bad Gateway</html>' };
  const a = await runLogin('wechat_open', alice);
  await a.callback.body?.cancel();
  strictEqual(await errorOf(a.started), 'wechat_error');

  ctx().wechat.fail.access_token = undefined;
  ctx().wechat.fail.userinfo = { status: 500, errmsg: 'oops' };
  const b = await runLogin('wechat_open', alice);
  match(await b.callback.text(), /userinfo: HTTP 500/);
  strictEqual(await errorOf(b.started), 'wechat_error');
});

Deno.test('微信接口连不上 → wechat_error，日志里没有 AppSecret', async () => {
  const s = await start({ provider: 'wechat_open', client: 'desktop' });
  const q = await authorize(s.url, alice);
  // 一个没人监听的端口
  const l = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  setEnv({ WECHAT_API_BASE: `http://127.0.0.1:${port}` });
  const res = await callCallback(q);
  strictEqual(res.status, 400);
  const page = await res.text();
  match(page, /微信返回了错误/);
  ok(!page.includes(TEST.wechatOpen.secret));
  strictEqual(await errorOf(s), 'wechat_error');
  ok(ctx().logs.some((l) => l.includes('wechat_error')), '失败要写日志');
});

Deno.test('朋友圈快照页里的服务号授权（is_snapshotuser = 1）→ wechat_snapshot，不建账号', async () => {
  const { started, callback } = await runLogin('wechat_mp', { ...alice, snapshot: true }, { client: 'desktop' });
  strictEqual(callback.status, 400);
  match(await callback.text(), /使用完整服务/);
  strictEqual(await errorOf(started), 'wechat_snapshot');
  strictEqual(await userCount(), 0);
});

Deno.test('QQ token 接口报错（{ error, error_description }）→ qq_error', async () => {
  ctx().qq.fail.token = { error: 100019, error_description: 'code to access token error' };
  const { started, callback } = await runLogin('qq', alice, { client: 'desktop' });
  strictEqual(callback.status, 400);
  const page = await callback.text();
  match(page, /QQ 返回了错误/);
  match(page, /token: 100019 code to access token error/);
  ok(!page.includes(TEST.qq.appkey));
  strictEqual(await errorOf(started), 'qq_error');
});

Deno.test('QQ me 接口报错 → qq_error', async () => {
  ctx().qq.fail.me = { error: 100016, error_description: 'access token check failed' };
  const { started, callback } = await runLogin('qq', alice);
  await callback.body?.cancel();
  strictEqual(await errorOf(started), 'qq_error');
});

Deno.test('QQ get_user_info 报错（{ ret != 0, msg }）→ qq_error', async () => {
  ctx().qq.fail.get_user_info = { ret: 1002, msg: '请先登录' };
  const { started, callback } = await runLogin('qq', alice, { client: 'web' });
  strictEqual(callback.status, 302);
  strictEqual(callback.headers.get('location'), `${TEST.publicUrl}/#pling-login-error=qq_error`);
  strictEqual(await errorOf(started), 'qq_error');
  strictEqual(await userCount(), 0);
});

Deno.test('QQ 用 JSONP 格式（callback( {...} );）回 token / me：照样能登录', async () => {
  ctx().qq.jsonp = true;
  const userId = await loginAs('qq', { key: 'carol', qqUnionid: 'qq-u', nickname: '卡罗尔' });
  ok(userId);
  const [i] = await ctx().sql`select unionid from public.login_identities where user_id = ${userId}`;
  strictEqual(i.unionid, 'qq-u');
});

Deno.test('QQ 用 JSONP 格式回错误 → qq_error', async () => {
  ctx().qq.jsonp = true;
  ctx().qq.fail.token = { raw: 'callback( {"error":100010,"error_description":"redirect uri is illegal"} );' };
  const { started, callback } = await runLogin('qq', alice);
  match(await callback.text(), /100010 redirect uri is illegal/);
  strictEqual(await errorOf(started), 'qq_error');
});

Deno.test('state 缺失 / 不是 uuid / 找不到这个请求 → invalid_request（中文页面，状态 400）', async () => {
  for (const q of ['code=abc', 'code=abc&state=', 'code=abc&state=xyz', `code=abc&state=${crypto.randomUUID()}`]) {
    const res = await callCallback(q);
    strictEqual(res.status, 400, q);
    strictEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
    match(await res.text(), /登录链接无效/, q);
  }
  strictEqual(ctx().wechat.calls.length + ctx().qq.calls.length, 0);
});

Deno.test('state 用带连字符的 uuid 也认', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  const q = await authorize(s.url, alice);
  q.set('state', s.id.toUpperCase());
  const res = await callCallback(q);
  strictEqual(res.status, 200);
  await res.body?.cancel();
  strictEqual((await finish(s)).body.status, 'done');
});

Deno.test('发起之后管理员关掉了这种登录方式 → provider_disabled', async () => {
  const s = await start({ provider: 'qq', client: 'desktop' });
  const q = await authorize(s.url, alice);
  setEnv({ QQ_APPKEY: undefined });
  const res = await callCallback(q);
  strictEqual(res.status, 400);
  match(await res.text(), /QQ登录没有开通/);
  strictEqual(await errorOf(s), 'provider_disabled');
});

Deno.test('GoTrue 建用户失败 → internal，页面上没有内部错误详情', async () => {
  ctx().gotrue.failCreate = true;
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  strictEqual(callback.status, 400);
  const page = await callback.text();
  match(page, /登录没有完成/);
  ok(!page.includes('Database error'), '内部错误不写到页面上');
  strictEqual(await errorOf(started), 'internal');
  strictEqual((await ctx().sql`select count(*)::int as n from public.login_identities`)[0].n, 0);
});

Deno.test('GoTrue 生成令牌失败 → internal；新建的账号留着（身份已经记下了），下次登录还是它', async () => {
  ctx().gotrue.failGenerateLink = true;
  const a = await runLogin('wechat_open', alice, { client: 'web' });
  strictEqual(a.callback.status, 302);
  strictEqual(a.callback.headers.get('location'), `${TEST.publicUrl}/#pling-login-error=internal`);
  strictEqual(await errorOf(a.started), 'internal');
  strictEqual(ctx().gotrue.created.length, 1);
  const first = ctx().gotrue.created[0];

  ctx().gotrue.failGenerateLink = false;
  strictEqual(await loginAs('wechat_open', alice), first);
  strictEqual(ctx().gotrue.created.length, 1);
});

Deno.test('身份被别的连接抢先写进去（主键兜底）→ 以先写进去的为准，删掉多建的 GoTrue 用户', async () => {
  // GoTrue 建好用户的同时，另一个连接（不拿 advisory lock）把这个身份写给了另一个账号
  const { sql, gotrue } = ctx();
  const [other] = await sql<{ id: string }[]>`insert into auth.users (email) values ('other@school.test') returning id`;
  gotrue.onCreate = async () => {
    await sql`
      insert into public.login_identities (provider, subject, user_id)
      values ('wechat_open', ${'o-' + TEST.wechatOpen.appid + '-alice'}, ${other.id})`;
  };
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  strictEqual(callback.status, 200);
  await callback.body?.cancel();
  strictEqual(gotrue.created.length, 1);
  deepStrictEqual(gotrue.deleted, gotrue.created, '多建的用户被删掉了');
  const f = await finish(started);
  strictEqual(f.body.status, 'done');
  strictEqual(gotrue.links.at(-1)?.userId, other.id, '登录到先写进去的那个账号');
});

Deno.test('回调地址被打开第二次（code 已经用过）：按第一次的结果回应，不再调微信', async () => {
  const s = await start({ provider: 'wechat_open', client: 'desktop' });
  const q = await authorize(s.url, alice);
  const first = await callCallback(q);
  strictEqual(first.status, 200);
  await first.body?.cancel();
  const calls = ctx().wechat.calls.length;

  const second = await callCallback(q);
  strictEqual(second.status, 200);
  match(await second.text(), /登录成功/);
  strictEqual(ctx().wechat.calls.length, calls);

  // 取走之后再打开：还是「登录成功」
  strictEqual((await finish(s)).body.status, 'done');
  const third = await callCallback(q);
  strictEqual(third.status, 200);
  await third.body?.cancel();

  // 失败的那种：第二次打开也显示同样的错误
  ctx().wechat.fail.access_token = { errcode: 40163, errmsg: 'code been used' };
  const s2 = await start({ provider: 'wechat_open', client: 'web' });
  const q2 = await authorize(s2.url, alice);
  const r1 = await callCallback(q2);
  const r2 = await callCallback(q2);
  strictEqual(r1.headers.get('location'), `${TEST.publicUrl}/#pling-login-error=wechat_error`);
  strictEqual(r2.headers.get('location'), `${TEST.publicUrl}/#pling-login-error=wechat_error`);
});

Deno.test('两个回调同时到（同一个 code）：只有一个去换身份，另一个显示「正在登录」', async () => {
  ctx().gotrue.createDelayMs = 150;
  const s = await start({ provider: 'wechat_open', client: 'desktop' });
  const q = await authorize(s.url, alice);
  const [a, b] = await Promise.all([callCallback(q), callCallback(q)]);
  const pages = [await a.text(), await b.text()];
  strictEqual(ctx().wechat.calls.filter((c) => c === '/sns/oauth2/access_token').length, 1);
  ok(pages.some((p) => p.includes('登录成功')));
  ok(pages.some((p) => p.includes('正在登录')));
  strictEqual((await finish(s)).body.status, 'done');
});

Deno.test('正在处理时又来了一个不带 code 的回调：不会把请求改成失败', async () => {
  ctx().gotrue.createDelayMs = 150;
  const s = await start({ provider: 'wechat_open', client: 'web' });
  const q = await authorize(s.url, alice);
  const noCode = new URLSearchParams({ state: q.get('state')! });
  const pending = callCallback(q);
  await new Promise((r) => setTimeout(r, 50));
  const cancelled = await callCallback(noCode);
  strictEqual(cancelled.status, 302);
  strictEqual(cancelled.headers.get('location'), `${TEST.publicUrl}/#pling-login=${s.id}`, '按正在处理的那个回调的结果走');
  const ok1 = await pending;
  strictEqual(ok1.headers.get('location'), `${TEST.publicUrl}/#pling-login=${s.id}`);
  strictEqual((await finish(s)).body.status, 'done');
});

Deno.test('auth-callback 只收 GET', async () => {
  const res = await callbackHandler(new Request(`${FUNCTIONS_BASE}/auth-callback?state=x`, { method: 'POST' }));
  strictEqual(res.status, 405);
  await res.body?.cancel();
});

Deno.test('建好用户之后事务失败（写 login_identities 出错）→ 删掉刚建的 GoTrue 用户，回 internal', async () => {
  const { sql, gotrue } = ctx();
  // GoTrue 建好用户后把它从 auth.users 里删掉（模拟 GoTrue 和数据库之间出了岔子）：写 login_identities 时外键报错，事务回滚
  gotrue.onCreate = async (id) => {
    await sql`delete from auth.users where id = ${id}`;
  };
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  strictEqual(callback.status, 400);
  match(await callback.text(), /登录没有完成/);
  strictEqual(await errorOf(started), 'internal');
  strictEqual(gotrue.created.length, 1);
  strictEqual((await sql`select count(*)::int as n from public.login_identities`)[0].n, 0);
  deepStrictEqual(gotrue.deleteAttempts, gotrue.created, '回滚后调 GoTrue 删掉刚建的用户');
  ok(ctx().logs.some((l) => l.includes('删除多建的用户')), '（这里用户已经不在了，删除失败只记日志，不影响回应）');

  // 之后再登录一切正常
  gotrue.onCreate = null;
  ok(await loginAs('wechat_open', alice));
  strictEqual(await userCount(), 1);
});

Deno.test('微信 / QQ 的错误信息里带了密钥（比如中间的代理把请求地址原样写进了错误）→ 页面和日志里打码', async () => {
  ctx().wechat.fail.access_token = {
    errcode: 40125,
    errmsg: `invalid appsecret: GET /sns/oauth2/access_token?secret=${TEST.wechatOpen.secret}&code=abc`,
  };
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  const page = await callback.text();
  ok(!page.includes(TEST.wechatOpen.secret));
  match(page, /secret=\*\*\*/);
  strictEqual(await errorOf(started), 'wechat_error');
});
