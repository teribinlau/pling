// 完整的登录流程：auth-start → 假授权页 → auth-callback → auth-finish。
// 新用户建账号、老用户再登录、unionid 打通、服务号绑定、加绑。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { openidOf, type Person, TEST } from './fakes.ts';
import {
  authorize,
  callCallback,
  createEmailUser,
  finish,
  loginAs,
  profile,
  requestRow,
  runLogin,
  setupAuthTests,
  start,
} from './harness.ts';

const ctx = setupAuthTests();

const alice: Person = { key: 'alice', unionid: 'union-alice', nickname: '爱丽丝🌸', avatar: 'https://thirdwx.qlogo.cn/mmopen/alice/132' };
const bob: Person = { key: 'bob', unionid: 'union-bob', nickname: '鲍勃', avatar: 'https://thirdwx.qlogo.cn/mmopen/bob/132' };
const carol: Person = {
  key: 'carol',
  qqUnionid: 'qq-union-carol',
  nickname: '卡罗尔',
  avatar: 'http://thirdqq.qlogo.cn/g?b=oidb&k=carol&s=100',
};

async function identities(userId: string) {
  const rows = await ctx().sql<{ provider: string; subject: string; unionid: string; nickname: string; avatar_url: string }[]>`
    select provider, subject, unionid, nickname, avatar_url from public.login_identities where user_id = ${userId} order by provider`;
  return rows.map((r) => ({ ...r }));
}

async function userCount(): Promise<number> {
  return (await ctx().sql<{ n: number }[]>`select count(*)::int as n from auth.users`)[0].n;
}

Deno.test('新用户（微信扫码）：建 GoTrue 用户 + profile（名字 = 昵称、email 空、name_confirmed false、第一个用户是管理员并激活）', async () => {
  const { started, callback } = await runLogin('wechat_open', alice, { client: 'desktop' });
  strictEqual(callback.status, 200);
  const page = await callback.text();
  match(page, /登录成功，可以回到叮一下了，这个页面可以关掉/);

  const { gotrue } = ctx();
  strictEqual(gotrue.created.length, 1);
  const userId = gotrue.created[0];

  const [u] = await ctx().sql<{ email: string; raw_user_meta_data: Record<string, unknown> }[]>`
    select email, raw_user_meta_data from auth.users where id = ${userId}`;
  match(u.email, /^u\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@login\.pling\.invalid$/);
  ok(!u.email.includes(openidOf(alice, TEST.wechatOpen.appid).toLowerCase()), '邮箱里不带 openid');
  deepStrictEqual(u.raw_user_meta_data, { name: '爱丽丝🌸', avatar_url: alice.avatar, login_provider: 'wechat_open' });

  const p = await profile(userId);
  ok(p, 'handle_new_user 建了 profile');
  strictEqual(p.name, '爱丽丝🌸');
  strictEqual(p.email, '');
  strictEqual(p.name_confirmed, false);
  strictEqual(p.role, 'admin');
  strictEqual(p.active, true);
  strictEqual(p.avatar_url, alice.avatar);

  deepStrictEqual(await identities(userId), [{
    provider: 'wechat_open',
    subject: openidOf(alice, TEST.wechatOpen.appid),
    unionid: 'union-alice',
    nickname: '爱丽丝🌸',
    avatar_url: alice.avatar,
  }]);

  const f = await finish(started);
  strictEqual(f.status, 200);
  strictEqual(f.body.status, 'done');
  strictEqual(f.body.type, 'magiclink');
  strictEqual(gotrue.links.length, 1);
  strictEqual(f.body.token_hash, gotrue.links[0].hashedToken);
  strictEqual(gotrue.links[0].userId, userId);
  strictEqual(gotrue.links[0].email, u.email);

  const r = await requestRow(started.id);
  strictEqual(r?.status, 'used');
  strictEqual(r?.user_id, userId);
  strictEqual(r?.token_hash, null, '取走之后库里不留令牌');
});

Deno.test('第二个新用户：普通成员、待激活', async () => {
  const first = await loginAs('wechat_open', alice);
  const second = await loginAs('qq', carol);
  ok(first !== second);
  const p = await profile(second);
  strictEqual(p?.role, 'member');
  strictEqual(p?.active, false);
  strictEqual(p?.name, '卡罗尔');
  strictEqual(p?.email, '');
  strictEqual(p?.name_confirmed, false);
  // QQ 头像的 http 地址换成 https
  strictEqual(p?.avatar_url, 'https://thirdqq.qlogo.cn/g?b=oidb&k=carol&s=100');
  const [u] = await ctx().sql`select raw_user_meta_data from auth.users where id = ${second}`;
  strictEqual(u.raw_user_meta_data.login_provider, 'qq');
});

