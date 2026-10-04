// 微信服务号：access_token（stable_token，缓存在 kv_cache）、模板消息、带参数二维码、消息服务器的验签和 XML。
// 所有发往微信的请求都带超时；接口地址可以用 WECHAT_API_BASE 换成测试用的假服务器。
import { cfg } from './env.ts';
import { db, type Sql } from './db.ts';
import { clipChars, HTTP_TIMEOUT, safeEqual, scrubUrls, sha1Hex } from './notify/util.ts';

/** 令牌失效：40001 不是最新的 / 40014 不合法 / 42001 过期 → 刷新令牌重试一次 */
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);
/** 用户没关注服务号（或取消关注了），模板消息发不出去 */
export const ERR_NOT_SUBSCRIBED = 43004;

/** 常见错误码的中文说明（写进发送记录、notify-test 的回应，给管理员排查） */
const WX_HINTS: Record<number, string> = {
  40001: '令牌失效',
  40003: 'openid 不对',
  40013: 'appid 不对',
  40037: '模板 id 不对',
  40125: '服务号密钥不对',
  40164: '服务器 IP 不在服务号的 IP 白名单里',
  42001: '令牌过期',
  43004: '没有关注服务号',
  45009: '超过接口每天的调用次数',
  47003: '模板字段不对，检查 WECHAT_MP_TEMPLATE_FIELDS',
  48001: '服务号没有这个接口的权限',
};

/** "43004 require subscribe（没有关注服务号）" */
export function wxErrorText(errcode: unknown, errmsg: unknown): string {
  const code = Number(errcode ?? -1);
  const hint = WX_HINTS[code];
  return clipChars(`${code} ${String(errmsg ?? '')}`.trim() + (hint ? `（${hint}）` : ''), 300);
}
/** 缓存比微信给的有效期早 5 分钟过期 */
const TOKEN_EARLY_SECONDS = 300;
export const QR_SHOW_URL = 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=';

/** 配了 appid + secret：能取令牌、生成绑定二维码 */
export function mpConfigured(): boolean {
  const c = cfg.wechatMp();
  return !!(c.appid && c.secret);
}

/** 再加上模板 id：能发提醒 */
export function mpPushConfigured(): boolean {
  return mpConfigured() && !!cfg.wechatMp().templateId;
}

export interface WxResult {
  errcode?: number;
  errmsg?: string;
  [k: string]: unknown;
}

export class WechatError extends Error {
  constructor(public errcode: number, public errmsg: string) {
    super(wxErrorText(errcode, errmsg));
  }
}

function tokenCacheKey(appid: string): string {
  return `wechat_mp_access_token:${appid}`;
}

/** 强制刷新令牌每天有次数限制（20 次）：一小时最多强制刷新一次 */
const FORCE_COOLDOWN = '1 hour';

