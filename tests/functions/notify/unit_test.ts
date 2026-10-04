// 不碰数据库的部分：阶段计算、模板字段截断、群消息正文、手机号、加签（固定时间戳）、成功判断、服务号验签和 XML。
// 签名的期望值是用 Python（hmac / hashlib）独立算出来的，不是拿被测代码自己算的。
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { latestStage, snoozeStage, stagePoints } from '../../../supabase/functions/_shared/notify/plan.ts';
import { chatText, chatTime, normalizeMobile, templateTime } from '../../../supabase/functions/_shared/notify/content.ts';
import { clipChars, errText, randomToken, safeEqual, scrubUrls, withDeadline } from '../../../supabase/functions/_shared/notify/util.ts';
import { setTimeZone } from '../../../supabase/functions/_shared/core/types.ts';
import { buildWebhookRequest, dingtalkSign, feishuSign, webhookResponseOk } from '../../../supabase/functions/_shared/webhooks.ts';
import {
  checkMpSignature,
  mpSignature,
  mpTextReply,
  parseMpXml,
  parseTemplateFields,
  templateData,
  wxErrorText,
} from '../../../supabase/functions/_shared/wechat-mp.ts';
import { sh } from './harness.ts';

setTimeZone('Asia/Shanghai');

const R = { remind_before_min: 15, overdue_repeat_min: 30 };
const due = sh('2026-10-09 17:00');
const at = (local: string) => sh(local);
const names = (pts: { stage: string }[]) => pts.map((p) => p.stage);

Deno.test('阶段：提前 → 到点 → 逾期第 1 / 2 次，超过上限不再有', () => {
  deepStrictEqual(names(stagePoints(R, due, at('2026-10-09 16:00'), 2)), ['pre', 'due']);
  deepStrictEqual(names(stagePoints(R, due, at('2026-10-09 17:29'), 2)), ['pre', 'due']);
  deepStrictEqual(names(stagePoints(R, due, at('2026-10-09 17:30'), 2)), ['pre', 'due', 'overdue#1']);
  deepStrictEqual(names(stagePoints(R, due, at('2026-10-09 18:00'), 2)), ['pre', 'due', 'overdue#1', 'overdue#2']);
  deepStrictEqual(names(stagePoints(R, due, at('2026-10-09 23:00'), 2)), ['pre', 'due', 'overdue#1', 'overdue#2'], '最多 2 次');
  deepStrictEqual(names(stagePoints(R, due, at('2026-10-09 23:00'), 0)), ['pre', 'due'], 'push_overdue_max = 0：逾期不催');
  deepStrictEqual(
    names(stagePoints({ remind_before_min: 0, overdue_repeat_min: 0 }, due, at('2026-10-09 23:00'), 5)),
    ['due'],
    '准时、不重复',
  );
  const pts = stagePoints(R, due, at('2026-10-09 18:10'), 2);
  deepStrictEqual(
    pts.map((p) => p.at),
    [at('2026-10-09 16:45'), due, at('2026-10-09 17:30'), at('2026-10-09 18:00')].map((d) => d.getTime()),
  );
  deepStrictEqual(pts.map((p) => p.kind), ['pre', 'due', 'overdue', 'overdue']);
});

Deno.test('阶段：只取已经到点的最晚那个；超过 12 小时就什么都不发', () => {
  const pick = (now: string) => latestStage(stagePoints(R, due, at(now), 2), at(now))?.stage ?? null;
  strictEqual(pick('2026-10-09 16:44'), null);
  strictEqual(pick('2026-10-09 16:45'), 'pre');
  strictEqual(pick('2026-10-09 16:59'), 'pre');
  strictEqual(pick('2026-10-09 17:00'), 'due');
  strictEqual(pick('2026-10-09 17:31'), 'overdue#1', '一开始就晚了：只发最晚的，不补 pre / due');
  strictEqual(pick('2026-10-10 05:59'), 'overdue#2', '11 小时 59 分');
  strictEqual(pick('2026-10-10 06:00'), null, '最晚的 overdue#2（18:00）也满 12 小时了');
});

