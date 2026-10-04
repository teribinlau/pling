// notify：真的数据库 + 假的微信接口。阶段、接收人、跳过规则、节假日 / 调休、去重、并发。
// 时间都是假的「现在」（run(now)）；2026-10-09 是周五（国庆后），10-10 是调休上班的周六，10-01–07 国庆放假。
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { HTTP_TIMEOUT } from '../../../supabase/functions/_shared/notify/util.ts';
import { callNotify, logRows, makeBuilders, run, setupNotifyTests, sh, test, wxSent } from './harness.ts';
import { TEST } from './fakes.ts';

const ctx = setupNotifyTests();
const b = makeBuilders(ctx);

// 都关掉免打扰，单独测免打扰的地方再打开
async function noDnd(...ids: string[]) {
  for (const id of ids) await b.prefs(id, { dnd: false });
}

test('notify：口令不对 / 没带 → 401；没配口令（空）时谁来都 401；GET → 405', async () => {
  strictEqual((await callNotify({})).status, 401);
  strictEqual((await callNotify({ 'x-cron-secret': 'wrong' })).status, 401);
  strictEqual((await callNotify({ 'x-cron-secret': TEST.cronSecret }, 'GET')).status, 405);
  Deno.env.set('PLING_CRON_SECRET', '');
  strictEqual((await callNotify({ 'x-cron-secret': '' })).status, 401, '空口令不算');
  strictEqual((await callNotify({ 'x-cron-secret': TEST.cronSecret })).status, 401);
  strictEqual((await logRows(ctx().sql)).length, 0);
});

test('notify：口令对 → 跑一次，返回 { sent, failed, skipped }；模板消息的内容和链接', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  const due = new Date(Math.floor(Date.now() / 60000) * 60000 + 10 * 60000); // 10 分钟后到期，提前 15 分钟 → 现在是 pre
  const rid = await b.reminder({ title: '交物理实验报告', due, users: [zhang.id], notes: '\n  第三章习题\n第二行' });
  const res = await callNotify();
  strictEqual(res.status, 200);
  const body = await res.json();
  deepStrictEqual(body, { sent: 1, failed: 0, skipped: 0, deferred: 0 });
  strictEqual(ctx().wechat.sent.length, 1);
  const m = ctx().wechat.sent[0];
  strictEqual(m.touser, zhang.openid);
  strictEqual(m.template_id, TEST.mp.templateId);
  strictEqual(m.url, `${TEST.publicUrl}/?r=${rid}&o=${due.toISOString()}`);
  deepStrictEqual(Object.keys(m.data).sort(), ['name5', 'phrase3', 'thing1', 'thing4', 'thing6', 'time2']);
  strictEqual(m.data.thing1.value, '交物理实验报告');
  strictEqual(m.data.phrase3.value, '即将到期');
  match(m.data.time2.value, /^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}$/);
  strictEqual(m.data.name5.value, '王老师', '创建人');
  strictEqual(m.data.thing6.value, '第三章习题', '备注第一行（空行跳过）');
  strictEqual(m.data.thing4.value, '无', '个人提醒没有小组');
});

test('阶段：提前 → 到点 → 逾期第 1 / 2 次 → 超过上限不再发；每个阶段只发一次', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  const due = sh('2026-10-09 17:00');
  const rid = await b.reminder({ due, users: [zhang.id], before: 15, repeat: 30 });
  const steps: Array<[string, string | null]> = [
    ['2026-10-09 16:40', null],
    ['2026-10-09 16:45', '即将到期'],
    ['2026-10-09 16:50', null],
    ['2026-10-09 17:00', '已到期'],
    ['2026-10-09 17:10', null],
    ['2026-10-09 17:30', '已逾期'],
    ['2026-10-09 17:45', null],
    ['2026-10-09 18:00', '已逾期'],
    ['2026-10-09 18:30', null],
    ['2026-10-09 20:00', null],
  ];
  for (const [now, want] of steps) {
    const before = ctx().wechat.sent.length;
    const r = await run(sh(now));
    const got = ctx().wechat.sent.slice(before).map((s) => s.data.phrase3.value);
    deepStrictEqual(got, want ? [want] : [], `${now}`);
    strictEqual(r.sent, want ? 1 : 0, `${now}`);
  }
  const rows = await logRows(ctx().sql);
  deepStrictEqual(rows.map((r) => r.stage), ['pre', 'due', 'overdue#1', 'overdue#2']);
  deepStrictEqual(
    rows.map((r) => r.dedupe_key),
    ['pre', 'due', 'overdue#1', 'overdue#2'].map((s) => `wechat|${zhang.id}|${rid}|${due.toISOString()}|${s}`),
  );
  ok(
    rows.every((r) =>
      r.status === 'sent' && r.channel === 'wechat' && r.reminder_id === rid && r.occurrence_at?.getTime() === due.getTime()
    ),
  );
});

