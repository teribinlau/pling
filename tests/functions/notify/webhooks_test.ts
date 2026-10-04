// 群机器人：三家的消息格式和加签（假接收端用 node:crypto 验签）、阶段过滤、归属、each 模式的名单和 @、last_at / last_status、去重。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { HTTP_TIMEOUT } from '../../../supabase/functions/_shared/notify/util.ts';
import { logRows, makeBuilders, run, setupNotifyTests, sh, test } from './harness.ts';
import { TEST } from './fakes.ts';

const ctx = setupNotifyTests();
const b = makeBuilders(ctx);

async function hookRow(id: string) {
  const [w] = await ctx().sql<
    { last_at: Date | null; last_status: string }[]
  >`select last_at, last_status from public.team_webhooks where id = ${id}`;
  return w;
}

test('三家的格式：企业微信 mentioned_mobile_list、钉钉 at.atMobiles + 正文 @、飞书 msg_type text；加签都对', async () => {
  const t1 = await b.team('高一（1）班');
  const zhang = await b.person('张三', { team: t1, phone: '138 0013 8000' });
  const li = await b.person('李四', { team: t1, phone: '+86 139-0013-9000' });
  const wang = await b.person('王五', { team: t1 }); // 没手机号
  const wecom = await b.webhook({ kind: 'wecom', path: '/wecom/c1', team: t1 });
  const ding = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/c1', team: t1, secret: 'SECdingtalk-test-secret' });
  const feishu = await b.webhook({ kind: 'feishu', path: '/feishu/c1', team: t1, secret: 'feishu-test-secret' });
  const due = sh('2026-10-09 17:00');
  const rid = await b.reminder({ title: '交物理实验报告', due, teams: [t1], mode: 'each', before: 0, repeat: 0 });
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 3 + 3, failed: 0 }, '三个机器人 + 三个人的服务号');

  const text =
    `【叮一下】交物理实验报告\n时间：10月9日 周五 17:00（已到期）\n还没完成：李四、王五、张三（共 3 人）\n查看：${TEST.publicUrl}/?r=${rid}&o=${due.toISOString()}`;
  const [w] = ctx().robots.callsTo('/wecom/c1');
  deepStrictEqual(w.body, { msgtype: 'text', text: { content: text, mentioned_mobile_list: ['13800138000', '13900139000'] } });

  const [d] = ctx().robots.callsTo('/dingtalk/c1');
  deepStrictEqual(d.body, {
    msgtype: 'text',
    text: { content: `${text}\n@13800138000 @13900139000` },
    at: { atMobiles: ['13800138000', '13900139000'], isAtAll: false },
  });
  ok(/^\d{13}$/.test(d.query.get('timestamp') ?? ''), '钉钉的时间戳是毫秒');
  ok(Math.abs(Number(d.query.get('timestamp')) - Date.now()) < 60000);

  const [f] = ctx().robots.callsTo('/feishu/c1');
  deepStrictEqual(Object.keys(f.body).sort(), ['content', 'msg_type', 'sign', 'timestamp']);
  deepStrictEqual([f.body.msg_type, f.body.content], ['text', { text }]);
  ok(/^\d{10}$/.test(String(f.body.timestamp)), '飞书的时间戳是秒');

  // 假接收端验签通过才回成功：三个都成功了
  for (const id of [wecom, ding, feishu]) {
    const row = await hookRow(id);
    strictEqual(row.last_status, 'ok');
    ok(row.last_at && Date.now() - row.last_at.getTime() < 60000);
  }
  // 名单按拼音排，@ 的只有有手机号的；王五没手机号也列在名单里
  ok(zhang && li && wang);
});

test('加签不对 → 失败：记录 failed + 错误、last_status 是错误信息', async () => {
  const t1 = await b.team('一班');
  await b.person('张三', { team: t1, bind: false });
  const ding = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/bad', team: t1, secret: 'right-secret' });
  const feishu = await b.webhook({ kind: 'feishu', path: '/feishu/bad', team: t1, secret: 'right-secret' });
  // 库里存的密钥和机器人那边的不一样
  await ctx().sql`update public.team_webhooks set secret = 'wrong-secret'`;
  await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], before: 0 });
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 0, failed: 2 });
  strictEqual((await hookRow(ding)).last_status, '310000 sign not match');
  match((await hookRow(feishu)).last_status, /^19021 sign match fail/);
  const rows = await logRows(ctx().sql);
  deepStrictEqual(rows.map((x) => [x.channel, x.status]), [['webhook', 'failed'], ['webhook', 'failed']]);
  deepStrictEqual(rows.map((x) => x.webhook_id).sort(), [ding, feishu].sort());
});

