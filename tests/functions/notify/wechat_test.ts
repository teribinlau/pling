// wechat-bind（要绑定二维码）+ wechat-mp（服务号消息服务器）：验签、绑定、挪绑定、取消关注、重新关注、过期的场景值、被动回复。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { parseMpXml } from '../../../supabase/functions/_shared/wechat-mp.ts';
import {
  callWechatBind,
  callWechatMp,
  eventXml,
  makeBuilders,
  setEnv,
  setupNotifyTests,
  signedQuery,
  test,
  textXml,
  wxSign,
} from './harness.ts';
import { TEST } from './fakes.ts';

const ctx = setupNotifyTests();
const b = makeBuilders(ctx);

async function binding(userId: string) {
  const [r] = await ctx().sql<{ openid: string; subscribed: boolean; unionid: string; nickname: string; bound_at: Date }[]>`
    select openid, subscribed, unionid, nickname, bound_at from public.wechat_bindings where user_id = ${userId}`;
  return r ?? null;
}

/** 要一个绑定二维码，返回场景值 */
async function newScene(jwt: string): Promise<string> {
  const res = await callWechatBind(jwt);
  strictEqual(res.status, 200, await res.clone().text());
  await res.body?.cancel();
  const qr = ctx().wechat.qrcodes.at(-1)!;
  return (qr.body.action_info as { scene: { scene_str: string } }).scene.scene_str;
}

/** 推一个事件，返回被动回复的文字（回 success → null） */
async function push(xml: string): Promise<{ status: number; reply: string | null; raw: string; type: string }> {
  const res = await callWechatMp('POST', signedQuery(), xml);
  const raw = await res.text();
  const type = res.headers.get('content-type') ?? '';
  if (raw === 'success' || res.status !== 200) return { status: res.status, reply: null, raw, type };
  return { status: res.status, reply: parseMpXml(raw).Content ?? null, raw, type };
}

// ---------------------------------------------------------------------------
// wechat-bind
// ---------------------------------------------------------------------------

test('wechat-bind：已激活成员 → { qrUrl, expiresAt }，场景值 bind_ + 20 位，10 分钟有效', async () => {
  const zhang = await b.person('张三', { bind: false });
  const t0 = Date.now();
  const res = await callWechatBind(zhang.jwt);
  strictEqual(res.status, 200);
  const body = await res.json();
  deepStrictEqual(Object.keys(body).sort(), ['expiresAt', 'qrUrl']);
  const qr = ctx().wechat.qrcodes[0];
  strictEqual(body.qrUrl, `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(qr.ticket)}`);
  const scene = (qr.body.action_info as { scene: { scene_str: string } }).scene.scene_str;
  match(scene, /^bind_[a-z0-9]{20}$/);
  deepStrictEqual({ ...qr.body, action_info: undefined }, { expire_seconds: 600, action_name: 'QR_STR_SCENE', action_info: undefined });
  const exp = new Date(body.expiresAt).getTime();
  ok(Math.abs(exp - (t0 + 600000)) < 5000, body.expiresAt);
  const [t] = await ctx().sql<
    { user_id: string; expires_at: Date; used_at: Date | null }[]
  >`select user_id, expires_at, used_at from public.wechat_bind_tickets where scene = ${scene}`;
  deepStrictEqual([t.user_id, t.expires_at.getTime(), t.used_at], [zhang.id, exp, null]);
  // 每次都是新的场景值
  const scene2 = await newScene(zhang.jwt);
  ok(scene2 !== scene);
});

test('wechat-bind：没登录 → 401；待激活 → 403；没配服务号 → 400 wechat_mp_disabled；GET → 405', async () => {
  const pending = await b.person('待激活', { active: false, bind: false });
  strictEqual((await callWechatBind()).status, 401);
  strictEqual((await callWechatBind(pending.jwt)).status, 403);
  const zhang = await b.person('张三', { bind: false });
  strictEqual((await callWechatBind(zhang.jwt, 'GET')).status, 405);
  for (const missing of ['WECHAT_MP_APPID', 'WECHAT_MP_SECRET', 'WECHAT_MP_TOKEN']) {
    const saved = Deno.env.get(missing);
    setEnv({ [missing]: undefined });
    const res = await callWechatBind(zhang.jwt);
    strictEqual(res.status, 400, missing);
    deepStrictEqual(await res.json(), { error: 'wechat_mp_disabled', message: '服务器没有配置微信服务号' });
    setEnv({ [missing]: saved });
  }
  strictEqual(ctx().wechat.qrcodes.length, 0);
  strictEqual((await ctx().sql`select 1 from public.wechat_bind_tickets`).length, 0);
});