test('阶段：push_overdue_max 可调（0 = 逾期不催，5 = 催 5 次）', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  const due = sh('2026-10-09 17:00');
  await b.reminder({ due, users: [zhang.id], before: 0, repeat: 10 });
  await b.settings({ push_overdue_max: 0 });
  for (const t of ['17:00', '17:10', '17:20']) await run(sh(`2026-10-09 ${t}`));
  deepStrictEqual(wxSent(ctx()).map((x) => x[1]), ['已到期']);
  await b.settings({ push_overdue_max: 5 });
  for (let m = 30; m <= 120; m += 10) await run(sh(`2026-10-09 ${17 + Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`));
  const stages = (await logRows(ctx().sql)).map((r) => r.stage);
  // 17:10 / 17:20 那两次在上限为 0 时没发；上限改成 5 之后只发「最晚的那个」，不补 overdue#1 / #2
  deepStrictEqual(stages, ['due', 'overdue#3', 'overdue#4', 'overdue#5']);
});

test('阶段：一开始就晚了只发最晚的那个；12 小时以前的不补', async () => {
  const zhang = await b.person('张三');
  const li = await b.person('李四');
  await noDnd(zhang.id, li.id);
  const due = sh('2026-10-09 09:00');
  await b.reminder({ title: '早上的', due, users: [zhang.id], before: 15, repeat: 30 });
  await b.reminder({ title: '昨天的', due: sh('2026-10-08 20:00'), users: [li.id], before: 15, repeat: 30 });
  // 09:47：pre（08:45）、due（09:00）、overdue#1（09:30）都到点了 → 只发 overdue#1；昨天 20:00 的最晚是 overdue#2（21:00），已经 12 小时 47 分
  const r = await run(sh('2026-10-09 09:47'));
  deepStrictEqual(wxSent(ctx()), [[zhang.openid, '已逾期']]);
  strictEqual(r.sent, 1);
  deepStrictEqual((await logRows(ctx().sql)).map((x) => x.stage), ['overdue#1']);
});

test('接收人：指派的人 + 指派小组的成员（含兼任）；工位账号、未激活的人不发', async () => {
  const t1 = await b.team('高一（1）班');
  const t2 = await b.team('高一（2）班');
  const zhang = await b.person('张三', { team: t1 });
  const li = await b.person('李四', { team: t2, teams: [t1] }); // 兼任 1 班
  const wang = await b.person('王五', { team: t2 });
  const zhao = await b.person('赵六'); // 直接指派
  const station = await b.person('教室电脑', { team: t1, station: true });
  const newbie = await b.person('新同学', { team: t1, active: false });
  await noDnd(zhang.id, li.id, wang.id, zhao.id, station.id, newbie.id);
  await b.reminder({ due: sh('2026-10-09 17:00'), teams: [t1], users: [zhao.id], before: 0 });
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual(wxSent(ctx()).map((x) => x[0]).sort(), [zhang.openid, li.openid, zhao.openid].sort());
});

test('接收人：既直接指派又在指派的小组里 → 只发一条；重复提醒的每一次到期分开算', async () => {
  const t1 = await b.team('一班');
  const zhang = await b.person('张三', { team: t1 });
  await b.prefs(zhang.id, { dnd: false });
  // 半年前建的每天 08:00 的提醒（due_at 很早，照样展开到今天）
  const rid = await b.reminder({
    title: '每天',
    due: sh('2026-04-01 08:00'),
    rrule: 'FREQ=DAILY',
    skipHolidays: false,
    users: [zhang.id],
    teams: [t1],
    before: 0,
    repeat: 0,
  });
  await run(sh('2026-10-09 08:00'));
  await run(sh('2026-10-10 08:00'));
  strictEqual(ctx().wechat.sent.length, 2);
  deepStrictEqual((await logRows(ctx().sql)).map((r) => r.occurrence_at?.toISOString()), [
    sh('2026-10-09 08:00').toISOString(),
    sh('2026-10-10 08:00').toISOString(),
  ]);
  // 完成了 10 号那次，不影响 11 号那次
  await b.complete(rid, sh('2026-10-10 08:00'), zhang.id);
  await run(sh('2026-10-11 08:00'));
  strictEqual(ctx().wechat.sent.length, 3);
});