test('机器人成功判断：HTTP 200 但 errcode ≠ 0 算失败；飞书老接口 StatusCode 0 算成功；不是 JSON / 不是对象算失败；超时算失败', async () => {
  const t1 = await b.team('一班');
  await b.person('张三', { team: t1, bind: false });
  const a = await b.webhook({ kind: 'wecom', path: '/wecom/limited', team: t1 });
  const c = await b.webhook({ kind: 'feishu', path: '/feishu/old', team: t1 });
  const d = await b.webhook({ kind: 'wecom', path: '/wecom/html', team: t1 });
  const e = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/slow', team: t1 });
  const f = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/array', team: t1 });
  ctx().robots.responses.set('/wecom/limited', { body: { errcode: 45009, errmsg: 'api freq out of limit' } });
  ctx().robots.responses.set('/feishu/old', { body: { StatusCode: 0, StatusMessage: 'success', Extra: null } });
  ctx().robots.responses.set('/wecom/html', { status: 502, raw: '<html>bad gateway</html>' });
  ctx().robots.responses.set('/dingtalk/array', { body: [0] });
  ctx().robots.delays.set('/dingtalk/slow', 1000);
  HTTP_TIMEOUT.webhook = 300;
  await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], before: 0 });
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 1, failed: 4 });
  strictEqual((await hookRow(a)).last_status, '45009 api freq out of limit');
  strictEqual((await hookRow(c)).last_status, 'ok');
  strictEqual((await hookRow(d)).last_status, 'HTTP 502 <html>bad gateway</html>');
  strictEqual((await hookRow(e)).last_status, 'timeout');
  strictEqual((await hookRow(f)).last_status, 'HTTP 200 [0]');
});

test('阶段过滤：只发机器人勾了的阶段；每个阶段最多一次；逾期也受 push_overdue_max 限制', async () => {
  const t1 = await b.team('一班');
  await b.person('张三', { team: t1, bind: false });
  const dueOnly = await b.webhook({ kind: 'wecom', path: '/wecom/due', team: t1, stages: ['due'] });
  const all = await b.webhook({ kind: 'wecom', path: '/wecom/all', team: t1, stages: ['pre', 'due', 'overdue'] });
  const preOverdue = await b.webhook({ kind: 'wecom', path: '/wecom/po', team: t1, stages: ['pre', 'overdue'] });
  await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], before: 15, repeat: 30 });
  for (const t of ['16:45', '16:50', '17:00', '17:05', '17:30', '18:00', '18:30', '19:00']) await run(sh(`2026-10-09 ${t}`));
  const stagesOf = async (id: string) => (await logRows(ctx().sql)).filter((r) => r.webhook_id === id).map((r) => r.stage);
  deepStrictEqual(await stagesOf(dueOnly), ['due']);
  deepStrictEqual(await stagesOf(all), ['pre', 'due', 'overdue#1', 'overdue#2']);
  deepStrictEqual(await stagesOf(preOverdue), ['pre', 'overdue#1', 'overdue#2']);
  strictEqual(ctx().robots.callsTo('/wecom/all').length, 4);
  const texts = ctx().robots.callsTo('/wecom/all').map((c) => (c.body.text as { content: string }).content.split('\n')[1]);
  deepStrictEqual(texts, [
    '时间：10月9日 周五 17:00（即将到期）',
    '时间：10月9日 周五 17:00（已到期）',
    '时间：10月9日 周五 17:00（已逾期）',
    '时间：10月9日 周五 17:00（已逾期）',
  ]);
});

test('阶段过滤：一开始就晚了，只看最晚的阶段（勾了 pre 但没勾 due 的机器人不补发过时的「即将到期」）', async () => {
  const t1 = await b.team('一班');
  await b.person('张三', { team: t1, bind: false });
  await b.webhook({ kind: 'wecom', path: '/wecom/pre', team: t1, stages: ['pre'] });
  await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], before: 15, repeat: 30 });
  await run(sh('2026-10-09 17:02'));
  strictEqual(ctx().robots.calls.length, 0);
});

