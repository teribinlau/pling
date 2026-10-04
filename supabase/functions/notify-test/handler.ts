// notify-test：试发一条消息，看配置对不对。
//   { webhookId }   管理员：给这个群机器人发「【叮一下】测试消息：机器人配置成功」，同时更新 team_webhooks.last_at / last_status
//   { wechat: true } 任何已激活成员：给自己绑定的服务号发一条测试模板消息（没绑定 → 400 not_bound）
// 返回 { ok, error? }（发没发成功都是 200；请求本身不对才是 4xx）。详见 docs/架构.md §6.7。
import { requireAdmin, requireMember } from '../_shared/auth.ts';
import { db } from '../_shared/db.ts';
import { cfg } from '../_shared/env.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { setTimeZone, type WebhookKind } from '../_shared/core/types.ts';
import { templateTime, WEBHOOK_TEST_TEXT } from '../_shared/notify/content.ts';
import { errText } from '../_shared/notify/util.ts';
import { sendWebhook } from '../_shared/webhooks.ts';
import {
  DEFAULT_TEMPLATE_FIELDS,
  ERR_NOT_SUBSCRIBED,
  mpPushConfigured,
  parseTemplateFields,
  templateData,
  WechatMp,
  wxErrorText,
} from '../_shared/wechat-mp.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson<{ webhookId?: unknown; wechat?: unknown }>(req);
  if (body && typeof body.webhookId === 'string' && body.webhookId) {
    await requireAdmin(req);
    return json(req, await testWebhook(body.webhookId));
  }
  if (body && body.wechat === true) {
    const me = await requireMember(req);
    return json(req, await testWechat(me.id));
  }
  throw new HttpError(400, 'bad_request', '请求要带 { webhookId } 或 { wechat: true }');
});

async function testWebhook(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID.test(id)) throw new HttpError(404, 'not_found', '没有这个机器人');
  const sql = db();
  const rows = await sql<{ kind: WebhookKind; url: string; secret: string }[]>`
    select kind, url, secret from public.team_webhooks where id = ${id}`;
  if (!rows.length) throw new HttpError(404, 'not_found', '没有这个机器人');
  const r = await sendWebhook(rows[0], { text: WEBHOOK_TEST_TEXT });
  await sql`update public.team_webhooks set last_at = now(), last_status = ${r.status} where id = ${id}`;
  return r.ok ? { ok: true } : { ok: false, error: r.status };
}

async function testWechat(userId: string): Promise<{ ok: boolean; error?: string }> {
  if (!mpPushConfigured()) throw new HttpError(400, 'wechat_mp_disabled', '服务器没有配置服务号模板消息');
  const sql = db();
  const rows = await sql<{ openid: string; name: string; org_name: string; org_label: string; timezone: string }[]>`
    select b.openid, p.name, s.org_name, s.org_label, s.timezone
      from public.wechat_bindings b
      join public.profiles p on p.id = b.user_id
      left join public.app_settings s on s.id = 1
     where b.user_id = ${userId}`;
  if (!rows.length) throw new HttpError(400, 'not_bound', '还没有绑定服务号');
  const b = rows[0];
  setTimeZone(b.timezone);
  const mp = new WechatMp(sql);
  const fields = parseTemplateFields(cfg.wechatMp().templateFields || DEFAULT_TEMPLATE_FIELDS);
  const data = templateData(fields, {
    title: '测试消息：服务号通知已开通',
    time: templateTime(new Date()),
    stage: '测试',
    team: b.org_name || b.org_label || '',
    creator: b.name,
    note: '以后的提醒会发到这里',
  });
  try {
    const res = await mp.sendTemplate({
      openid: b.openid,
      templateId: cfg.wechatMp().templateId,
      url: cfg.publicUrl() ? `${cfg.publicUrl()}/` : '',
      data,
    });
    const code = Number(res.errcode ?? 0);
    if (code === 0) {
      // 发得出去就说明他关注着（取消关注又重新关注、我们没收到事件时，这里顺手改回来）
      await sql`update public.wechat_bindings set subscribed = true where user_id = ${userId} and openid = ${b.openid} and not subscribed`;
      return { ok: true };
    }
    if (code === ERR_NOT_SUBSCRIBED) {
      await sql`update public.wechat_bindings set subscribed = false where user_id = ${userId} and openid = ${b.openid}`;
    }
    return { ok: false, error: wxErrorText(code, res.errmsg) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