test('接收人：没指派 →「全体」可见发给全部成员，小组 / 私人的只发给创建人', async () => {
  const t1 = await b.team('一班');
  const zhang = await b.person('张三', { team: t1 });
  const li = await b.person('李四');
  const creator = await b.person('陈老师', { team: t1 });
  const station = await b.person('前台电脑', { station: true });
  await noDnd(zhang.id, li.id, creator.id, station.id, ctx().admin.id);
  // 管理员没绑定服务号，收不到
  await b.reminder({ title: '全体大会', due: sh('2026-10-09 17:00'), visibility: 'company', before: 0, repeat: 0, by: creator.id });
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual(wxSent(ctx()).map((x) => x[0]).sort(), [zhang.openid, li.openid, creator.openid].sort());

  ctx().wechat.sent = [];
  await b.reminder({ title: '小组的', due: sh('2026-10-09 18:00'), visibility: 'team', team: t1, before: 0, repeat: 0, by: creator.id });
  await b.reminder({ title: '私人的', due: sh('2026-10-09 18:00'), visibility: 'private', before: 0, repeat: 0, by: zhang.id });
  await run(sh('2026-10-09 18:00'));
  deepStrictEqual(
    ctx().wechat.sent.map((s) => [s.touser, s.data.thing1.value]).sort(),
    [
      [creator.openid, '小组的'],
      [zhang.openid, '私人的'],
    ].sort(),
  );
});

test('跳过：any 模式有人完成就都不发；each 模式只跳过本人完成的（工位账号代点按名字算）', async () => {
  const t1 = await b.team('一班');
  const zhang = await b.person('张三', { team: t1 });
  const li = await b.person('李四', { team: t1 });
  const wang = await b.person('王五', { team: t1 });
  const station = await b.person('教室电脑', { team: t1, station: true, bind: false });
  await noDnd(zhang.id, li.id, wang.id);
  const due = sh('2026-10-09 17:00');
  const any = await b.reminder({ title: '任一人', due, teams: [t1], before: 0, mode: 'any' });
  const each = await b.reminder({ title: '每个人', due, teams: [t1], before: 0, mode: 'each' });
  await b.complete(any, due, li.id);
  await b.complete(each, due, zhang.id);
  await b.complete(each, due, station.id, '王五'); // 王五在教室电脑上点的完成
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual(ctx().wechat.sent.map((s) => [s.touser, s.data.thing1.value]), [[li.openid, '每个人']]);
});

test('跳过：完成记录的时间差一点（< 1 分钟）也算这一次的', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  const due = sh('2026-10-09 17:00');
  const rid = await b.reminder({ due, users: [zhang.id], before: 0 });
  await b.complete(rid, new Date(due.getTime() + 30000), zhang.id);
  await run(sh('2026-10-09 17:00'));
  strictEqual(ctx().wechat.sent.length, 0);
});

test('稍后提醒：没到 until 不发；until 过了发一次（key 带 snooze:<until>），之后接着按逾期催', async () => {
  const zhang = await b.person('张三');
  const li = await b.person('李四');
  await noDnd(zhang.id, li.id);
  const due = sh('2026-10-09 17:00');
  const rid = await b.reminder({ due, users: [zhang.id, li.id], before: 0, repeat: 30 });
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual(wxSent(ctx()).map((x) => x[0]).sort(), [zhang.openid, li.openid].sort());
  // 张三点了「稍后 10 分钟」，17:05 → 17:15
  const until = sh('2026-10-09 17:15');
  await b.snooze(rid, zhang.id, due, until);
  ctx().wechat.sent = [];
  await run(sh('2026-10-09 17:14'));
  strictEqual(ctx().wechat.sent.length, 0, '还没到');
  await run(sh('2026-10-09 17:15'));
  deepStrictEqual(wxSent(ctx()), [[zhang.openid, '已逾期']]);
  await run(sh('2026-10-09 17:20'));
  strictEqual(ctx().wechat.sent.length, 1, '只发一次');
  // 17:30 是 overdue#1：两个人都要催（张三的稍后已经过了）
  await run(sh('2026-10-09 17:30'));
  deepStrictEqual(wxSent(ctx()).slice(1).map((x) => x[0]).sort(), [zhang.openid, li.openid].sort());
  const keys = (await logRows(ctx().sql)).filter((r) => r.user_id === zhang.id).map((r) => r.stage);
  deepStrictEqual(keys, ['due', `snooze:${until.toISOString()}`, 'overdue#1']);

  // 再稍后到 18:20：18:00 的 overdue#2 不发给张三（还在稍后），李四照发
  await b.snooze(rid, zhang.id, due, sh('2026-10-09 18:20'));
  ctx().wechat.sent = [];
  await run(sh('2026-10-09 18:00'));
  deepStrictEqual(wxSent(ctx()), [[li.openid, '已逾期']]);
  await run(sh('2026-10-09 18:20'));
  deepStrictEqual(wxSent(ctx()).slice(1), [[zhang.openid, '已逾期']]);
});