test('wechat-bind：微信接口出错 → 502 wechat_error，场景值删掉', async () => {
  const zhang = await b.person('张三', { bind: false });
  ctx().wechat.qrError = { errcode: 48001, errmsg: 'api unauthorized' };
  const res = await callWechatBind(zhang.jwt);
  strictEqual(res.status, 502);
  const body = await res.json();
  strictEqual(body.error, 'wechat_error');
  match(body.message, /48001 api unauthorized（服务号没有这个接口的权限）/);
  strictEqual((await ctx().sql`select 1 from public.wechat_bind_tickets`).length, 0);
});

// ---------------------------------------------------------------------------
// wechat-mp：验签
// ---------------------------------------------------------------------------

test('wechat-mp GET：验签通过原样返回 echostr；不通过 403', async () => {
  const ok1 = await callWechatMp('GET', signedQuery({ echostr: '1234567890abc' }));
  strictEqual(ok1.status, 200);
  strictEqual(await ok1.text(), '1234567890abc');
  const q = signedQuery({ echostr: 'x' });
  q.set('signature', '0'.repeat(40));
  const bad = await callWechatMp('GET', q);
  strictEqual(bad.status, 403);
  await bad.body?.cancel();
  const wrongToken = await callWechatMp('GET', signedQuery({ echostr: 'x' }, 'other-token'));
  strictEqual(wrongToken.status, 403);
  await wrongToken.body?.cancel();
  setEnv({ WECHAT_MP_TOKEN: undefined });
  const noToken = await callWechatMp('GET', signedQuery({ echostr: 'x' }, ''));
  strictEqual(noToken.status, 403, '没配 Token 一律不通过');
  await noToken.body?.cancel();
});

test('wechat-mp POST：验签失败 → 403，什么都不改', async () => {
  const zhang = await b.person('张三', { bind: false });
  const scene = await newScene(zhang.jwt);
  const q = signedQuery();
  q.set('timestamp', String(Number(q.get('timestamp')) + 1));
  const res = await callWechatMp('POST', q, eventXml('o-attacker', 'SCAN', scene));
  strictEqual(res.status, 403);
  await res.body?.cancel();
  strictEqual(await binding(zhang.id), null);
  const res2 = await callWechatMp('POST', new URLSearchParams(), eventXml('o-attacker', 'SCAN', scene));
  strictEqual(res2.status, 403);
  await res2.body?.cancel();
});

// ---------------------------------------------------------------------------
// wechat-mp：绑定
// ---------------------------------------------------------------------------

test('绑定：扫码关注（subscribe + qrscene_bind_…）→ 写 wechat_bindings，回「已绑定「张三」…」（CDATA 的 XML）', async () => {
  const zhang = await b.person('张三', { bind: false });
  const scene = await newScene(zhang.jwt);
  const r = await push(eventXml('o-zhang', 'subscribe', `qrscene_${scene}`, '<Ticket><![CDATA[gQH47]]></Ticket>'));
  strictEqual(r.status, 200);
  strictEqual(r.reply, '已绑定「张三」，以后的提醒会发到这里。在叮一下的「设置 → 通知」里可以随时解绑。');
  match(r.type, /xml/);
  const x = parseMpXml(r.raw);
  deepStrictEqual([x.ToUserName, x.FromUserName, x.MsgType], ['o-zhang', 'gh_pling_test', 'text']);
  ok(r.raw.includes('<ToUserName><![CDATA[o-zhang]]></ToUserName>'));
  ok(r.raw.includes('<Content><![CDATA[已绑定「张三」'));
  ok(/^<xml><ToUserName>.*<CreateTime>\d{10}<\/CreateTime>/.test(r.raw));
  const bnd = await binding(zhang.id);
  deepStrictEqual([bnd?.openid, bnd?.subscribed], ['o-zhang', true]);
  const [t] = await ctx().sql<{ used_at: Date | null }[]>`select used_at from public.wechat_bind_tickets where scene = ${scene}`;
  ok(t.used_at, '场景值用掉了');
});