Deno.test('稍后提醒的阶段：到期前 = 即将到期，到期后 = 已逾期，key 里带 until', () => {
  const s1 = snoozeStage(at('2026-10-09 16:55'), due);
  deepStrictEqual([s1.kind, s1.stage], ['pre', `snooze:${at('2026-10-09 16:55').toISOString()}`]);
  strictEqual(snoozeStage(at('2026-10-09 17:00'), due).kind, 'due');
  strictEqual(snoozeStage(at('2026-10-09 17:40'), due).kind, 'overdue');
  const pts = [...stagePoints(R, due, at('2026-10-09 17:41'), 2), snoozeStage(at('2026-10-09 17:40'), due)];
  strictEqual(latestStage(pts, at('2026-10-09 17:41'))?.stage, `snooze:${at('2026-10-09 17:40').toISOString()}`);
  pts.push(...stagePoints(R, due, at('2026-10-09 18:00'), 2).slice(3));
  strictEqual(latestStage(pts, at('2026-10-09 18:00'))?.stage, 'overdue#2', '稍后提醒之后又到了下一次催办');
});

Deno.test('模板字段：解析映射，按前缀截断，空值填「无」', () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
  const fields = parseTemplateFields(
    'title=thing1, time=time2，stage=phrase3,team=thing4,creator=name5,note=character_string6,bogus=thing9,title=',
  );
  deepStrictEqual(fields.map((f) => `${f.name}=${f.key}`), [
    'title=thing1',
    'time=time2',
    'stage=phrase3',
    'team=thing4',
    'creator=name5',
    'note=character_string6',
  ]);
  console.warn = warn;
  strictEqual(warnings.length, 2, '看不懂的两项各警告一次');
  const data = templateData(fields, {
    title: '交物理实验报告（第三章：牛顿第二定律的验证实验，附数据表）',
    time: templateTime(sh('2026-10-04 08:30')),
    stage: '即将到期了啊啊啊',
    team: '',
    creator: '欧阳娜娜娜娜娜娜娜娜娜娜',
    note: 'abcdefghijklmnopqrstuvwxyz0123456789',
  });
  deepStrictEqual(data, {
    thing1: { value: '交物理实验报告（第三章：牛顿第二定律的…' },
    time2: { value: '2026年10月04日 08:30' },
    phrase3: { value: '即将到期了' },
    thing4: { value: '无' },
    name5: { value: '欧阳娜娜娜娜娜娜娜娜' },
    character_string6: { value: 'abcdefghijklmnopqrstuvwxyz012345' },
  });
  strictEqual(Array.from(data.thing1.value).length, 20);
  // emoji 按一个字算，不会被切成半个
  strictEqual(clipChars('😀'.repeat(25), 20, true), '😀'.repeat(19) + '…');
  // 纯英文的名字可以到 20 个字符；空的 character_string 填「-」
  deepStrictEqual(templateData(fields, { title: '', time: '', stage: '', team: '', creator: 'Alexander Hamilton Jr.', note: '' }), {
    thing1: { value: '无' },
    time2: { value: '无' },
    phrase3: { value: '无' },
    thing4: { value: '无' },
    name5: { value: 'Alexander Hamilton J' },
    character_string6: { value: '-' },
  });
  // character_string 不收中文：去掉；全是中文 → 「-」
  strictEqual(
    templateData(fields, { title: '', time: '', stage: '', team: '', creator: '', note: '作业 HW-3 第二题' }).character_string6.value,
    'HW-3',
  );
  strictEqual(
    templateData(fields, { title: '', time: '', stage: '', team: '', creator: '', note: '第三章习题' }).character_string6.value,
    '-',
  );
});

Deno.test('群消息正文：标题、时间（周几）、还没完成的人、链接', () => {
  const now = sh('2026-10-09 17:00');
  strictEqual(chatTime(sh('2026-10-09 17:00'), now), '10月9日 周五 17:00');
  strictEqual(chatTime(sh('2027-01-04 08:05'), now), '2027年1月4日 周一 08:05', '不是今年的带年份');
  strictEqual(
    chatText({
      title: '交物理实验报告',
      at: sh('2026-10-09 17:00'),
      now,
      stage: 'due',
      pending: ['张三', '李四', '王五'],
      url: 'https://pling.example.cn/?r=abc&o=2026-10-09T09:00:00.000Z',
    }),
    '【叮一下】交物理实验报告\n时间：10月9日 周五 17:00（已到期）\n还没完成：张三、李四、王五（共 3 人）\n查看：https://pling.example.cn/?r=abc&o=2026-10-09T09:00:00.000Z',
  );
  strictEqual(
    chatText({ title: '周会', at: sh('2026-10-09 16:45'), now, stage: 'pre', owners: ['李四'], url: '' }),
    '【叮一下】周会\n时间：10月9日 周五 16:45（即将到期）\n负责：李四',
  );
  strictEqual(
    chatText({ title: '周会', at: sh('2026-10-09 16:00'), now, stage: 'overdue', url: '' }),
    '【叮一下】周会\n时间：10月9日 周五 16:00（已逾期）',
  );
});