test('稍后提醒：到期前就点了稍后（提前提醒之后），until 在到期前 → 显示「即将到期」，到点照样提醒', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  const due = sh('2026-10-09 17:00');
  const rid = await b.reminder({ due, users: [zhang.id], before: 30, repeat: 0 });
  await run(sh('2026-10-09 16:30'));
  await b.snooze(rid, zhang.id, due, sh('2026-10-09 16:40'));
  await run(sh('2026-10-09 16:35'));
  await run(sh('2026-10-09 16:40'));
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual(wxSent(ctx()).map((x) => x[1]), ['即将到期', '即将到期', '已到期']);
});

test('跳过：没绑定、取消关注、关了服务号消息、服务号没配模板', async () => {
  const a = await b.person('没绑定', { bind: false });
  const c = await b.person('取消关注', { subscribed: false });
  const d = await b.person('关了');
  const e = await b.person('正常');
  await noDnd(a.id, c.id, e.id);
  await b.prefs(d.id, { wechat: false, dnd: false });
  await b.reminder({ due: sh('2026-10-09 17:00'), users: [a.id, c.id, d.id, e.id], before: 0 });
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual(wxSent(ctx()).map((x) => x[0]), [e.openid]);
  deepStrictEqual({ sent: r.sent, skipped: r.skipped }, { sent: 1, skipped: 1 }, '关了的算 skipped；没绑定 / 取消关注的根本发不了，不算');

  // 没配模板 id：服务号整个不发（也不去拿令牌），不报错
  Deno.env.delete('WECHAT_MP_TEMPLATE_ID');
  ctx().wechat.sent = [];
  await b.reminder({ due: sh('2026-10-09 18:00'), users: [e.id], before: 0 });
  const r2 = await run(sh('2026-10-09 18:00'));
  strictEqual(ctx().wechat.sent.length, 0);
  strictEqual(ctx().wechat.tokenCalls.length, 1, '只有第一次运行拿过令牌');
  deepStrictEqual({ sent: r2.sent, failed: r2.failed }, { sent: 0, failed: 0 });
});

test('免打扰：默认 21:30–07:00 和周末 / 法定假日不发，调休上班的周六照发', async () => {
  const zhang = await b.person('张三'); // 没有 notify_prefs → 默认值
  const li = await b.person('李四');
  await b.prefs(li.id, { dnd: true, from: '12:00', to: '13:30', restDays: false });
  const mk = (local: string) =>
    b.reminder({ title: local, due: sh(local), users: [zhang.id, li.id], before: 0, repeat: 0, skipHolidays: false });
  await mk('2026-10-05 10:00'); // 国庆（周一）：张三免打扰
  await mk('2026-10-09 12:30'); // 周五中午：李四免打扰
  await mk('2026-10-09 22:00'); // 周五晚上：张三免打扰
  await mk('2026-10-10 10:00'); // 周六但调休上班：都发
  await mk('2026-10-11 10:00'); // 周日：张三免打扰（周末）
  // 按时间顺序跑；返回这一次收到的 [谁, 哪一条]
  const sentAt = async (local: string) => {
    ctx().wechat.sent = [];
    await run(sh(local));
    const who = (openid: string) => (openid === zhang.openid ? '张三' : '李四');
    return ctx().wechat.sent.map((s) => `${who(s.touser)} ${s.data.thing1.value.slice(5)}`).sort();
  };
  deepStrictEqual(await sentAt('2026-10-05 10:00'), ['李四 10-05 10:00']);
  deepStrictEqual(await sentAt('2026-10-09 12:30'), ['张三 10-09 12:30']);
  // 免打扰里没发的不记录：免打扰一结束、还在 12 小时以内就补发（发的是那时候最晚的阶段）
  deepStrictEqual(await sentAt('2026-10-09 13:29'), []);
  deepStrictEqual(await sentAt('2026-10-09 13:30'), ['李四 10-09 12:30']);
  deepStrictEqual(await sentAt('2026-10-09 22:00'), ['李四 10-09 22:00']);
  deepStrictEqual(await sentAt('2026-10-10 06:59'), []);
  deepStrictEqual(await sentAt('2026-10-10 07:00'), ['张三 10-09 22:00'], '周六调休上班，07:00 免打扰结束');
  deepStrictEqual(await sentAt('2026-10-10 10:00'), ['张三 10-10 10:00', '李四 10-10 10:00']);
  deepStrictEqual(await sentAt('2026-10-11 10:00'), ['李四 10-11 10:00']);
  deepStrictEqual(await sentAt('2026-10-12 07:00'), [], '周日那条到周一早上已经超过 12 小时');
  const rows = await logRows(ctx().sql);
  deepStrictEqual([rows.filter((r) => r.user_id === zhang.id).length, rows.filter((r) => r.user_id === li.id).length], [3, 5]);
});

