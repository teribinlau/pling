// auth-callback（GET，公开）：微信 / QQ 授权完跳回来的地址（docs/架构.md §6.2）。
// ?code=…&state=<登录请求 id>；用户取消授权时没有 code。
// 回应：网页版 302 回应用（#pling-login=<id> / #pling-login-error=<代码>），桌面版显示中文结果页。
import { generateLoginToken } from '../_shared/gotrue.ts';
import { HttpError, serve } from '../_shared/http.ts';
import { loginEmail, resolveAccount } from '../_shared/oauth/account.ts';
import { appCredentials } from '../_shared/oauth/config.ts';
import { fetchIdentity, providerErrorCode } from '../_shared/oauth/exchange.ts';
import { type CallbackContext, callbackResponse, type ErrorOutcome, type Outcome } from '../_shared/oauth/page.ts';
import { parseRequestId } from '../_shared/oauth/params.ts';
import { cleanText, errorMessage, redact } from '../_shared/oauth/remote.ts';
import { claimRequest, loadRequest, type LoginRequestRow, markDone, markError } from '../_shared/oauth/requests.ts';
import { asLoginErrorCode, LoginError } from '../_shared/oauth/types.ts';

const NO_CONTEXT: CallbackContext = { id: null, client: null, provider: null, returnTo: '' };

export default serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
  let ctx = NO_CONTEXT;
  try {
    const q = new URL(req.url).searchParams;
    const id = parseRequestId(q.get('state'));
    const r = id ? await loadRequest(id) : null;
    if (!r) return callbackResponse(NO_CONTEXT, { kind: 'error', code: 'invalid_request' });
    ctx = { id: r.id, client: r.client, provider: r.provider, returnTo: r.return_to };

    if (r.status === 'pending' && r.finished_at === null) {
      const code = (q.get('code') ?? '').trim();
      const outcome = r.expired
        ? await failUnclaimed(r, { kind: 'error', code: 'expired' })
        : !code
        ? await failUnclaimed(r, noCodeOutcome(r, q))
        : (await claimRequest(r.id))
        ? await completeLogin(r, code)
        : null;
      if (outcome) return callbackResponse(ctx, outcome);
    }
    // 回调地址被打开了第二次（微信内置浏览器偶尔会这样；code 只能用一次），或者同时有另一个回调抢先处理了：
    // 按那一次的结果回应
    const now = r.status === 'pending' ? await loadRequest(r.id) : r;
    if (!now) return callbackResponse(NO_CONTEXT, { kind: 'error', code: 'invalid_request' });
    return callbackResponse(ctx, existingOutcome(now));
  } catch (e) {
    console.error('[auth-callback]', errorMessage(e));
    return callbackResponse(ctx, { kind: 'error', code: 'internal' });
  }
});

/**
 * 回调没带 code：用户在微信 / QQ 里点了取消（微信只带 state 回来）。
 * 带了 OAuth 的 error 参数、又不是 access_denied 的，算第三方报错（多半是应用配置问题，给管理员看错误码）。
 */
function noCodeOutcome(r: LoginRequestRow, q: URLSearchParams): ErrorOutcome {
  const error = cleanText(q.get('error') ?? '', 64);
  if (!error || error === 'access_denied') return { kind: 'error', code: 'cancelled' };
  const desc = cleanText(q.get('error_description') ?? q.get('msg') ?? '', 200);
  return { kind: 'error', code: providerErrorCode(r.provider), detail: redact(`authorize: ${error} ${desc}`.trim()) };
}

/** 没抢这个请求就判失败（取消、过期）；别的回调已经在处理它了 → null（按那边的结果回应） */
async function failUnclaimed(r: LoginRequestRow, outcome: ErrorOutcome): Promise<Outcome | null> {
  return (await markError(r.id, outcome.code, true)) ? outcome : null;
}

/** 已经抢到这个请求：换身份 → 找 / 建账号（或加绑）→ 生成登录令牌 → 记结果 */
async function completeLogin(r: LoginRequestRow, code: string): Promise<Outcome> {
  const linked = r.link_user_id !== null;
  try {
    const app = appCredentials(r.provider);
    if (!app) throw new LoginError('provider_disabled');
    const ident = await fetchIdentity(r.provider, app, code);
    const account = await resolveAccount(ident, r.link_user_id);
    // 加绑不需要令牌：客户端已经登录着
    const token = linked ? null : await generateLoginToken(await loginEmail(account.userId));
    if (!(await markDone(r.id, account.userId, token))) throw new Error(`login request ${r.id} changed while processing`);
    return { kind: 'ok', linked };
  } catch (e) {
    const err = e instanceof LoginError ? e : null;
    const code = err?.code ?? 'internal';
    if (err) console.warn(`[auth-callback] ${r.provider} ${r.id}: ${err.message}`);
    else console.error(`[auth-callback] ${r.provider} ${r.id}: ${errorMessage(e)}`);
    await markError(r.id, code).catch((e2) => console.error('[auth-callback] markError', errorMessage(e2)));
    // 微信 / QQ 返回的错误码给管理员排查用（已经去掉密钥）；服务器内部错误不往页面上写
    const detail = code === 'wechat_error' || code === 'qq_error' ? err?.detail : undefined;
    return { kind: 'error', code, detail };
  }
}

function existingOutcome(r: LoginRequestRow): Outcome {
  switch (r.status) {
    case 'done':
    case 'used':
      return { kind: 'ok', linked: r.link_user_id !== null };
    case 'error':
      return { kind: 'error', code: asLoginErrorCode(r.error) };
    case 'pending':
      // 正在处理的回调最多一分钟就有结果；2 分钟还没结果 = 那次处理中途挂了，等不到了
      if (r.stale_claim) return { kind: 'error', code: 'internal' };
      return r.finished_at === null && r.expired ? { kind: 'error', code: 'expired' } : { kind: 'processing' };
  }
}
