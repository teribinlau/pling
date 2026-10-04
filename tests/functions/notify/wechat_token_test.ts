// 服务号 access_token：stable_token、缓存在 kv_cache（提前 5 分钟过期）、令牌失效刷新重试一次；43004 → subscribed = false。
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { WechatMp } from '../../../supabase/functions/_shared/wechat-mp.ts';
import { logRows, makeBuilders, run, setupNotifyTests, sh, test, wxSent } from './harness.ts';
import { TEST } from './fakes.ts';

const ctx = setupNotifyTests();
const b = makeBuilders(ctx);
const CACHE_KEY = `wechat_mp_access_token:${TEST.mp.appid}`;

async function cacheRow() {
  const rows = await ctx().sql<{ value: string; ttl: number }[]>`
    select value, extract(epoch from expires_at - now())::int as ttl from public.kv_cache where key = ${CACHE_KEY}`;
  return rows[0] ?? null;
}

async function onePersonDueAt(local: string, name = '张三') {
  const p = await b.person(name);
  await b.prefs(p.id, { dnd: false });
  await b.reminder({ due: sh(local), users: [p.id], before: 0, repeat: 0 });
  return p;
}

test('令牌：第一次向微信要（stable_token，不强制刷新），缓存进 kv_cache，提前 5 分钟过期', async () => {
  await onePersonDueAt('2026-10-09 17:00');
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual(ctx().wechat.tokenCalls, [{ force: false, appid: TEST.mp.appid }]);
  const row = await cacheRow();
  ok(row);
  strictEqual(row.value, ctx().wechat.current);
  ok(row.ttl > 7200 - 300 - 5 && row.ttl <= 7200 - 300, `ttl = ${row.ttl}`);
});

test('令牌缓存：下一次运行、别的函数直接用缓存，不再调 stable_token；缓存过期了再要', async () => {
  await onePersonDueAt('2026-10-09 17:00');
  await onePersonDueAt('2026-10-09 17:01', '李四');
  await run(sh('2026-10-09 17:00'));
  await run(sh('2026-10-09 17:01'));
  strictEqual(ctx().wechat.tokenCalls.length, 1);
  strictEqual(ctx().wechat.sent.length, 2);
  strictEqual(await new WechatMp(ctx().sql).token(), ctx().wechat.current, '新的实例也从缓存拿');
  strictEqual(ctx().wechat.tokenCalls.length, 1);
  // 缓存过期（微信那边令牌还有效，普通模式拿到的还是它）
  await ctx().sql`update public.kv_cache set expires_at = now() - interval '1 second' where key = ${CACHE_KEY}`;
  const before = ctx().wechat.current;
  strictEqual(await new WechatMp(ctx().sql).token(), before);
  deepStrictEqual(ctx().wechat.tokenCalls.map((c) => c.force), [false, false]);
});

test('令牌：一次运行里很多条消息只拿一次令牌（并发也是）', async () => {
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await b.person(`同学${i}`)).id);
  for (const id of ids) await b.prefs(id, { dnd: false });
  await b.reminder({ due: sh('2026-10-09 17:00'), users: ids, before: 0 });
  const r = await run(sh('2026-10-09 17:00'));
  strictEqual(r.sent, 12);
  strictEqual(ctx().wechat.tokenCalls.length, 1);
});

test('令牌失效（42001 过期）：刷新令牌重试一次，发出去了；缓存换成新令牌', async () => {
  const p = await onePersonDueAt('2026-10-09 17:00');
  // 缓存里的令牌在微信那边已经过期了
  const old = 'tok-old-expired';
  ctx().wechat.expired.add(old);
  await ctx().sql`insert into public.kv_cache (key, value, expires_at) values (${CACHE_KEY}, ${old}, now() + interval '1 hour')`;
  const r = await run(sh('2026-10-09 17:00'));
  strictEqual(r.sent, 1);
  deepStrictEqual(wxSent(ctx()), [[p.openid, '已到期']]);
  deepStrictEqual(ctx().wechat.attempts.map((a) => [a.token === old, a.errcode]), [[true, 42001], [false, 0]]);
  deepStrictEqual(ctx().wechat.tokenCalls.map((c) => c.force), [false], '普通模式拿到的就是新令牌，不用强制刷新');
  strictEqual((await cacheRow())?.value, ctx().wechat.current);
});

