// 微信网页授权（网站应用扫码 snsapi_login / 服务号 snsapi_userinfo 共用 sns 接口）：用 code 换 openid / unionid / 昵称 / 头像。
// 微信接口出错时也是 HTTP 200，内容是 { errcode, errmsg }。
import { cfg } from '../env.ts';
import type { AppCredentials } from './config.ts';
import { cleanAvatar, cleanText, errorMessage, getText, type Json, parseJsonObject, redact, str } from './remote.ts';
import { type ExternalIdentity, LoginError, type WechatProvider } from './types.ts';

async function wechatGet(step: string, url: string): Promise<Json> {
  let r: { status: number; text: string };
  try {
    r = await getText(url);
  } catch (e) {
    throw new LoginError('wechat_error', `${step}: ${errorMessage(e)}`);
  }
  const data = parseJsonObject(r.text);
  if (!data) throw new LoginError('wechat_error', `${step}: HTTP ${r.status}`);
  const errcode = Number(data.errcode ?? 0);
  if (errcode) throw new LoginError('wechat_error', redact(`${step}: ${errcode} ${str(data.errmsg)}`.trim()));
  if (r.status !== 200) throw new LoginError('wechat_error', `${step}: HTTP ${r.status}`);
  return data;
}

export async function wechatIdentity(provider: WechatProvider, app: AppCredentials, code: string): Promise<ExternalIdentity> {
  const base = cfg.wechatApiBase();

  const tokenQuery = new URLSearchParams({ appid: app.appid, secret: app.secret, code, grant_type: 'authorization_code' });
  const token = await wechatGet('access_token', `${base}/sns/oauth2/access_token?${tokenQuery}`);
  // 朋友圈里的「快照页」：微信只给一个虚拟 openid（也拿不到昵称），不能拿来建账号
  if (str(token.is_snapshotuser) === '1') throw new LoginError('wechat_snapshot');
  const accessToken = str(token.access_token);
  const openid = str(token.openid);
  if (!accessToken || !openid) throw new LoginError('wechat_error', 'access_token: no access_token / openid');

  const infoQuery = new URLSearchParams({ access_token: accessToken, openid, lang: 'zh_CN' });
  const info = await wechatGet('userinfo', `${base}/sns/userinfo?${infoQuery}`);
  const infoOpenid = str(info.openid);
  if (infoOpenid && infoOpenid !== openid) throw new LoginError('wechat_error', 'userinfo: openid mismatch');

  return {
    provider,
    subject: openid,
    unionid: str(info.unionid) || str(token.unionid),
    nickname: cleanText(str(info.nickname), 40),
    avatarUrl: cleanAvatar(str(info.headimgurl)),
  };
}