test('绑定：已经关注的人扫码（SCAN + bind_…）也能绑；微信重发同一个事件照样回成功，不重复处理', async () => {
  const li = await b.person('李四', { bind: false });
  const scene = await newScene(li.jwt);
  const ev = eventXml('o-li', 'SCAN', scene);
  const r1 = await push(ev);
  strictEqual(r1.reply, '已绑定「李四」，以后的提醒会发到这里。在叮一下的「设置 → 通知」里可以随时解绑。');
  const first = await binding(li.id);
  const r2 = await push(ev);
  strictEqual(r2.reply, r1.reply);
  deepStrictEqual(await binding(li.id), first);
  // 别人拿到这张用过的码再扫：不行
  const r3 = await push(eventXml('o-someone-else', 'SCAN', scene));
  strictEqual(r3.reply, '这个二维码已经用过了，请在叮一下的「设置 → 通知」里重新生成。');
  strictEqual((await binding(li.id))?.openid, 'o-li');
});

test('绑定：场景值过期 / 不存在 / 格式不对 → 回「二维码已过期」，不绑', async () => {
  const zhang = await b.person('张三', { bind: false });
  const scene = await newScene(zhang.jwt);
  await ctx().sql`update public.wechat_bind_tickets set expires_at = now() - interval '1 second' where scene = ${scene}`;
  const expired = '二维码已过期，请在叮一下的「设置 → 通知」里重新生成。';
  strictEqual((await push(eventXml('o-zhang', 'SCAN', scene))).reply, expired);
  strictEqual((await push(eventXml('o-zhang', 'subscribe', `qrscene_${scene}`))).reply, expired);
  strictEqual((await push(eventXml('o-zhang', 'SCAN', 'bind_' + 'a'.repeat(20)))).reply, expired);
  strictEqual((await push(eventXml('o-zhang', 'SCAN', "bind_x' or 1=1 --"))).reply, expired);
  strictEqual(await binding(zhang.id), null);
});

test('挪绑定：同一个微信原来绑在别人账号上 → 挪到扫码的这个账号（unionid / 昵称跟着走）', async () => {
  const zhang = await b.person('张三', { bind: false });
  const li = await b.person('李四', { bind: false });
  await ctx()
    .sql`insert into public.wechat_bindings (user_id, openid, unionid, nickname, subscribed) values (${zhang.id}, 'o-shared', 'u-1', '小明', true)`;
  const scene = await newScene(li.jwt);
  const r = await push(eventXml('o-shared', 'SCAN', scene));
  strictEqual(r.reply, '已绑定「李四」，以后的提醒会发到这里。在叮一下的「设置 → 通知」里可以随时解绑。');
  strictEqual(await binding(zhang.id), null);
  const bnd = await binding(li.id);
  deepStrictEqual([bnd?.openid, bnd?.unionid, bnd?.nickname, bnd?.subscribed], ['o-shared', 'u-1', '小明', true]);
});

test('换微信：本人用另一个微信扫码 → 绑定换成新的 openid', async () => {
  const zhang = await b.person('张三', { bind: false });
  await ctx().sql`insert into public.wechat_bindings (user_id, openid, subscribed) values (${zhang.id}, 'o-old', false)`;
  const before = (await binding(zhang.id))!.bound_at;
  const scene = await newScene(zhang.jwt);
  await push(eventXml('o-new', 'subscribe', `qrscene_${scene}`));
  const bnd = await binding(zhang.id);
  deepStrictEqual([bnd?.openid, bnd?.subscribed], ['o-new', true]);
  ok(bnd!.bound_at.getTime() >= before.getTime());
});

// ---------------------------------------------------------------------------
// wechat-mp：取消关注、重新关注、别的消息
// ---------------------------------------------------------------------------

test('取消关注 → subscribed = false，回 success；重新关注（普通关注）→ 改回 true，回「欢迎回来」', async () => {
  const zhang = await b.person('张三'); // 已绑定
  const r1 = await push(eventXml(zhang.openid, 'unsubscribe', ''));
  strictEqual(r1.raw, 'success');
  strictEqual((await binding(zhang.id))?.subscribed, false);
  const r2 = await push(eventXml(zhang.openid, 'subscribe', ''));
  strictEqual((await binding(zhang.id))?.subscribed, true);
  strictEqual(r2.reply, `欢迎回来，「张三」的提醒会继续发到这里。\n打开叮一下：${TEST.publicUrl}/`);
});