Deno.test('手机号：去空格横线和 +86，不像手机号的不要', () => {
  strictEqual(normalizeMobile('138 0013 8000'), '13800138000');
  strictEqual(normalizeMobile('+86 138-0013-8000'), '13800138000');
  strictEqual(normalizeMobile('0086（138）00138000'), '13800138000');
  strictEqual(normalizeMobile('+49 151 23456789'), '+4915123456789');
  strictEqual(normalizeMobile(''), null);
  strictEqual(normalizeMobile('找我'), null);
});

Deno.test('钉钉加签 / 飞书签名：固定时间戳，和 Python 算的一样', async () => {
  strictEqual(await dingtalkSign('SEC0123456789abcdef', 1700000000000), 'TSZbRFUuvaSQaRKUpF970OPCb2/LcQAP3wOvwZIzBZk=');
  strictEqual(await feishuSign('feishu-secret-xyz', 1700000000), 'RpXbw7bncheMXKEHLeETmnhcqsBrZOUBOwyPTuLV4ic=');

  const ding = await buildWebhookRequest(
    { kind: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: 'SEC0123456789abcdef' },
    { text: '【叮一下】测试', mobiles: ['13800138000', '13800138000', '13900139000'] },
    1700000000000,
  );
  strictEqual(
    ding.url,
    'https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=1700000000000&sign=TSZbRFUuvaSQaRKUpF970OPCb2%2FLcQAP3wOvwZIzBZk%3D',
  );
  deepStrictEqual(ding.body, {
    msgtype: 'text',
    text: { content: '【叮一下】测试\n@13800138000 @13900139000' },
    at: { atMobiles: ['13800138000', '13900139000'], isAtAll: false },
  });

  const feishu = await buildWebhookRequest(
    { kind: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz', secret: 'feishu-secret-xyz' },
    { text: '【叮一下】测试', mobiles: ['13800138000'] },
    1700000000999,
  );
  deepStrictEqual(feishu, {
    url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz',
    body: {
      msg_type: 'text',
      content: { text: '【叮一下】测试' },
      timestamp: '1700000000',
      sign: 'RpXbw7bncheMXKEHLeETmnhcqsBrZOUBOwyPTuLV4ic=',
    },
  });

  const wecom = await buildWebhookRequest(
    { kind: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', secret: 'ignored' },
    { text: '【叮一下】测试', mobiles: ['13800138000'] },
  );
  deepStrictEqual(wecom, {
    url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k',
    body: { msgtype: 'text', text: { content: '【叮一下】测试', mentioned_mobile_list: ['13800138000'] } },
  });

  const plain = await buildWebhookRequest({ kind: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: '' }, {
    text: 'x',
  });
  strictEqual(plain.url, 'https://oapi.dingtalk.com/robot/send?access_token=abc', '没配密钥不加签');
  deepStrictEqual((plain.body.at as { atMobiles: string[] }).atMobiles, []);
});

Deno.test('机器人回应：企业微信 / 钉钉看 errcode，飞书看 code（老接口 StatusCode）', () => {
  deepStrictEqual(webhookResponseOk('wecom', { errcode: 0, errmsg: 'ok' }), { ok: true, status: 'ok' });
  deepStrictEqual(webhookResponseOk('wecom', { errcode: 93000, errmsg: 'invalid webhook url' }), {
    ok: false,
    status: '93000 invalid webhook url',
  });
  deepStrictEqual(webhookResponseOk('dingtalk', { errcode: 0 }), { ok: true, status: 'ok' });
  deepStrictEqual(webhookResponseOk('dingtalk', { errcode: 310000, errmsg: 'sign not match' }), {
    ok: false,
    status: '310000 sign not match',
  });
  deepStrictEqual(webhookResponseOk('feishu', { code: 0, msg: 'success' }), { ok: true, status: 'ok' });
  deepStrictEqual(webhookResponseOk('feishu', { StatusCode: 0, StatusMessage: 'success' }), { ok: true, status: 'ok' });
  deepStrictEqual(webhookResponseOk('feishu', { code: 19021, msg: 'sign match fail' }), { ok: false, status: '19021 sign match fail' });
  strictEqual(webhookResponseOk('feishu', { errcode: 0 }).ok, false, '飞书不认 errcode');
  strictEqual(webhookResponseOk('wecom', { code: 0 }).ok, false, '企业微信不认 code');
});

Deno.test('服务号验签：和 Python 算的一样；缺参数 / 不对都是 false', async () => {
  strictEqual(await mpSignature('mp-token-test', '1700000000', 'nonce123'), '539947e60cb911baaf9d3c6ff2d61441d1db5ef8');
  ok(await checkMpSignature('mp-token-test', '539947e60cb911baaf9d3c6ff2d61441d1db5ef8', '1700000000', 'nonce123'));
  ok(await checkMpSignature('mp-token-test', '539947E60CB911BAAF9D3C6FF2D61441D1DB5EF8', '1700000000', 'nonce123'));
  ok(!(await checkMpSignature('mp-token-test', '539947e60cb911baaf9d3c6ff2d61441d1db5ef9', '1700000000', 'nonce123')));
  ok(!(await checkMpSignature('', '539947e60cb911baaf9d3c6ff2d61441d1db5ef8', '1700000000', 'nonce123')), '没配 Token 一律不通过');
  ok(!(await checkMpSignature('mp-token-test', '', '1700000000', 'nonce123')));
});

Deno.test('服务号 XML：解析 CDATA / 纯文字 / 实体，回复用 CDATA', () => {
  const m = parseMpXml(
    '<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[o-abc]]></FromUserName><CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event><EventKey><![CDATA[qrscene_bind_x]]></EventKey>' +
      '<Content>a &lt;b&gt; &amp; c</Content><Ticket><![CDATA[]]></Ticket></xml>',
  );
  deepStrictEqual(m, {
    ToUserName: 'gh_1',
    FromUserName: 'o-abc',
    CreateTime: '1700000000',
    MsgType: 'event',
    Event: 'subscribe',
    EventKey: 'qrscene_bind_x',
    Content: 'a <b> & c',
    Ticket: '',
  });
  deepStrictEqual(parseMpXml('<xml><ToUserName><![CDATA[gh]]></ToUserName><Encrypt><![CDATA[abc==]]></Encrypt></xml>'), {
    ToUserName: 'gh',
    Encrypt: 'abc==',
  });
  deepStrictEqual(parseMpXml('not xml'), {});
  strictEqual(
    mpTextReply('o-abc', 'gh_1', '已绑定「张三」]]>', 1700000000500),
    '<xml><ToUserName><![CDATA[o-abc]]></ToUserName><FromUserName><![CDATA[gh_1]]></FromUserName><CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[已绑定「张三」]]]]><![CDATA[>]]></Content></xml>',
  );
});

Deno.test('小工具：随机串、定长比较、错误信息不带网址参数、超时兜底', async () => {
  const t = randomToken(20);
  ok(/^[a-z0-9]{20}$/.test(t), t);
  ok(randomToken(20) !== t);
  ok(safeEqual('abc', 'abc'));
  ok(!safeEqual('abc', 'abd'));
  ok(!safeEqual('abc', 'abcd'));
  strictEqual(
    scrubUrls('error sending request for url (https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRETKEY): timed out'),
    'error sending request for url (https://qyapi.weixin.qq.com/…): timed out',
  );
  strictEqual(errText(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'timeout');
  strictEqual(errText(new TypeError('fetch failed')), 'network: fetch failed');
  strictEqual(wxErrorText(43004, 'require subscribe'), '43004 require subscribe（没有关注服务号）');
  strictEqual(wxErrorText(40164, 'invalid ip 1.2.3.4'), '40164 invalid ip 1.2.3.4（服务器 IP 不在服务号的 IP 白名单里）');
  strictEqual(await withDeadline(new Promise<string>((r) => setTimeout(() => r('late'), 200)), 20, 'fallback'), 'fallback');
  strictEqual(await withDeadline(Promise.resolve('fast'), 200, 'fallback'), 'fast');
  const realError = console.error;
  console.error = () => {};
  try {
    strictEqual(await withDeadline(Promise.reject(new Error('boom')), 200, 'fallback'), 'fallback');
  } finally {
    console.error = realError;
  }
  await new Promise((r) => setTimeout(r, 250)); // 等上面那个 200ms 的 setTimeout 跑完（Deno 会检查测试结束时还挂着的计时器）
});
