// auth-start（POST，公开）：发起微信 / QQ 登录（docs/架构.md §6.1）。
// 请求 { provider, client, returnTo?, link? } → { id, secret, url }
// 带 Authorization: Bearer <用户 JWT> 且 link: true = 给当前账号加绑这个登录方式。
import { getCaller } from '../_shared/auth.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { appCredentials, authorizeUrl, callbackUrl } from '../_shared/oauth/config.ts';
import { compactId, isSafeReturnTo, newSecret, sha256Hex } from '../_shared/oauth/params.ts';
import { createRequest } from '../_shared/oauth/requests.ts';
import { isProvider } from '../_shared/oauth/types.ts';

export default serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const body = await readJson<unknown>(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json');
  const { provider, client = 'web', returnTo, link } = body as Record<string, unknown>;

  if (!isProvider(provider)) throw new HttpError(400, 'invalid_provider');
  if (client !== 'web' && client !== 'desktop') throw new HttpError(400, 'invalid_client');
  if (returnTo !== undefined && returnTo !== null && returnTo !== '' && !isSafeReturnTo(returnTo)) {
    throw new HttpError(400, 'invalid_return_to');
  }

  const app = appCredentials(provider);
  if (!app) throw new HttpError(400, 'provider_disabled');
  // 回调地址拼不出来（PLING_PUBLIC_URL / PLING_FUNCTIONS_URL 都没配）= 部署没配好
  if (!/^https?:\/\/[^/]/i.test(callbackUrl())) throw new HttpError(500, 'not_configured', 'PLING_PUBLIC_URL is not set');

  let linkUserId: string | null = null;
  if (link === true) {
    const caller = await getCaller(req);
    if (!caller) throw new HttpError(401, 'unauthorized');
    linkUserId = caller.id;
  }

  const secret = newSecret();
  const id = await createRequest({
    secretHash: await sha256Hex(secret),
    provider,
    client,
    returnTo: typeof returnTo === 'string' ? returnTo : '',
    linkUserId,
  });
  return json(req, { id, secret, url: authorizeUrl(provider, app, compactId(id)) });
});
