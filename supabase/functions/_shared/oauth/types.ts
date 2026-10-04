// 微信 / QQ 登录：公共类型和错误代码。
// 流程见 docs/架构.md §6.1–6.3：auth-start → 微信 / QQ 授权页 → auth-callback → auth-finish。

export const PROVIDERS = ['wechat_open', 'wechat_mp', 'qq'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type WechatProvider = 'wechat_open' | 'wechat_mp';
export type Client = 'web' | 'desktop';

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/** 网站应用和服务号挂在同一个微信开放平台账号下时 unionid 相同，认作同一个人 */
export function isWechat(p: Provider): p is WechatProvider {
  return p === 'wechat_open' || p === 'wechat_mp';
}

/** 用授权回调的 code 从微信 / QQ 换来的身份 */
export interface ExternalIdentity {
  provider: Provider;
  /** 这个应用下的 openid */
  subject: string;
  /** 没有就是 '' */
  unionid: string;
  nickname: string;
  avatarUrl: string;
}

/**
 * 回调阶段的错误代码：网页版跳回 `#pling-login-error=<代码>`，桌面版显示中文页面，
 * auth-finish 返回 `{ status: 'error', error: <代码> }`。前端按代码翻译。
 */
export const LOGIN_ERROR_CODES = [
  'invalid_request', // state 缺失，或者找不到这个登录请求
  'expired', // 发起登录超过 10 分钟才回调
  'cancelled', // 用户在微信 / QQ 里取消了授权（回调没有 code）
  'provider_disabled', // 这种登录方式没配（发起之后被关掉了）
  'wechat_error', // 微信接口报错 / 连不上
  'wechat_snapshot', // 服务号授权发生在朋友圈「快照页」里：微信只给虚拟 openid，不能用来登录
  'qq_error', // QQ 接口报错 / 连不上
  'already_linked', // 加绑：这个微信 / QQ 已经属于别的账号
  'internal', // 数据库 / GoTrue 出错
] as const;
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

export function asLoginErrorCode(v: unknown): LoginErrorCode {
  return typeof v === 'string' && (LOGIN_ERROR_CODES as readonly string[]).includes(v) ? (v as LoginErrorCode) : 'internal';
}

export class LoginError extends Error {
  constructor(public code: LoginErrorCode, public detail = '') {
    super(detail ? `${code}: ${detail}` : code);
  }
}