test('节假日：「跳过节假日」的重复提醒放假不展开，「每个工作日」在调休上班的周六照样提醒', async () => {
  const zhang = await b.person('张三');
  await b.prefs(zhang.id, { dnd: false });
  // 每个工作日 08:00，从 9 月开始
  await b.reminder({
    title: '晨读',
    due: sh('2026-09-01 08:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    users: [zhang.id],
    before: 0,
    repeat: 0,
  });
  await b.reminder({
    title: '每天',
    due: sh('2026-09-01 08:00'),
    rrule: 'FREQ=DAILY',
    skipHolidays: false,
    users: [zhang.id],
    before: 0,
    repeat: 0,
  });
  const titlesAt = async (local: string) => {
    ctx().wechat.sent = [];
    await run(sh(local));
    return ctx().wechat.sent.map((s) => s.data.thing1.value).sort();
  };
  deepStrictEqual(await titlesAt('2026-10-05 08:00'), ['每天'], '国庆放假：晨读跳过');
  deepStrictEqual(await titlesAt('2026-10-09 08:00'), ['晨读', '每天'], '周五');
  deepStrictEqual(await titlesAt('2026-10-10 08:00'), ['晨读', '每天'], '调休上班的周六');
  deepStrictEqual(await titlesAt('2026-10-11 08:00'), ['每天'], '周日');
});

test('机构时区：app_settings.timezone 换了，到期时间、免打扰都按它算', async () => {
  const zhang = await b.person('张三');
  await b.settings({ timezone: 'Europe/Berlin' });
  // 默认免打扰（21:30–07:00 + 周末）按柏林时间：上海 2026-10-09 15:00 = 柏林 09:00 周五 → 不在免打扰里
  await b.reminder({
    title: '每天柏林 9 点',
    due: new Date('2026-10-01T07:00:00Z'),
    rrule: 'FREQ=DAILY',
    skipHolidays: false,
    users: [zhang.id],
    before: 0,
    repeat: 0,
  });
  await run(new Date('2026-10-09T07:00:00Z'));
  strictEqual(ctx().wechat.sent.length, 1);
  match(ctx().wechat.sent[0].data.time2.value, /^2026年10月09日 09:00$/, '模板里的时间也是柏林时间');
});

test('归档的提醒、窗口外的提醒不发', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  await b.reminder({ due: sh('2026-10-09 17:00'), users: [zhang.id], before: 0, archived: true });
  await b.reminder({ due: sh('2026-10-11 17:00'), users: [zhang.id], before: 15 });
  await run(sh('2026-10-09 17:00'));
  strictEqual(ctx().wechat.sent.length, 0);
});

test('去重：连跑两次只发一次', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  await b.reminder({ due: sh('2026-10-09 17:00'), users: [zhang.id], before: 0 });
  const r1 = await run(sh('2026-10-09 17:00'));
  const r2 = await run(new Date(sh('2026-10-09 17:00').getTime() + 40000));
  strictEqual(ctx().wechat.sent.length, 1);
  deepStrictEqual([r1.sent, r2.sent], [1, 0]);
  strictEqual((await logRows(ctx().sql)).length, 1);
});

