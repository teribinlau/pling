// 云函数读环境变量的唯一入口。每次调用都现读（测试里可以随时改 Deno.env）。
export function env(name: string, fallback = ''): string {
  return (Deno.env.get(name) ?? fallback).trim();
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export const cfg = {
  /** 网页版地址，如 https://pling.example.cn */
  publicUrl: () => trimSlash(env('PLING_PUBLIC_URL')),
  /** 浏览器能访问到的云函数地址（微信 / QQ 回调用），默认 <publicUrl>/api/functions/v1 */
  functionsUrl: () => trimSlash(env('PLING_FUNCTIONS_URL')) || `${trimSlash(env('PLING_PUBLIC_URL'))}/api/functions/v1`,
  /** 内网访问 Supabase 网关（GoTrue 管理接口），如 http://kong:8000 */
  supabaseUrl: () => trimSlash(env('SUPABASE_URL')),
  anonKey: () => env('SUPABASE_ANON_KEY'),
  serviceKey: () => env('SUPABASE_SERVICE_ROLE_KEY'),
  dbUrl: () => env('SUPABASE_DB_URL'),
  cronSecret: () => env('PLING_CRON_SECRET'),

  wechatApiBase: () => trimSlash(env('WECHAT_API_BASE', 'https://api.weixin.qq.com')),
  wechatOpenBase: () => trimSlash(env('WECHAT_OPEN_BASE', 'https://open.weixin.qq.com')),
  qqApiBase: () => trimSlash(env('QQ_API_BASE', 'https://graph.qq.com')),

  wechatOpen: () => ({ appid: env('WECHAT_OPEN_APPID'), secret: env('WECHAT_OPEN_SECRET') }),
  wechatMp: () => ({
    appid: env('WECHAT_MP_APPID'),
    secret: env('WECHAT_MP_SECRET'),
    token: env('WECHAT_MP_TOKEN'),
    templateId: env('WECHAT_MP_TEMPLATE_ID'),
    templateFields: env('WECHAT_MP_TEMPLATE_FIELDS'),
  }),
  qq: () => ({ appid: env('QQ_APPID'), appkey: env('QQ_APPKEY') }),
};
