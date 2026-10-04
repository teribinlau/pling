// wechat-bind：已激活的成员要一个「扫码关注服务号 = 绑定」的二维码。
// 建一个 bind_<20 位随机串> 的场景（10 分钟有效），调 /cgi-bin/qrcode/create（QR_STR_SCENE，600 秒）。
// 扫码后微信把 subscribe / SCAN 事件推给 wechat-mp，那边按场景值写 wechat_bindings；客户端订阅 / 轮询自己的绑定。
// 返回 { qrUrl, expiresAt }。详见 docs/架构.md §6.5。
import { requireMember } from '../_shared/auth.ts';
import { db } from '../_shared/db.ts';
import { cfg } from '../_shared/env.ts';
import { HttpError, json, serve } from '../_shared/http.ts';
import { errText, randomToken } from '../_shared/notify/util.ts';
import { mpConfigured, WechatMp } from '../_shared/wechat-mp.ts';

export const BIND_TTL_SECONDS = 600;

export default serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const me = await requireMember(req);
  // 没有 Token 的话消息服务器验不了签，扫了码也绑不上：一样当作没配
  if (!mpConfigured() || !cfg.wechatMp().token) throw new HttpError(400, 'wechat_mp_disabled', '服务器没有配置微信服务号');

  const sql = db();
  const scene = `bind_${randomToken(20)}`;
  const [ticket] = await sql<{ expires_at: Date }[]>`
    insert into public.wechat_bind_tickets (scene, user_id, expires_at)
    values (${scene}, ${me.id}, now() + ${BIND_TTL_SECONDS}::int * interval '1 second')
    returning expires_at`;
  try {
    const qr = await new WechatMp(sql).createQrCode(scene, BIND_TTL_SECONDS);
    return json(req, { qrUrl: qr.qrUrl, expiresAt: ticket.expires_at.toISOString() });
  } catch (e) {
    await sql`delete from public.wechat_bind_tickets where scene = ${scene}`.catch(() => {});
    const why = errText(e);
    console.error(`wechat-bind: 生成二维码失败：${why}`);
    throw new HttpError(502, 'wechat_error', `微信接口出错：${why}`);
  }
});
