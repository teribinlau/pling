// QQ 互联（网站应用）：code → access_token → openid / unionid → 昵称 / 头像。
// token / me 出错是 { error, error_description }，get_user_info 出错是 { ret != 0, msg }。
// 带了 fmt=json 也有人遇到过 JSONP（callback( {...} );）或 a=b&c=d 的老格式，三种都认。
import { cfg } from '../env.ts';
import { type AppCredentials, callbackUrl } from './config.ts';
import { cleanAvatar, cleanText, errorMessage, getText, type Json, parseJsonObject, redact, str } from './remote.ts';
import { type ExternalIdentity, LoginError } from './types.ts';

export function parseQqBody(text: string): Json | null {
  const t = text.trim();
  const direct = parseJsonObject(t);
  if (direct) return direct;
  const jsonp = /^callback\(\s*(\{[\s\S]*\})\s*\)\s*;?$/.exec(t);
  if (jsonp) return parseJsonObject(jsonp[1]);
  if (/^[\w.-]+=[^\s]*$/.test(t)) return Object.fromEntries(new URLSearchParams(t));
  return null;
}

function failed(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '' && Number(v) !== 0;
}

async function qqGet(step: string, url: string): Promise<Json> {
  let r: { status: number; text: string };
  try {
    r = await getText(url);
  } catch (e) {
    throw new LoginError('qq_error', `${step}: ${errorMessage(e)}`);
  }
  const data = parseQqBody(r.text);
  if (!data) throw new LoginError('qq_error', `${step}: HTTP ${r.status}`);
  if (failed(data.error)) throw new LoginError('qq_error', redact(`${step}: ${str(data.error)} ${str(data.error_description)}`.trim()));
  if (failed(data.ret)) throw new LoginError('qq_error', redact(`${step}: ${str(data.ret)} ${str(data.msg)}`.trim()));
  if (r.status !== 200) throw new LoginError('qq_error', `${step}: HTTP ${r.status}`);
  return data;
}

export async function qqIdentity(app: AppCredentials, code: string): Promise<ExternalIdentity> {
  const base = cfg.qqApiBase();

  const tokenQuery = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: app.appid,
    client_secret: app.secret,
    code,
    redirect_uri: callbackUrl(), // 必须和授权页里的一模一样
    fmt: 'json',
  });
  const token = await qqGet('token', `${base}/oauth2.0/token?${tokenQuery}`);
  const accessToken = str(token.access_token);
  if (!accessToken) throw new LoginError('qq_error', 'token: no access_token');

  const me = await qqGet('me', `${base}/oauth2.0/me?${new URLSearchParams({ access_token: accessToken, unionid: '1', fmt: 'json' })}`);
  const openid = str(me.openid);
  if (!openid) throw new LoginError('qq_error', 'me: no openid');
  const clientId = str(me.client_id);
  if (clientId && clientId !== app.appid) throw new LoginError('qq_error', 'me: client_id mismatch');

  const infoQuery = new URLSearchParams({ access_token: accessToken, oauth_consumer_key: app.appid, openid });
  const info = await qqGet('get_user_info', `${base}/user/get_user_info?${infoQuery}`);

  return {
    provider: 'qq',
    subject: openid,
    unionid: str(me.unionid),
    nickname: cleanText(str(info.nickname), 40),
    // 100×100 的 QQ 头像优先，没有就退到 40×40，再退到 QQ 空间头像
    avatarUrl: cleanAvatar(str(info.figureurl_qq_2) || str(info.figureurl_qq_1) || str(info.figureurl_2) || str(info.figureurl_1)),
  };
}