Deno.test('没有昵称的新用户：profile 名字是「新成员」', async () => {
  const userId = await loginAs('wechat_open', { key: 'anon' });
  strictEqual((await profile(userId))?.name, '新成员');
  strictEqual((await profile(userId))?.avatar_url, '');
});

Deno.test('老用户再登录：同一个账号，不再建用户；昵称 / 头像跟着更新，改过的名字不动', async () => {
  const userId = await loginAs('wechat_open', alice);
  await ctx().sql`update public.profiles set name = '王老师', name_confirmed = true where id = ${userId}`;

  const changed = { ...alice, nickname: '爱丽丝（新）', avatar: 'https://thirdwx.qlogo.cn/mmopen/alice-new/132' };
  const again = await loginAs('wechat_open', changed);
  strictEqual(again, userId);
  strictEqual(ctx().gotrue.created.length, 1, '没有再建用户');
  strictEqual(await userCount(), 1);

  const p = await profile(userId);
  strictEqual(p?.name, '王老师', '用户自己填的名字不被昵称覆盖');
  strictEqual(p?.name_confirmed, true);
  strictEqual(p?.avatar_url, changed.avatar, '头像跟着微信更新');
  const [ident] = await identities(userId);
  strictEqual(ident.nickname, '爱丽丝（新）');
  strictEqual(ident.avatar_url, changed.avatar);

  // 用户自己换了头像（不是微信给的那个），再登录不覆盖
  await ctx().sql`update public.profiles set avatar_url = 'https://pling.test/storage/me.png' where id = ${userId}`;
  await loginAs('wechat_open', { ...alice, avatar: 'https://thirdwx.qlogo.cn/mmopen/alice-3/132' });
  strictEqual((await profile(userId))?.avatar_url, 'https://pling.test/storage/me.png');
});

Deno.test('老用户再登录：第一次登录取走的令牌和第二次的不一样（每次都重新生成）', async () => {
  const a = await runLogin('qq', carol);
  await a.callback.body?.cancel();
  const b = await runLogin('qq', carol);
  await b.callback.body?.cancel();
  const fa = await finish(a.started);
  const fb = await finish(b.started);
  strictEqual(fa.body.status, 'done');
  strictEqual(fb.body.status, 'done');
  ok(fa.body.token_hash !== fb.body.token_hash);
  strictEqual(ctx().gotrue.created.length, 1);
});

Deno.test('网站应用和服务号按 unionid 认成同一个人', async () => {
  const viaOpen = await loginAs('wechat_open', alice);
  const viaMp = await loginAs('wechat_mp', alice);
  strictEqual(viaMp, viaOpen);
  strictEqual(ctx().gotrue.created.length, 1);
  const ids = await identities(viaOpen);
  deepStrictEqual(ids.map((i) => [i.provider, i.subject, i.unionid]), [
    ['wechat_mp', openidOf(alice, TEST.wechatMp.appid), 'union-alice'],
    ['wechat_open', openidOf(alice, TEST.wechatOpen.appid), 'union-alice'],
  ]);

  // 反过来：先服务号、后网站应用
  const bobMp = await loginAs('wechat_mp', bob);
  const bobOpen = await loginAs('wechat_open', bob);
  strictEqual(bobOpen, bobMp);
  ok(bobMp !== viaOpen);
  strictEqual(ctx().gotrue.created.length, 2);
});

Deno.test('没有 unionid（服务号没挂到开放平台）：网站应用和服务号是两个账号', async () => {
  const dave: Person = { key: 'dave', nickname: '戴夫' };
  const a = await loginAs('wechat_open', dave);
  const b = await loginAs('wechat_mp', dave);
  ok(a !== b);
  strictEqual(ctx().gotrue.created.length, 2);
});

Deno.test('QQ 和微信的 unionid 不互认', async () => {
  const same = 'same-union-value';
  const w = await loginAs('wechat_open', { key: 'erin', unionid: same, nickname: 'Erin' });
  const q = await loginAs('qq', { key: 'erin', qqUnionid: same, nickname: 'Erin' });
  ok(w !== q);
});

