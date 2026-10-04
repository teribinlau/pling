// 工作群机器人：企业微信 / 钉钉 / 飞书的消息格式、加签、判断成功。
//   企业微信  POST <url>                         { msgtype: 'text', text: { content, mentioned_mobile_list } }   成功 = errcode 0
//   钉钉      POST <url>&timestamp=<毫秒>&sign=…  { msgtype: 'text', text: { content }, at: { atMobiles } }      成功 = errcode 0
//   飞书      POST <url>                         { timestamp: <秒>, sign, msg_type: 'text', content: { text } }  成功 = code 0（老接口 StatusCode 0）
import type { WebhookKind } from './core/types.ts';
import { clipChars, errText, hmacSha256Base64, HTTP_TIMEOUT, scrubUrls } from './notify/util.ts';
/** 一条消息最多 @ 这么多人 */
export const MAX_MENTIONS = 50;

export interface WebhookTarget {
  kind: WebhookKind;
  url: string;
  secret: string;
}

export interface WebhookMessage {
  text: string;
  /** 要 @ 的手机号（已经整理好的） */
  mobiles?: string[];
}

export interface WebhookResult {
  ok: boolean;
  /** 'ok' 或错误信息（写进 team_webhooks.last_status / 发送记录） */
  status: string;
}

/** 钉钉加签：HMAC-SHA256(key = secret, data = timestamp + "\n" + secret) → base64 */
export function dingtalkSign(secret: string, timestampMs: number): Promise<string> {
  return hmacSha256Base64(secret, `${timestampMs}\n${secret}`);
}

/** 飞书签名：HMAC-SHA256(key = timestamp + "\n" + secret, data = "") → base64 */
export function feishuSign(secret: string, timestampSec: number): Promise<string> {
  return hmacSha256Base64(`${timestampSec}\n${secret}`, '');
}

/** 按 UTF-8 字节截断（企业微信的文字消息最多 2048 字节） */
function clipBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes - 3) break;
    out += ch;
    used += n;
  }
  return out + '…';
}

/** 拼出要发的请求（地址 + JSON），nowMs 用来算加签的时间戳（测试里固定） */
export async function buildWebhookRequest(
  t: WebhookTarget,
  msg: WebhookMessage,
  nowMs = Date.now(),
): Promise<{ url: string; body: Record<string, unknown> }> {
  const mobiles = [...new Set(msg.mobiles ?? [])].slice(0, MAX_MENTIONS);
  switch (t.kind) {
    case 'wecom': {
      const text: Record<string, unknown> = { content: clipBytes(msg.text, 2000) };
      if (mobiles.length) text.mentioned_mobile_list = mobiles;
      return { url: t.url, body: { msgtype: 'text', text } };
    }
    case 'dingtalk': {
      // 钉钉要在正文里也写上 @手机号，群里才显示成 @某人
      const content = mobiles.length ? `${msg.text}\n${mobiles.map((m) => `@${m}`).join(' ')}` : msg.text;
      let url = t.url;
      if (t.secret) {
        const sign = await dingtalkSign(t.secret, nowMs);
        url += `${url.includes('?') ? '&' : '?'}timestamp=${nowMs}&sign=${encodeURIComponent(sign)}`;
      }
      return { url, body: { msgtype: 'text', text: { content }, at: { atMobiles: mobiles, isAtAll: false } } };
    }
    case 'feishu': {
      // 飞书自定义机器人只能按 open_id @ 人，没有手机号的办法：只发文字
      const body: Record<string, unknown> = { msg_type: 'text', content: { text: msg.text } };
      if (t.secret) {
        const ts = Math.floor(nowMs / 1000);
        body.timestamp = String(ts);
        body.sign = await feishuSign(t.secret, ts);
      }
      return { url: t.url, body };
    }
  }
}

/** 判断机器人接口的回应：企业微信 / 钉钉看 errcode，飞书看 code（老接口是 StatusCode） */
export function webhookResponseOk(kind: WebhookKind, data: Record<string, unknown>): { ok: boolean; status: string } {
  if (kind === 'feishu') {
    const code = data.code ?? data.StatusCode;
    if (code === 0) return { ok: true, status: 'ok' };
    const msg = data.msg ?? data.StatusMessage ?? '';
    return { ok: false, status: `${code ?? '?'} ${msg}`.trim() };
  }
  if (data.errcode === 0) return { ok: true, status: 'ok' };
  return { ok: false, status: `${data.errcode ?? '?'} ${data.errmsg ?? ''}`.trim() };
}

/** 发一条。不抛异常：网络错误、超时、对方报错都在 status 里 */
export async function sendWebhook(t: WebhookTarget, msg: WebhookMessage, nowMs = Date.now()): Promise<WebhookResult> {
  try {
    const { url, body } = await buildWebhookRequest(t, msg, nowMs);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.webhook),
    });
    const raw = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* 不是 JSON */
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, status: clipChars(scrubUrls(`HTTP ${res.status} ${raw}`.trim()), 200) };
    }
    const r = webhookResponseOk(t.kind, data);
    if (!r.ok && !res.ok) r.status = `HTTP ${res.status} ${r.status}`;
    return { ok: r.ok, status: clipChars(scrubUrls(r.status), 200) };
  } catch (e) {
    return { ok: false, status: errText(e) };
  }
}