/** 发往微信的 JSON 请求：超时、HTTP 错误、不是 JSON 都抛异常 */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT.wechat),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${clipChars(scrubUrls(raw), 100)}`.trim());
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`bad response: ${clipChars(scrubUrls(raw), 100)}`);
  }
}

/**
 * 服务号接口客户端。一次运行（一次请求）建一个：令牌在实例里记着，同一次运行里只取一次；
 * 跨运行、跨函数共享靠 kv_cache。
 */
export class WechatMp {
  private value: string | null = null;
  private pending: Promise<string> | null = null;
  /** 这个实例（一次运行）已经刷新过令牌了：再失效就不换了，免得每条消息都去刷新 */
  private refreshed = false;

  constructor(private readonly sql: Sql = db()) {}

  /** 当前的 access_token：先看实例里的，再看 kv_cache，都没有就向微信要 */
  token(): Promise<string> {
    if (this.value) return Promise.resolve(this.value);
    return this.pending ??= this.load(false, '').finally(() => (this.pending = null));
  }

  /**
   * failed 这个令牌被微信拒了：换一个。并发的几个请求同时失败时只刷新一次；
   * 这次运行已经刷新过了就不再换（返回 failed，调用方别再重试）
   */
  refresh(failed: string): Promise<string> {
    if (this.value && this.value !== failed) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    if (this.refreshed) return Promise.resolve(failed);
    this.refreshed = true;
    this.value = null;
    return this.pending = this.load(true, failed).finally(() => (this.pending = null));
  }

  private async load(refresh: boolean, failed: string): Promise<string> {
    const { appid } = cfg.wechatMp();
    const key = tokenCacheKey(appid);
    if (!refresh) {
      const rows = await this.sql<{ value: string }[]>`
        select value from public.kv_cache where key = ${key} and expires_at > now()`;
      if (rows.length) return (this.value = rows[0].value);
    }
    // 普通模式拿到的就是微信那边当前有效的令牌；还是刚被拒的那个时才强制刷新（会让旧令牌马上失效，每天有次数限制）
    let got = await this.fetchStable(false);
    if (refresh && got.token === failed && (await this.mayForceRefresh(appid))) got = await this.fetchStable(true);
    const ttl = got.expiresIn - TOKEN_EARLY_SECONDS;
    if (ttl > 0) {
      await this.sql`
        insert into public.kv_cache (key, value, expires_at)
        values (${key}, ${got.token}, now() + ${ttl}::int * interval '1 second')
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
    } else {
      await this.sql`delete from public.kv_cache where key = ${key}`;
    }
    return (this.value = got.token);
  }

  /** 拿「强制刷新」的许可：一小时内（所有函数一起算）只给一次 */
  private async mayForceRefresh(appid: string): Promise<boolean> {
    const key = `wechat_mp_force_refresh:${appid}`;
    const rows = await this.sql`
      insert into public.kv_cache (key, value, expires_at)
      values (${key}, '1', now() + ${FORCE_COOLDOWN}::interval)
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
        where public.kv_cache.expires_at <= now()
      returning key`;
    if (!rows.length) console.warn('wechat-mp: 令牌一直被拒，一小时内已经强制刷新过一次，这次不再刷新');
    return rows.length > 0;
  }

  private async fetchStable(force: boolean): Promise<{ token: string; expiresIn: number }> {
    const { appid, secret } = cfg.wechatMp();
    if (!appid || !secret) throw new WechatError(-1, 'wechat_mp_disabled');
    const data = await postJson<WxResult & { access_token?: string; expires_in?: number }>(
      `${cfg.wechatApiBase()}/cgi-bin/stable_token`,
      { grant_type: 'client_credential', appid, secret, force_refresh: force },
    );
    if (!data.access_token) throw new WechatError(data.errcode ?? -1, data.errmsg ?? 'no access_token');
    return { token: data.access_token, expiresIn: Number(data.expires_in) || 7200 };
  }

  /** 带令牌的 POST；令牌失效就刷新令牌重试一次。微信的 errcode 原样返回，调用方自己判断 */
  async post<T extends WxResult>(path: string, body: unknown): Promise<T> {
    const url = (token: string) => `${cfg.wechatApiBase()}${path}?access_token=${encodeURIComponent(token)}`;
    const token = await this.token();
    const data = await postJson<T>(url(token), body);
    if (!TOKEN_ERRORS.has(Number(data.errcode))) return data;
    const fresh = await this.refresh(token);
    if (fresh === token) return data; // 换不到新令牌：不用再试
    return await postJson<T>(url(fresh), body);
  }

  /** 模板消息。errcode 0 = 发出去了；43004 = 没关注 */
  sendTemplate(msg: { openid: string; templateId: string; url?: string; data: Record<string, { value: string }> }) {
    const body: Record<string, unknown> = { touser: msg.openid, template_id: msg.templateId, data: msg.data };
    if (msg.url) body.url = msg.url;
    return this.post<WxResult & { msgid?: number }>('/cgi-bin/message/template/send', body);
  }

  /** 临时带参数二维码（字符串场景值） */
  async createQrCode(scene: string, expireSeconds: number): Promise<{ ticket: string; expireSeconds: number; qrUrl: string }> {
    const data = await this.post<WxResult & { ticket?: string; expire_seconds?: number }>('/cgi-bin/qrcode/create', {
      expire_seconds: expireSeconds,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: scene } },
    });
    if (!data.ticket) throw new WechatError(Number(data.errcode ?? -1), String(data.errmsg ?? 'no ticket'));
    if (!/^[\w\-=+/]+$/.test(data.ticket)) throw new WechatError(-1, 'bad ticket');
    return {
      ticket: data.ticket,
      expireSeconds: Number(data.expire_seconds) || expireSeconds,
      qrUrl: QR_SHOW_URL + encodeURIComponent(data.ticket),
    };
  }
}

