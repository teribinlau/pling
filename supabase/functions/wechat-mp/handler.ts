// wechat-mp：服务号「服务器配置」的地址（公开）。只支持明文模式 / 兼容模式。
//   GET   验签后原样返回 echostr（微信后台保存配置时校验）
//   POST  验签（失败 403）→ 解析 XML：
//         subscribe + EventKey qrscene_bind_<x> / SCAN + EventKey bind_<x>  → 按 wechat_bind_tickets 绑定，回「已绑定「张三」…」
//         unsubscribe → 这个 openid 的 subscribed = false
//         其他关注（已绑定的人重新关注 → subscribed 改回 true）/ 用户发来的消息 → 回一条带应用链接的文字
//         其他事件（菜单、模板消息送达回执……）→ success
// 微信要求 5 秒内回应，不然会重试三次并提示用户「该公众号暂时无法提供服务」：处理超过 4.5 秒就先回 success（处理在后台接着做）。
// 详见 docs/架构.md §6.4。
import { db } from '../_shared/db.ts';
import { cfg } from '../_shared/env.ts';
import { serve, text } from '../_shared/http.ts';
import { withDeadline } from '../_shared/notify/util.ts';
import { checkMpSignature, mpTextReply, parseMpXml } from '../_shared/wechat-mp.ts';

const DEADLINE_MS = 4500;
const MAX_BODY_BYTES = 64 * 1024;
const SCENE = /^bind_[a-z0-9]{20}$/;
/** 用户发来的消息（不是事件）：回一条带链接的说明 */
const USER_MESSAGES = new Set(['text', 'image', 'voice', 'video', 'shortvideo', 'location', 'link']);

const success = () => text('success');
const xml = (body: string) => text(body, 200, 'application/xml; charset=utf-8');

