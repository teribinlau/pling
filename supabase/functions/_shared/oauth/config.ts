// 哪种登录方式配好了、回调地址、微信 / QQ 授权页地址。
import { cfg } from '../env.ts';
import type { Provider } from './types.ts';

export interface AppCredentials {
  appid: string;
  /** 微信的 AppSecret / QQ 的 APP Key */
  secret: string;
}

/**
 * 这种登录方式的应用凭据；没配全 → null（auth-start 回 400 provider_disabled）
 * - wechat_open：WECHAT_OPEN_APPID + WECHAT_OPEN_SECRET（开放平台「网站应用」，电脑上扫码）
 * - wechat_mp：WECHAT_MP_APPID + WECHAT_MP_SECRET（服务号网页授权，微信里一键登录）
 * - qq：QQ_APPID + QQ_APPKEY（QQ 互联网站应用）
 */
export function appCredentials(p: Provider): AppCredentials | null {
  let c: AppCredentials;
  if (p === 'wechat_open') c = cfg.wechatOpen();
  else if (p === 'wechat_mp') c = { appid: cfg.wechatMp().appid, secret: cfg.wechatMp().secret };
  else c = { appid: cfg.qq().appid, secret: cfg.qq().appkey };
  return c.appid && c.secret ? { appid: c.appid, secret: c.secret } : null;
}

/** 微信 / QQ 授权完跳回来的地址；两边后台登记的回调域名就是它的域名 */
export function callbackUrl(): string {
  return `${cfg.functionsUrl()}/auth-callback`;
}

/**
 * 授权页地址，state = 登录请求 id。
 * 微信会对授权链接做强匹配：参数必须按 appid、redirect_uri、response_type、scope、state 的顺序，最后带 #wechat_redirect。
 */
export function authorizeUrl(p: Provider, app: AppCredentials, state: string): string {
  const e = encodeURIComponent;
  const redirect = e(callbackUrl());
  switch (p) {
    case 'wechat_open':
      return `${cfg.wechatOpenBase()}/connect/qrconnect?appid=${e(app.appid)}&redirect_uri=${redirect}` +
        `&response_type=code&scope=snsapi_login&state=${e(state)}#wechat_redirect`;
    case 'wechat_mp':
      return `${cfg.wechatOpenBase()}/connect/oauth2/authorize?appid=${e(app.appid)}&redirect_uri=${redirect}` +
        `&response_type=code&scope=snsapi_userinfo&state=${e(state)}#wechat_redirect`;
    case 'qq':
      return `${cfg.qqApiBase()}/oauth2.0/authorize?response_type=code&client_id=${e(app.appid)}&redirect_uri=${redirect}` +
        `&state=${e(state)}&scope=get_user_info`;
  }
}