test('归属：指派了小组 → 这些小组的机器人；没指派小组：「全体」→ team_id 为空的；小组可见 → 提醒所属小组的；私人的不发；停用的不发', async () => {
  const t1 = await b.team('一班');
  const t2 = await b.team('二班');
  const t3 = await b.team('三班');
  const zhang = await b.person('张三', { team: t1, bind: false });
  await b.person('李四', { team: t2, bind: false });
  await b.webhook({ kind: 'wecom', path: '/wecom/t1', team: t1 });
  await b.webhook({ kind: 'wecom', path: '/wecom/t2', team: t2 });
  await b.webhook({ kind: 'wecom', path: '/wecom/t3', team: t3 });
  await b.webhook({ kind: 'wecom', path: '/wecom/org', team: null });
  await b.webhook({ kind: 'wecom', path: '/wecom/off', team: t1, enabled: false });
  const at = sh('2026-10-09 17:00');
  await b.reminder({ title: '一二班', due: at, teams: [t1, t2], visibility: 'company', team: t3, before: 0 });
  await b.reminder({ title: '全体', due: at, visibility: 'company', before: 0 });
  await b.reminder({ title: '三班的', due: at, visibility: 'team', team: t3, before: 0 });
  await b.reminder({ title: '指派个人', due: at, users: [zhang.id], visibility: 'team', team: t2, before: 0 });
  await b.reminder({ title: '私人', due: at, visibility: 'private', before: 0 });
  await run(at);
  const got = ctx().robots.calls.map((c) => `${c.path} ${(c.body.text as { content: string }).content.split('\n')[0].slice(5)}`).sort();
  deepStrictEqual(got, [
    '/wecom/org 全体',
    '/wecom/t1 一二班',
    '/wecom/t2 一二班',
    '/wecom/t2 指派个人', // 只指派了人（没指派小组）：按提醒所属的小组
    '/wecom/t3 三班的',
  ]);
});

test('each 模式：每个小组的群只列自己组里还没完成的人（含兼任）；这个组都完成了就不发；全都完成了都不发', async () => {
  const t1 = await b.team('一班');
  const t2 = await b.team('二班');
  const zhang = await b.person('张三', { team: t1, bind: false, phone: '13800000001' });
  const li = await b.person('李四', { team: t2, teams: [t1], bind: false, phone: '13800000002' }); // 兼任一班
  const wang = await b.person('王五', { team: t2, bind: false });
  await b.webhook({ kind: 'wecom', path: '/wecom/t1', team: t1, stages: ['due', 'overdue'] });
  await b.webhook({ kind: 'wecom', path: '/wecom/t2', team: t2, stages: ['due', 'overdue'] });
  const due = sh('2026-10-09 17:00');
  const rid = await b.reminder({ due, teams: [t1, t2], mode: 'each', before: 0, repeat: 30 });
  await b.complete(rid, due, wang.id);
  await run(due);
  const line = (path: string) => ctx().robots.callsTo(path).map((c) => (c.body.text as { content: string }).content.split('\n')[2]);
  deepStrictEqual(line('/wecom/t1'), ['还没完成：李四、张三（共 2 人）']);
  deepStrictEqual(line('/wecom/t2'), ['还没完成：李四（共 1 人）']);
  deepStrictEqual(ctx().robots.callsTo('/wecom/t2')[0].body.text, {
    content: (ctx().robots.callsTo('/wecom/t2')[0].body.text as { content: string }).content,
    mentioned_mobile_list: ['13800000002'],
  });
  // 李四完成了：二班的群这次不发（组里都完成了），一班还剩张三
  await b.complete(rid, due, li.id);
  await run(sh('2026-10-09 17:30'));
  deepStrictEqual(line('/wecom/t1'), ['还没完成：李四、张三（共 2 人）', '还没完成：张三（共 1 人）']);
  strictEqual(ctx().robots.callsTo('/wecom/t2').length, 1);
  await b.complete(rid, due, zhang.id);
  await run(sh('2026-10-09 18:00'));
  strictEqual(ctx().robots.calls.length, 3, '都完成了');
});

test('each 模式没指派：「全体」列全部成员（不含创建人）；any 模式列直接指派的人、任一人完成就不发', async () => {
  const t1 = await b.team('一班');
  const zhang = await b.person('张三', { team: t1, bind: false });
  const li = await b.person('李四', { team: t1, bind: false });
  await b.person('前台电脑', { station: true, bind: false });
  await b.webhook({ kind: 'wecom', path: '/wecom/org', team: null });
  await b.webhook({ kind: 'wecom', path: '/wecom/t1', team: t1 });
  const at = sh('2026-10-09 17:00');
  await b.reminder({ title: '交回执', due: at, visibility: 'company', mode: 'each', before: 0 });
  await b.reminder({ title: '值日', due: at, visibility: 'team', team: t1, users: [zhang.id], mode: 'any', before: 0 });
  const done = await b.reminder({ title: '已完成的', due: at, visibility: 'team', team: t1, users: [li.id], mode: 'any', before: 0 });
  await b.complete(done, at, zhang.id);
  await run(at);
  const body = (path: string) =>
    ctx().robots.callsTo(path).map((c) => (c.body.text as { content: string }).content.split('\n').slice(0, 3));
  deepStrictEqual(body('/wecom/org'), [['【叮一下】交回执', '时间：10月9日 周五 17:00（已到期）', '还没完成：李四、张三（共 2 人）']]);
  deepStrictEqual(body('/wecom/t1'), [['【叮一下】值日', '时间：10月9日 周五 17:00（已到期）', '负责：张三']]);
});