export default serve(async (req: Request): Promise<Response> => {
  const q = new URL(req.url).searchParams;
  const token = cfg.wechatMp().token;
  if (!token) console.warn('wechat-mp: 没配 WECHAT_MP_TOKEN，验不了签');
  const ok = await checkMpSignature(token, q.get('signature') ?? '', q.get('timestamp') ?? '', q.get('nonce') ?? '');
  if (req.method === 'GET') return ok ? text(q.get('echostr') ?? '') : text('forbidden', 403);
  if (req.method !== 'POST') return text('method not allowed', 405);
  if (!ok) return text('forbidden', 403);

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return success();
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return success();
  const msg = parseMpXml(raw);
  if (!msg.MsgType) {
    if (msg.Encrypt) {
      console.warn('wechat-mp: 收到安全模式（只有密文）的消息，没处理。请在服务号后台把「消息加解密方式」改成明文模式或兼容模式');
    }
    return success();
  }
  const work = handleMessage(msg);
  // 超时先回 success 的话，让 edge-runtime 等后台的处理做完再回收 worker（Deno 本身没有这个 API，就是普通的 promise 接着跑）
  (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(work.catch(() => null));
  const reply = await withDeadline(work, DEADLINE_MS, null);
  return reply ? xml(reply) : success();
});

/** 处理一条消息，返回被动回复的 XML；null = 回 success */
async function handleMessage(msg: Record<string, string>): Promise<string | null> {
  const openid = msg.FromUserName ?? '';
  const mpId = msg.ToUserName ?? '';
  if (!openid) return null;
  const say = (content: string) => mpTextReply(openid, mpId, content);
  try {
    if (msg.MsgType === 'event') {
      const event = (msg.Event ?? '').toLowerCase();
      const key = msg.EventKey ?? '';
      if (event === 'unsubscribe') {
        await db()`update public.wechat_bindings set subscribed = false where openid = ${openid}`;
        return null;
      }
      if (event === 'subscribe' || event === 'scan') {
        const scene = event === 'subscribe' ? (key.startsWith('qrscene_') ? key.slice('qrscene_'.length) : '') : key;
        if (scene.startsWith('bind_')) return say(await bind(openid, scene));
        // 已经绑定的人重新关注 / 扫了别的码：确认还关注着
        const name = await markSubscribed(openid);
        if (event === 'subscribe') return say(name ? welcomeBack(name) : welcome());
        return say(help(name));
      }
      return null;
    }
    if (USER_MESSAGES.has(msg.MsgType)) return say(help(await boundName(openid)));
    return null;
  } catch (e) {
    console.error('wechat-mp: 处理消息失败', e);
    return say('出了点问题，请稍后再试。');
  }
}

/** 按场景值绑定；返回要回给用户的话 */
async function bind(openid: string, scene: string): Promise<string> {
  const expired = '二维码已过期，请在叮一下的「设置 → 通知」里重新生成。';
  if (!SCENE.test(scene)) return expired;
  return await db().begin(async (tx) => {
    const tickets = await tx<{ user_id: string; expired: boolean; used: boolean }[]>`
      select user_id, expires_at <= now() as expired, used_at is not null as used
        from public.wechat_bind_tickets where scene = ${scene} for update`;
    if (!tickets.length) return expired;
    const t = tickets[0];
    const [p] = await tx<{ name: string }[]>`select name from public.profiles where id = ${t.user_id}`;
    if (!p) return expired;
    if (t.used) {
      // 微信重发的同一个事件（或者本人又扫了一次）：照样回绑定成功
      const [b] = await tx<{ openid: string }[]>`select openid from public.wechat_bindings where user_id = ${t.user_id}`;
      return b?.openid === openid ? bound(p.name) : '这个二维码已经用过了，请在叮一下的「设置 → 通知」里重新生成。';
    }
    if (t.expired) return expired;
    // 这个微信原来绑在别的账号上 → 挪过来（unionid / 昵称跟着微信走）
    const [prev] = await tx<{ user_id: string; unionid: string; nickname: string }[]>`
      select user_id, unionid, nickname from public.wechat_bindings where openid = ${openid}`;
    if (prev && prev.user_id !== t.user_id) await tx`delete from public.wechat_bindings where openid = ${openid}`;
    await tx`
      insert into public.wechat_bindings (user_id, openid, unionid, subscribed, nickname)
      values (${t.user_id}, ${openid}, ${prev?.unionid ?? ''}, true, ${prev?.nickname ?? ''})
      on conflict (user_id) do update
        set openid = excluded.openid, unionid = excluded.unionid, nickname = excluded.nickname, subscribed = true, bound_at = now()`;
    await tx`update public.wechat_bind_tickets set used_at = now() where scene = ${scene}`;
    return bound(p.name);
  });
}

/** 已绑定的人：subscribed 改回 true，返回绑定的姓名；没绑定返回 null */
async function markSubscribed(openid: string): Promise<string | null> {
  const rows = await db()<{ name: string }[]>`
    update public.wechat_bindings b set subscribed = true
      from public.profiles p
     where b.openid = ${openid} and p.id = b.user_id
    returning p.name`;
  return rows.length ? rows[0].name : null;
}

async function boundName(openid: string): Promise<string | null> {
  const rows = await db()<{ name: string }[]>`
    select p.name from public.wechat_bindings b join public.profiles p on p.id = b.user_id where b.openid = ${openid}`;
  return rows.length ? rows[0].name : null;
}

function appLink(): string {
  const url = cfg.publicUrl();
  return url ? `打开叮一下：${url}/` : '';
}

function lines(...xs: string[]): string {
  return xs.filter(Boolean).join('\n');
}

function bound(name: string): string {
  return `已绑定「${name || '你的账号'}」，以后的提醒会发到这里。在叮一下的「设置 → 通知」里可以随时解绑。`;
}

function welcome(): string {
  return lines('感谢关注叮一下。', '在叮一下的「设置 → 通知」里扫码绑定后，提醒会发到这里。', appLink());
}

function welcomeBack(name: string): string {
  return lines(`欢迎回来，「${name || '你的账号'}」的提醒会继续发到这里。`, appLink());
}

function help(name: string | null): string {
  return name
    ? lines(`这里会收到「${name}」的提醒。`, appLink())
    : lines('这里是叮一下的提醒通知。在叮一下的「设置 → 通知」里扫码绑定后，提醒会发到这里。', appLink());
}
