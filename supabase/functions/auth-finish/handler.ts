// auth-finish（POST，公开）：客户端拿 id + secret 取登录结果（docs/架构.md §6.3）。
// pending → { status: 'pending' }（桌面版每 2 秒问一次）
// done → { status: 'done', token_hash, type }（只给一次）；加绑 → { status: 'done', linked: true }
// error → { status: 'error', error: <代码> }
// 不存在 / secret 不对 / 过期 / 已经取过 → 404 not_found（几种情况不区分，免得被拿来试 id）
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { parseRequestId, safeEqual, sha256Hex } from '../_shared/oauth/params.ts';
import { loadRequest, takeResult } from '../_shared/oauth/requests.ts';
import { asLoginErrorCode } from '../_shared/oauth/types.ts';

export default serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson<unknown>(req);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const id = parseRequestId(b.id);
  const secret = typeof b.secret === 'string' ? b.secret : '';
  if (!id || !secret || secret.length > 256) throw new HttpError(400, 'invalid_request');

  const hash = await sha256Hex(secret);
  const r = await loadRequest(id);
  if (!r || !safeEqual(r.secret_hash, hash) || r.status === 'used' || r.finish_expired) throw new HttpError(404, 'not_found');

  if (r.status === 'pending') {
    // 回调抢到了请求却 2 分钟没处理完（函数中途挂了）：不让桌面版一直等到 10 分钟
    return json(req, r.stale_claim ? { status: 'error', error: 'internal' } : { status: 'pending' });
  }
  if (r.status === 'error') return json(req, { status: 'error', error: asLoginErrorCode(r.error) });

  const t = await takeResult(r.id);
  if (!t) throw new HttpError(404, 'not_found'); // 同时来的另一次调用先取走了
  if (t.link_user_id) return json(req, { status: 'done', linked: true });
  if (!t.token_hash) throw new Error(`login request ${r.id}: done without token`);
  return json(req, { status: 'done', token_hash: t.token_hash, type: t.token_type || 'magiclink' });
});