test('去重：两次运行同时算出同一批 → 每条只发一次（不拿锁，靠 dedupe_key）', async () => {
  const people = [];
  for (let i = 0; i < 6; i++) people.push(await b.person(`同学${i}`));
  await noDnd(...people.map((p) => p.id));
  await b.reminder({ due: sh('2026-10-09 17:00'), users: people.map((p) => p.id), before: 0 });
  ctx().wechat.sendDelayMs = 50;
  const [a, c] = await Promise.all([run(sh('2026-10-09 17:00'), { skipLock: true }), run(sh('2026-10-09 17:00'), { skipLock: true })]);
  strictEqual(ctx().wechat.sent.length, 6);
  strictEqual(new Set(ctx().wechat.sent.map((s) => s.touser)).size, 6);
  strictEqual(a.sent + c.sent, 6);
  strictEqual(a.skipped + c.skipped, 6, '另一边插不进记录的算 skipped');
  strictEqual((await logRows(ctx().sql)).length, 6);
});

test('并发：一次运行没跑完时，另一次拿不到锁 → { skipped: "busy" }', async () => {
  const zhang = await b.person('张三');
  await noDnd(zhang.id);
  await b.reminder({ due: new Date(Date.now() - 60000), users: [zhang.id], before: 0 });
  ctx().wechat.sendDelayMs = 400;
  const first = callNotify();
  await new Promise((r) => setTimeout(r, 150));
  const second = await callNotify();
  deepStrictEqual(await second.json(), { skipped: 'busy' });
  const r1 = await (await first).json();
  strictEqual(r1.sent, 1);
  // 跑完放锁了，再跑一次能进去（没有新的要发）
  const third = await (await callNotify()).json();
  deepStrictEqual({ sent: third.sent, failed: third.failed }, { sent: 0, failed: 0 });
});

test('发失败：记录改成 failed + 错误信息，不自动重试；一个人失败不影响别人', async () => {
  const zhang = await b.person('张三');
  const li = await b.person('李四');
  const wang = await b.person('王五');
  await noDnd(zhang.id, li.id, wang.id);
  ctx().wechat.sendErrors.set(li.openid, { errcode: 47003, errmsg: 'argument invalid! data.thing1.value invalid' });
  ctx().wechat.slow.set(wang.openid, 1000);
  HTTP_TIMEOUT.wechat = 300;
  await b.reminder({ due: sh('2026-10-09 17:00'), users: [zhang.id, li.id, wang.id], before: 0 });
  const r = await run(sh('2026-10-09 17:00'));
  deepStrictEqual({ sent: r.sent, failed: r.failed }, { sent: 1, failed: 2 });
  deepStrictEqual(wxSent(ctx()), [[zhang.openid, '已到期']]);
  const rows = await logRows(ctx().sql);
  const by = (id: string) => rows.find((x) => x.user_id === id)!;
  strictEqual(by(zhang.id).status, 'sent');
  strictEqual(by(li.id).status, 'failed');
  strictEqual(by(li.id).error, '47003 argument invalid! data.thing1.value invalid（模板字段不对，检查 WECHAT_MP_TEMPLATE_FIELDS）');
  strictEqual(by(wang.id).status, 'failed');
  strictEqual(by(wang.id).error, 'timeout');
  // 下一分钟不重试
  ctx().wechat.sendErrors.clear();
  ctx().wechat.slow.clear();
  const r2 = await run(sh('2026-10-09 17:01'));
  deepStrictEqual({ sent: r2.sent, failed: r2.failed }, { sent: 0, failed: 0 });
});

test('跑完调 pling_cleanup()：30 天前的发送记录、过期的缓存被清掉', async () => {
  const s = ctx().sql;
  await s`insert into public.notification_log (dedupe_key, channel, stage, status, created_at)
          values ('old', 'wechat', 'due', 'sent', now() - interval '31 days'), ('new', 'wechat', 'due', 'sent', now() - interval '29 days')`;
  await s`insert into public.kv_cache (key, value, expires_at) values ('stale', 'x', now() - interval '2 days'), ('fresh', 'y', now() + interval '1 hour')`;
  await run(sh('2026-10-09 17:00'));
  deepStrictEqual((await s<{ dedupe_key: string }[]>`select dedupe_key from public.notification_log order by 1`).map((r) => r.dedupe_key), [
    'new',
  ]);
  deepStrictEqual((await s<{ key: string }[]>`select key from public.kv_cache order by 1`).map((r) => r.key), ['fresh']);
});