test('令牌失效（40001）：普通模式拿到的还是坏的那个 → 强制刷新；只重试一次，还不行就记 failed', async () => {
  const p = await onePersonDueAt('2026-10-09 17:00');
  const q = await onePersonDueAt('2026-10-09 17:00', '李四');
  ctx().wechat.issue(); // 微信那边的当前令牌
  const bad = ctx().wechat.current!;
  ctx().wechat.issued.push(bad);
  ctx().wechat.rejected.add(bad); // 但它被拒（比如别的系统强制刷新过，我们拿到的是旧的）
  await ctx().sql`insert into public.kv_cache (key, value, expires_at) values (${CACHE_KEY}, ${bad}, now() + interval '1 hour')`;
  const r = await run(sh('2026-10-09 17:00'));
  strictEqual(r.sent, 2);
  deepStrictEqual(ctx().wechat.tokenCalls.map((c) => c.force), [false, true], '两条消息同时失败，只刷新一次');
  deepStrictEqual(wxSent(ctx()).map((x) => x[0]).sort(), [p.openid, q.openid].sort());

  // 微信还是不认：一小时内已经强制刷新过一次，不再强制刷新（每天有次数限制）；拿到的还是同一个令牌，就不白白重试，记 failed
  ctx().wechat.rejectAll = true;
  ctx().wechat.attempts = [];
  await b.reminder({ due: sh('2026-10-09 18:00'), users: [p.id, q.id], before: 0, repeat: 0 });
  const r2 = await run(sh('2026-10-09 18:00'));
  deepStrictEqual({ sent: r2.sent, failed: r2.failed }, { sent: 0, failed: 2 });
  deepStrictEqual(ctx().wechat.tokenCalls.map((c) => c.force), [false, true, false], '只多了一次普通模式');
  strictEqual(ctx().wechat.attempts.length, 2, '每条一次');
  const rows = (await logRows(ctx().sql)).slice(-2);
  ok(rows.every((x) => x.status === 'failed' && x.error === '40001 invalid credential, access_token is invalid or not latest（令牌失效）'));
  ok(ctx().logs.some((l) => l.includes('一小时内已经强制刷新过一次')));
});

test('令牌失效、刷新后的新令牌又失效：每条消息最多两次请求，这次运行只刷新一次', async () => {
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push((await b.person(`同学${i}`)).id);
  for (const id of ids) await b.prefs(id, { dnd: false });
  await b.reminder({ due: sh('2026-10-09 17:00'), users: ids, before: 0 });
  await ctx().sql`insert into public.kv_cache (key, value, expires_at) values (${CACHE_KEY}, 'tok-stale', now() + interval '1 hour')`;
  ctx().wechat.rejectAll = true;
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 0, failed: 10 });
  deepStrictEqual(ctx().wechat.tokenCalls.map((c) => c.force), [false], '拿到的是新令牌，不用强制刷新；之后不再刷新');
  ok(ctx().wechat.attempts.length <= 20, `${ctx().wechat.attempts.length} 次请求`);
  const perUser = new Map<string, number>();
  for (const a of ctx().wechat.attempts) perUser.set(a.touser, (perUser.get(a.touser) ?? 0) + 1);
  ok([...perUser.values()].every((n) => n <= 2));
});

test('拿不到令牌（IP 不在白名单）：这次的服务号消息都不发也不记，下一分钟再试；群机器人照发', async () => {
  const p = await onePersonDueAt('2026-10-09 17:00');
  await b.webhook({ kind: 'wecom', path: '/wecom/all', stages: ['due'] });
  await b.reminder({ title: '全体', due: sh('2026-10-09 17:00'), visibility: 'company', before: 0, repeat: 0 });
  ctx().wechat.tokenError = { errcode: 40164, errmsg: 'invalid ip 10.0.0.8 ipv6 ::ffff:10.0.0.8, not in whitelist' };
  const r = await run(sh('2026-10-09 17:00'));
  strictEqual(
    r.error,
    'wechat token: 40164 invalid ip 10.0.0.8 ipv6 ::ffff:10.0.0.8, not in whitelist（服务器 IP 不在服务号的 IP 白名单里）',
  );
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 1, failed: 0 }, '机器人那条');
  strictEqual(ctx().robots.calls.length, 1);
  deepStrictEqual((await logRows(ctx().sql)).map((x) => x.channel), ['webhook']);
  ok(ctx().logs.some((l) => l.includes('拿不到服务号 access_token')));
  // 白名单加好了：下一分钟补上
  ctx().wechat.tokenError = null;
  const r2 = await run(sh('2026-10-09 17:01'));
  strictEqual(r2.sent, 2, '张三的「已到期」和「全体」那条（张三是成员）');
  ok(wxSent(ctx()).every(([openid]) => openid === p.openid));
});

test('43004（没关注）：这个绑定 subscribed = false，记 failed；以后不再给他发', async () => {
  const p = await onePersonDueAt('2026-10-09 17:00');
  ctx().wechat.unsubscribed.add(p.openid);
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 0, failed: 1 });
  const [bnd] = await ctx().sql<{ subscribed: boolean }[]>`select subscribed from public.wechat_bindings where user_id = ${p.id}`;
  strictEqual(bnd.subscribed, false);
  strictEqual((await logRows(ctx().sql))[0].error, '43004 require subscribe（没有关注服务号）');
  await b.reminder({ due: sh('2026-10-09 18:00'), users: [p.id], before: 0, repeat: 0 });
  ctx().wechat.attempts = [];
  await run(sh('2026-10-09 18:00'));
  strictEqual(ctx().wechat.attempts.length, 0, '取消关注的人不再尝试');
});
