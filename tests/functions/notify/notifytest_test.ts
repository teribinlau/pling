// notify-test：{ webhookId } 要管理员；{ wechat: true } 已激活成员给自己发一条测试模板消息。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { callNotifyTest, makeBuilders, setEnv, setupNotifyTests, test } from './harness.ts';
import { TEST } from './fakes.ts';

const ctx = setupNotifyTests();
const b = makeBuilders(ctx);

async function hookRow(id: string) {
  const [w] = await ctx().sql<
    { last_at: Date | null; last_status: string }[]
  >`select last_at, last_status from public.team_webhooks where id = ${id}`;
  return w;
}

test('notify-test 机器人：管理员 → 发测试消息，返回 { ok: true }，更新 last_at / last_status', async () => {
  const id = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/t', secret: 'SECtest' });
  const res = await callNotifyTest({ webhookId: id }, ctx().admin.jwt);
  strictEqual(res.status, 200);
  deepStrictEqual(await res.json(), { ok: true });
  const [call] = ctx().robots.callsTo('/dingtalk/t');
  deepStrictEqual(call.body, {
    msgtype: 'text',
    text: { content: '【叮一下】测试消息：机器人配置成功' },
    at: { atMobiles: [], isAtAll: false },
  });
  ok(call.query.get('sign'), '加签了');
  const row = await hookRow(id);
  strictEqual(row.last_status, 'ok');
  ok(row.last_at);
});

test('notify-test 机器人：发失败 → 200 { ok: false, error }，last_status 记错误', async () => {
  const id = await b.webhook({ kind: 'feishu', path: '/feishu/t' });
  ctx().robots.responses.set('/feishu/t', { body: { code: 19024, msg: 'Key Words Not Found' } });
  const res = await callNotifyTest({ webhookId: id }, ctx().admin.jwt);
  strictEqual(res.status, 200);
  deepStrictEqual(await res.json(), { ok: false, error: '19024 Key Words Not Found' });
  strictEqual((await hookRow(id)).last_status, '19024 Key Words Not Found');
});

test('notify-test 机器人：不是管理员 → 403；没登录 → 401；没有这个机器人 → 404；请求不对 → 400', async () => {
  const id = await b.webhook({ kind: 'wecom', path: '/wecom/t' });
  const zhang = await b.person('张三');
  const pending = await b.person('待激活', { active: false });
  const deny = async (res: Response, status: number, error: string) => {
    strictEqual(res.status, status);
    strictEqual((await res.json()).error, error);
  };
  await deny(await callNotifyTest({ webhookId: id }, zhang.jwt), 403, 'admin_only');
  await deny(await callNotifyTest({ webhookId: id }, pending.jwt), 403, 'inactive');
  await deny(await callNotifyTest({ webhookId: id }), 401, 'unauthorized');
  await deny(await callNotifyTest({ webhookId: id }, 'jwt-forged'), 401, 'unauthorized');
  await deny(await callNotifyTest({ webhookId: crypto.randomUUID() }, ctx().admin.jwt), 404, 'not_found');
  await deny(await callNotifyTest({ webhookId: 'not-a-uuid' }, ctx().admin.jwt), 404, 'not_found');
  await deny(await callNotifyTest({}, ctx().admin.jwt), 400, 'bad_request');
  await deny(await callNotifyTest({ wechat: 'yes' }, ctx().admin.jwt), 400, 'bad_request');
  await deny(await callNotifyTest('not json', ctx().admin.jwt), 400, 'bad_json');
  strictEqual(ctx().robots.calls.length, 0);
});

test('notify-test 服务号：任何已激活成员给自己发一条测试模板消息', async () => {
  const zhang = await b.person('张三');
  await b.settings({ org_name: '某某中学' });
  const res = await callNotifyTest({ wechat: true }, zhang.jwt);
  strictEqual(res.status, 200);
  deepStrictEqual(await res.json(), { ok: true });
  strictEqual(ctx().wechat.sent.length, 1);
  const m = ctx().wechat.sent[0];
  strictEqual(m.touser, zhang.openid);
  strictEqual(m.template_id, TEST.mp.templateId);
  strictEqual(m.url, `${TEST.publicUrl}/`);
  strictEqual(m.data.thing1.value, '测试消息：服务号通知已开通');
  strictEqual(m.data.phrase3.value, '测试');
  strictEqual(m.data.thing4.value, '某某中学');
  strictEqual(m.data.name5.value, '张三');
  match(m.data.time2.value, /^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/);
});

test('notify-test 服务号：没绑定 → 400 not_bound；没配服务号 → 400 wechat_mp_disabled；待激活 → 403', async () => {
  const nobody = await b.person('没绑定', { bind: false });
  const res = await callNotifyTest({ wechat: true }, nobody.jwt);
  strictEqual(res.status, 400);
  const body = await res.json();
  strictEqual(body.error, 'not_bound');
  strictEqual(body.message, '还没有绑定服务号');
  const pending = await b.person('待激活', { active: false });
  strictEqual((await callNotifyTest({ wechat: true }, pending.jwt)).status, 403);
  setEnv({ WECHAT_MP_TEMPLATE_ID: undefined });
  const zhang = await b.person('张三');
  const r2 = await callNotifyTest({ wechat: true }, zhang.jwt);
  strictEqual(r2.status, 400);
  strictEqual((await r2.json()).error, 'wechat_mp_disabled');
  strictEqual(ctx().wechat.sent.length, 0);
});

test('notify-test 服务号：没关注（43004）→ { ok: false } 并标记 subscribed = false；重新关注后发得出去 → 改回 true', async () => {
  const zhang = await b.person('张三');
  ctx().wechat.unsubscribed.add(zhang.openid);
  const res = await callNotifyTest({ wechat: true }, zhang.jwt);
  deepStrictEqual(await res.json(), { ok: false, error: '43004 require subscribe（没有关注服务号）' });
  const sub = async () =>
    (await ctx().sql<{ subscribed: boolean }[]>`select subscribed from public.wechat_bindings where user_id = ${zhang.id}`)[0].subscribed;
  strictEqual(await sub(), false);
  ctx().wechat.unsubscribed.clear();
  deepStrictEqual(await (await callNotifyTest({ wechat: true }, zhang.jwt)).json(), { ok: true });
  strictEqual(await sub(), true);
});

test('notify-test 服务号：微信接口超时 → { ok: false, error: "timeout" }', async () => {
  const { HTTP_TIMEOUT } = await import('../../../supabase/functions/_shared/notify/util.ts');
  HTTP_TIMEOUT.wechat = 200;
  const zhang = await b.person('张三');
  ctx().wechat.slow.set(zhang.openid, 1000);
  deepStrictEqual(await (await callNotifyTest({ wechat: true }, zhang.jwt)).json(), { ok: false, error: 'timeout' });
});

test('notify-test：CORS 预检', async () => {
  const { default: handler } = await import('../../../supabase/functions/notify-test/handler.ts');
  const res = await handler(
    new Request(`${TEST.publicUrl}/api/functions/v1/notify-test`, { method: 'OPTIONS', headers: { Origin: TEST.publicUrl } }),
  );
  strictEqual(res.status, 204);
  strictEqual(res.headers.get('access-control-allow-origin'), TEST.publicUrl);
});