// ---------------------------------------------------------------------------
// 模板字段映射：WECHAT_MP_TEMPLATE_FIELDS = "title=thing1,time=time2,stage=phrase3"
// ---------------------------------------------------------------------------
export const DEFAULT_TEMPLATE_FIELDS = 'title=thing1,time=time2,stage=phrase3';
export const TEMPLATE_VALUE_NAMES = ['title', 'time', 'stage', 'team', 'creator', 'note'] as const;
export type TemplateValueName = (typeof TEMPLATE_VALUE_NAMES)[number];
export type TemplateValues = Record<TemplateValueName, string>;

export interface TemplateField {
  name: TemplateValueName;
  key: string; // 模板里的字段名，如 thing1
}

export function parseTemplateFields(spec: string): TemplateField[] {
  const out: TemplateField[] = [];
  for (const part of spec.split(/[,，;；\s]+/)) {
    if (!part) continue;
    const [name, key] = part.split('=').map((s) => s.trim());
    if (!(TEMPLATE_VALUE_NAMES as readonly string[]).includes(name) || !key || !/^[a-z_]+\d+$/i.test(key)) {
      console.warn(`WECHAT_MP_TEMPLATE_FIELDS: 看不懂「${part}」，跳过`);
      continue;
    }
    out.push({ name: name as TemplateValueName, key });
  }
  return out;
}

/**
 * 按字段名前缀截断：thing ≤ 20 字、phrase ≤ 5、name ≤ 10（纯英文 ≤ 20）、character_string ≤ 32（只收数字字母符号，别的字去掉）；
 * 空值填「无」（微信不收空值；character_string 填「-」）
 */
export function templateData(fields: TemplateField[], values: TemplateValues): Record<string, { value: string }> {
  const data: Record<string, { value: string }> = {};
  for (const f of fields) {
    const prefix = (/^([a-z_]+)\d+$/i.exec(f.key)?.[1] ?? '').toLowerCase();
    let v = (values[f.name] ?? '').replace(/\s+/g, ' ').trim();
    if (prefix === 'character_string') v = v.replace(/[^\x21-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!v) v = prefix === 'character_string' ? '-' : '无';
    if (prefix === 'thing') v = clipChars(v, 20, true);
    else if (prefix === 'phrase') v = clipChars(v, 5);
    else if (prefix === 'name') v = clipChars(v, /^[\x20-\x7e]*$/.test(v) ? 20 : 10);
    else if (prefix === 'character_string') v = clipChars(v, 32);
    data[f.key] = { value: v };
  }
  return data;
}

// ---------------------------------------------------------------------------
// 消息服务器（wechat-mp）：验签、解析 XML、被动回复
// ---------------------------------------------------------------------------

/** sha1(sort(token, timestamp, nonce).join('')) */
export function mpSignature(token: string, timestamp: string, nonce: string): Promise<string> {
  return sha1Hex([token, timestamp, nonce].sort().join(''));
}

export async function checkMpSignature(token: string, signature: string, timestamp: string, nonce: string): Promise<boolean> {
  if (!token || !signature || !timestamp || !nonce) return false;
  return safeEqual(await mpSignature(token, timestamp, nonce), signature.toLowerCase());
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 微信推过来的 XML 基本是一层平铺的：<xml><ToUserName><![CDATA[..]]></ToUserName><CreateTime>123</CreateTime>…</xml>。
 * 只取「<标签>CDATA 或纯文字</标签>」这样的叶子（同名的取第一个）；不用 XML 解析器，也就没有实体展开之类的问题
 */
export function parseMpXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = /<xml>([\s\S]*)<\/xml>/.exec(xml)?.[1] ?? '';
  for (const m of body.matchAll(/<([A-Za-z_][\w.-]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2] ?? unescapeXml((m[3] ?? '').trim());
  }
  return out;
}

function cdata(s: string): string {
  return `<![CDATA[${s.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/** 被动回复一条文字：发给 to（用户 openid），from 是服务号的原始 id */
export function mpTextReply(to: string, from: string, content: string, nowMs = Date.now()): string {
  return (
    `<xml><ToUserName>${cdata(to)}</ToUserName><FromUserName>${cdata(from)}</FromUserName>` +
    `<CreateTime>${Math.floor(nowMs / 1000)}</CreateTime><MsgType>${cdata('text')}</MsgType>` +
    `<Content>${cdata(content)}</Content></xml>`
  );
}