Deno.test('服务号登录写 wechat_bindings（user_id、openid、unionid、nickname、subscribed = true）', async () => {
  const userId = await loginAs('wechat_mp', alice, { client: 'web' });
  const rows = await ctx().sql`select user_id, openid, unionid, nickname, subscribed from public.wechat_bindings`;
  deepStrictEqual(rows.map((r) => ({ ...r })), [{
    user_id: userId,
    openid: openidOf(alice, TEST.wechatMp.appid),
    unionid: 'union-alice',
    nickname: '爱丽丝🌸',
    subscribed: true,
  }]);
  // 没有调服务号的 access_token / 用户信息接口
  deepStrictEqual(ctx().wechat.calls, ['/sns/oauth2/access_token', '/sns/userinfo']);

  // 取消关注后（推送那边改成 false），再用服务号登录：重新写成 true，绑定时间不变
  const [before] = await ctx().sql`update public.wechat_bindings set subscribed = false where user_id = ${userId} returning bound_at`;
  await loginAs('wechat_mp', alice);
  const [after] = await ctx().sql`select subscribed, bound_at from public.wechat_bindings where user_id = ${userId}`;
  strictEqual(after.subscribed, true);
  deepStrictEqual(after.bound_at, before.bound_at);
});

Deno.test('网站应用 / QQ 登录不写 wechat_bindings', async () => {
  await loginAs('wechat_open', alice);
  await loginAs('qq', carol);
  strictEqual((await ctx().sql`select count(*)::int as n from public.wechat_bindings`)[0].n, 0);
});

Deno.test('服务号 openid 绑在别的账号上 → 挪到这次登录的账号', async () => {
  const owner = await loginAs('wechat_open', bob);
  const newcomer = await loginAs('wechat_open', alice);
  const mpOpenid = openidOf(alice, TEST.wechatMp.appid);
  // 比如 alice 曾经在 bob 的账号里扫码绑定过服务号
  await ctx().sql`insert into public.wechat_bindings (user_id, openid, nickname) values (${owner}, ${mpOpenid}, '旧绑定')`;

  const userId = await loginAs('wechat_mp', alice);
  strictEqual(userId, newcomer);
  const rows = await ctx().sql`select user_id, openid from public.wechat_bindings order by user_id`;
  deepStrictEqual(rows.map((r) => ({ ...r })), [{ user_id: newcomer, openid: mpOpenid }]);
});

Deno.test('服务号登录：这个账号原来绑的是另一个 openid → 换成这次的', async () => {
  const userId = await loginAs('wechat_open', alice);
  await ctx().sql`insert into public.wechat_bindings (user_id, openid, nickname) values (${userId}, 'o-old-openid', '旧')`;
  await loginAs('wechat_mp', alice);
  const [b] = await ctx().sql`select openid, nickname from public.wechat_bindings where user_id = ${userId}`;
  strictEqual(b.openid, openidOf(alice, TEST.wechatMp.appid));
  strictEqual(b.nickname, '爱丽丝🌸');
});

Deno.test('加绑：已登录的邮箱账号绑上 QQ，auth-finish 返回 { status: done, linked: true }、不发令牌；以后用 QQ 登录就是这个账号', async () => {
  const userId = await createEmailUser('teacher@school.test', '张老师');
  const jwt = ctx().gotrue.jwtFor(userId);

  const { started, callback } = await runLogin('qq', carol, { link: true, jwt, client: 'desktop' });
  strictEqual(callback.status, 200);
  match(await callback.text(), /绑定成功/);
  const f = await finish(started);
  deepStrictEqual(f.body, { status: 'done', linked: true });
  strictEqual(ctx().gotrue.links.length, 0, '加绑不需要登录令牌');
  strictEqual(ctx().gotrue.created.length, 0, '加绑不建用户');
  strictEqual((await finish(started)).status, 404, '只能取一次');

  const ids = await identities(userId);
  deepStrictEqual(ids.map((i) => [i.provider, i.subject]), [['qq', openidOf(carol, TEST.qq.appid)]]);
  // 资料里原来没有头像 → 用 QQ 头像；名字不动
  const p = await profile(userId);
  strictEqual(p?.name, '张老师');
  strictEqual(p?.email, 'teacher@school.test');
  strictEqual(p?.avatar_url, 'https://thirdqq.qlogo.cn/g?b=oidb&k=carol&s=100');

  // 以后用 QQ 登录 → 这个邮箱账号，令牌按它的真邮箱生成
  const again = await loginAs('qq', carol);
  strictEqual(again, userId);
  strictEqual(ctx().gotrue.links.at(-1)?.email, 'teacher@school.test');
});