test('重新关注扫的是绑定码：照样绑定 + subscribed 改回 true', async () => {
  const zhang = await b.person('张三');
  await ctx().sql`update public.wechat_bindings set subscribed = false where user_id = ${zhang.id}`;
  const scene = await newScene(zhang.jwt);
  const r = await push(eventXml(zhang.openid, 'subscribe', `qrscene_${scene}`));
  match(r.reply ?? '', /^已绑定「张三」/);
  strictEqual((await binding(zhang.id))?.subscribed, true);
});

test('没绑定的人关注 / 发消息 → 回带应用链接的说明；已绑定的人发消息 → 告诉他绑的是谁', async () => {
  const r1 = await push(eventXml('o-stranger', 'subscribe', ''));
  strictEqual(r1.reply, `感谢关注叮一下。\n在叮一下的「设置 → 通知」里扫码绑定后，提醒会发到这里。\n打开叮一下：${TEST.publicUrl}/`);
  const r2 = await push(textXml('o-stranger', '你好'));
  strictEqual(r2.reply, `这里是叮一下的提醒通知。在叮一下的「设置 → 通知」里扫码绑定后，提醒会发到这里。\n打开叮一下：${TEST.publicUrl}/`);
  const zhang = await b.person('张三');
  const r3 = await push(textXml(zhang.openid, '在吗'));
  strictEqual(r3.reply, `这里会收到「张三」的提醒。\n打开叮一下：${TEST.publicUrl}/`);
  // 没配 PLING_PUBLIC_URL 就不带链接
  setEnv({ PLING_PUBLIC_URL: undefined });
  strictEqual((await push(textXml(zhang.openid, '在吗'))).reply, '这里会收到「张三」的提醒。');
});

test('其他事件（菜单、模板消息送达回执、位置上报）→ success', async () => {
  for (const ev of ['CLICK', 'VIEW', 'TEMPLATESENDJOBFINISH', 'LOCATION']) {
    strictEqual((await push(eventXml('o-x', ev, 'whatever'))).raw, 'success', ev);
  }
  strictEqual((await push('<xml><ToUserName><![CDATA[gh]]></ToUserName></xml>')).raw, 'success', '没有 MsgType');
  strictEqual((await push('garbage')).raw, 'success');
});

test('安全模式（只有 <Encrypt>，没有明文字段）→ 回 success 并 console.warn', async () => {
  const r = await push('<xml><ToUserName><![CDATA[gh_pling_test]]></ToUserName><Encrypt><![CDATA[c2VjcmV0]]></Encrypt></xml>');
  strictEqual(r.raw, 'success');
  ok(ctx().logs.some((l) => l.includes('安全模式')), ctx().logs.join('\n'));
});

test('兼容模式（明文字段 + <Encrypt> 都有）→ 按明文处理', async () => {
  const zhang = await b.person('张三', { bind: false });
  const scene = await newScene(zhang.jwt);
  const xml = eventXml('o-zhang', 'SCAN', scene, '<Encrypt><![CDATA[c2VjcmV0]]></Encrypt>');
  match((await push(xml)).reply ?? '', /^已绑定「张三」/);
});

test('5 秒内要回应：数据库卡住时 4.5 秒先回 success', async () => {
  const zhang = await b.person('张三');
  // 另一个连接锁住张三的绑定行，unsubscribe 的 update 会一直等
  const holder = await ctx().sql.reserve();
  try {
    await holder`begin`;
    await holder`select 1 from public.wechat_bindings where user_id = ${zhang.id} for update`;
    const t0 = Date.now();
    const r = await push(eventXml(zhang.openid, 'unsubscribe', ''));
    const took = Date.now() - t0;
    strictEqual(r.raw, 'success');
    ok(took >= 4400 && took < 5500, `took ${took}ms`); // 机器很忙时多给一点余量；没有兜底的话会一直等到锁放开
  } finally {
    await holder`rollback`;
    holder.release();
  }
  // 锁放开后那个 update 在后台跑完了
  await new Promise((r) => setTimeout(r, 200));
  strictEqual((await binding(zhang.id))?.subscribed, false);
});

test('被动回复用的签名和 node:crypto 算的一样（自检：wxSign 不依赖被测代码）', () => {
  strictEqual(wxSign('mp-token-test', '1700000000', 'nonce123'), '539947e60cb911baaf9d3c6ff2d61441d1db5ef8');
});