test('去重：同一个机器人同一个阶段连跑两次只发一次；两个机器人各发各的', async () => {
  const t1 = await b.team('一班');
  await b.person('张三', { team: t1, bind: false });
  const a = await b.webhook({ kind: 'wecom', path: '/wecom/a', team: t1 });
  const c = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/c', team: t1 });
  const rid = await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], before: 0 });
  await run(sh('2026-10-09 17:00'));
  await run(sh('2026-10-09 17:01'));
  deepStrictEqual(ctx().robots.calls.map((x) => x.path).sort(), ['/dingtalk/c', '/wecom/a']);
  const keys = (await logRows(ctx().sql)).map((r) => r.dedupe_key).sort();
  deepStrictEqual(keys, [a, c].map((id) => `webhook|${id}|${rid}|${sh('2026-10-09 17:00').toISOString()}|due`).sort());
});

test('限流：每个机器人每次最多发 15 条，多的不记录、下一分钟接着发；同一个机器人的消息之间有间隔', async () => {
  const t1 = await b.team('一班');
  await b.person('张三', { team: t1, bind: false });
  const id = await b.webhook({ kind: 'dingtalk', path: '/dingtalk/busy', team: t1 });
  const other = await b.webhook({ kind: 'feishu', path: '/feishu/other', team: t1 });
  for (let i = 0; i < 20; i++) await b.reminder({ title: `第${i}条`, due: sh('2026-10-09 17:00'), teams: [t1], before: 0, repeat: 0 });
  const r1 = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r1.sent, deferred: r1.deferred }, { sent: 30, deferred: 10 }, '两个机器人各 15 条');
  strictEqual((await logRows(ctx().sql)).length, 30);
  const { LIMITS } = await import('../../../supabase/functions/_shared/notify/run.ts');
  LIMITS.webhookGapMs = 60;
  const r2 = await run(sh('2026-10-09 17:01'));
  deepStrictEqual({ sent: r2.sent, deferred: r2.deferred }, { sent: 10, deferred: 0 });
  const busy = ctx().robots.callsTo('/dingtalk/busy');
  strictEqual(new Set(busy.map((c) => (c.body.text as { content: string }).content.split('\n')[0])).size, 20);
  const second = busy.slice(15).map((c) => c.at);
  ok(second.slice(1).every((t, i) => t - second[i] >= 50), `间隔：${second.slice(1).map((t, i) => t - second[i]).join(', ')}`);
  for (const w of [id, other]) strictEqual((await logRows(ctx().sql)).filter((x) => x.webhook_id === w).length, 20);
});

test('时间预算用完：还没开始的发送留给下一分钟（不记录）', async () => {
  const { LIMITS } = await import('../../../supabase/functions/_shared/notify/run.ts');
  const saved = { ...LIMITS };
  try {
    const t1 = await b.team('一班');
    const zhang = await b.person('张三', { team: t1 });
    await b.prefs(zhang.id, { dnd: false });
    await b.webhook({ kind: 'wecom', path: '/wecom/t1', team: t1 });
    await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], before: 0, repeat: 0 });
    LIMITS.timeBudgetMs = -1;
    const r1 = await run(sh('2026-10-09 17:00'));
    deepStrictEqual({ sent: r1.sent, deferred: r1.deferred }, { sent: 0, deferred: 2 });
    strictEqual((await logRows(ctx().sql)).length, 0);
    Object.assign(LIMITS, saved);
    const r2 = await run(sh('2026-10-09 17:01'));
    deepStrictEqual({ sent: r2.sent, deferred: r2.deferred }, { sent: 2, deferred: 0 });
  } finally {
    Object.assign(LIMITS, saved);
  }
});

test('免打扰、稍后提醒、服务号设置不影响群机器人', async () => {
  const t1 = await b.team('一班');
  const zhang = await b.person('张三', { team: t1 });
  await b.prefs(zhang.id, { wechat: false, dnd: true, from: '00:00', to: '23:59' });
  await b.webhook({ kind: 'wecom', path: '/wecom/t1', team: t1 });
  const due = sh('2026-10-11 17:00'); // 周日
  const rid = await b.reminder({ due, teams: [t1], before: 0, skipHolidays: false });
  await b.snooze(rid, zhang.id, due, sh('2026-10-11 18:00'));
  await run(due);
  strictEqual(ctx().robots.calls.length, 1);
  strictEqual(ctx().wechat.sent.length, 0);
});
