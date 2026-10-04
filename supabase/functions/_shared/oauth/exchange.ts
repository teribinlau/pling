// 用授权回调里的 code 换第三方身份。失败抛 LoginError（wechat_error / wechat_snapshot / qq_error）。
import type { AppCredentials } from './config.ts';
import { qqIdentity } from './qq.ts';
import type { ExternalIdentity, LoginErrorCode, Provider } from './types.ts';
import { wechatIdentity } from './wechat.ts';

export function fetchIdentity(provider: Provider, app: AppCredentials, code: string): Promise<ExternalIdentity> {
  return provider === 'qq' ? qqIdentity(app, code) : wechatIdentity(provider, app, code);
}

/** 这家接口出错时用哪个错误代码 */
export function providerErrorCode(provider: Provider): LoginErrorCode {
  return provider === 'qq' ? 'qq_error' : 'wechat_error';
}