Deno.test('加绑：已经绑在自己账号上的身份再绑一次 → 成功（不重复）', async () => {
  const userId = await loginAs('wechat_open', alice);
  const jwt = ctx().gotrue.jwtFor(userId);
  const { started, callback } = await runLogin('wechat_open', alice, { link: true, jwt });
  await callback.body?.cancel();
  deepStrictEqual((await finish(started)).body, { status: 'done', linked: true });
  strictEqual((await identities(userId)).length, 1);
});

Deno.test('加绑：服务号身份绑到当前账号，同时写 wechat_bindings', async () => {
  const userId = await createEmailUser('t2@school.test');
  const jwt = ctx().gotrue.jwtFor(userId);
  const { started, callback } = await runLogin('wechat_mp', bob, { link: true, jwt, client: 'web' });
  strictEqual(callback.status, 302);
  deepStrictEqual((await finish(started)).body, { status: 'done', linked: true });
  const [b] = await ctx().sql`select user_id, openid, subscribed from public.wechat_bindings`;
  deepStrictEqual({ ...b }, { user_id: userId, openid: openidOf(bob, TEST.wechatMp.appid), subscribed: true });
});

Deno.test('加绑：这个微信已经属于别的账号 → already_linked，什么都不改', async () => {
  const other = await loginAs('wechat_open', alice);
  const me = await createEmailUser('me@school.test');
  const jwt = ctx().gotrue.jwtFor(me);

  const { started, callback } = await runLogin('wechat_open', alice, { link: true, jwt, client: 'desktop' });
  strictEqual(callback.status, 400);
  const page = await callback.text();
  match(page, /已经绑在别的账号上/);
  deepStrictEqual((await finish(started)).body, { status: 'error', error: 'already_linked' });

  strictEqual((await identities(me)).length, 0);
  strictEqual((await identities(other)).length, 1);
});

Deno.test('加绑：同一个微信（unionid）已经用另一个应用登录过别的账号 → already_linked', async () => {
  const other = await loginAs('wechat_open', alice);
  const me = await createEmailUser('me@school.test');
  const jwt = ctx().gotrue.jwtFor(me);
  // alice 在服务号下还没有身份，但她的 unionid 已经属于 other
  const { started, callback } = await runLogin('wechat_mp', alice, { link: true, jwt, client: 'web' });
  strictEqual(callback.status, 302);
  match(callback.headers.get('location') ?? '', /#pling-login-error=already_linked$/);
  deepStrictEqual((await finish(started)).body, { status: 'error', error: 'already_linked' });
  strictEqual((await identities(me)).length, 0);
  strictEqual((await ctx().sql`select count(*)::int as n from public.wechat_bindings`)[0].n, 0, '失败的加绑不写服务号绑定');
  ok(other);
});

Deno.test('并发的首次登录：同一个人同时完成两次授权，只建一个账号', async () => {
  const { gotrue } = ctx();
  gotrue.createDelayMs = 150; // 让两个回调在建用户时重叠
  const a = await start({ provider: 'wechat_open', client: 'desktop' });
  const b = await start({ provider: 'wechat_open', client: 'desktop' });
  const qa = await authorize(a.url, alice);
  const qb = await authorize(b.url, alice);
  const [ra, rb] = await Promise.all([callCallback(qa), callCallback(qb)]);
  strictEqual(ra.status, 200);
  strictEqual(rb.status, 200);
  await ra.body?.cancel();
  await rb.body?.cancel();

  strictEqual(gotrue.created.length, 1, '只建了一个用户');
  strictEqual(await userCount(), 1);
  const fa = await finish(a);
  const fb = await finish(b);
  strictEqual(fa.body.status, 'done');
  strictEqual(fb.body.status, 'done');
  const ua = gotrue.links.find((l) => l.hashedToken === fa.body.token_hash)?.userId;
  const ub = gotrue.links.find((l) => l.hashedToken === fb.body.token_hash)?.userId;
  strictEqual(ua, ub);
});

Deno.test('并发的首次登录：网站应用和服务号同时登录同一个人（unionid 相同），只建一个账号', async () => {
  const { gotrue } = ctx();
  gotrue.createDelayMs = 150;
  const a = await start({ provider: 'wechat_open', client: 'desktop' });
  const b = await start({ provider: 'wechat_mp', client: 'desktop' });
  const [qa, qb] = [await authorize(a.url, bob), await authorize(b.url, bob)];
  const [ra, rb] = await Promise.all([callCallback(qa), callCallback(qb)]);
  await ra.body?.cancel();
  await rb.body?.cancel();
  strictEqual(gotrue.created.length, 1);
  const owners = await ctx().sql<{ user_id: string }[]>`select distinct user_id from public.login_identities`;
  strictEqual(owners.length, 1);
});
