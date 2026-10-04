// auth-callback 的回应：网页版 302 回应用（#pling-login=<id> / #pling-login-error=<代码>），
// 桌面版（和不知道是谁发起的请求）显示一个中文结果页 —— 桌面版这时在系统浏览器里，应用自己在轮询 auth-finish。
import { cfg } from '../env.ts';
import { cleanText } from './remote.ts';
import type { Client, LoginErrorCode, Provider } from './types.ts';

export interface ErrorOutcome {
  kind: 'error';
  code: LoginErrorCode;
  /** 微信 / QQ 返回的错误码，显示在桌面版结果页上给管理员排查 */
  detail?: string;
}

export type Outcome =
  | { kind: 'ok'; linked: boolean }
  | ErrorOutcome
  /** 另一个回调正在处理这次登录（微信偶尔会把回调地址打开两次），结果让应用自己去取 */
  | { kind: 'processing' };

export interface CallbackContext {
  /** 找不到登录请求时为 null */
  id: string | null;
  client: Client | null;
  provider: Provider | null;
  returnTo: string;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // 回调地址里有 code，不能通过 Referer 带出去
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function callbackResponse(ctx: CallbackContext, outcome: Outcome): Response {
  const publicUrl = cfg.publicUrl();
  if (ctx.client === 'web' && ctx.id && /^https?:\/\//i.test(publicUrl)) {
    const hash = outcome.kind === 'error' ? `pling-login-error=${outcome.code}` : `pling-login=${ctx.id}`;
    return new Response(null, {
      status: 302,
      headers: { Location: `${publicUrl}${ctx.returnTo || '/'}#${hash}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  }
  return new Response(resultPage(ctx, outcome), { status: outcome.kind === 'error' ? 400 : 200, headers: PAGE_HEADERS });
}

// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function providerName(p: Provider | null): string {
  return p === 'qq' ? 'QQ' : p ? '微信' : '微信 / QQ';
}

interface Copy {
  title: string;
  body: string;
}

export function errorCopy(code: LoginErrorCode, provider: Provider | null): Copy {
  const p = providerName(provider);
  switch (code) {
    case 'cancelled':
      return { title: '已取消登录', body: `你在${p}里取消了授权。要登录的话，请回到叮一下重新点一次。` };
    case 'expired':
      return { title: '登录已过期', body: '从发起登录到授权超过了 10 分钟。请回到叮一下重新点一次登录。' };
    case 'invalid_request':
      return { title: '登录链接无效', body: '找不到这次登录，可能链接不完整，或者是很久以前的链接。请回到叮一下重新点一次登录。' };
    case 'provider_disabled':
      return { title: `${p}登录没有开通`, body: `管理员关掉了${p}登录。请回到叮一下换一种方式登录。` };
    case 'wechat_error':
      return { title: '微信返回了错误', body: '微信没能完成这次登录，请回到叮一下再试一次。一直不行的话，请联系管理员。' };
    case 'wechat_snapshot':
      return {
        title: '请先打开完整页面',
        body: '你是在朋友圈的预览页里点的登录，这里不能授权。请点页面底部的「使用完整服务」，再登录一次。',
      };
    case 'qq_error':
      return { title: 'QQ 返回了错误', body: 'QQ 没能完成这次登录，请回到叮一下再试一次。一直不行的话，请联系管理员。' };
    case 'already_linked':
      return {
        title: `这个${p}已经绑在别的账号上`,
        body: `这个${p}已经是另一个叮一下账号的登录方式，不能再绑到当前账号。请换一个${p}，或者联系管理员。`,
      };
    case 'internal':
      return { title: '登录没有完成', body: '服务器出了点问题，请稍后回到叮一下再试一次。' };
  }
}

function outcomeCopy(ctx: CallbackContext, outcome: Outcome): Copy {
  if (outcome.kind === 'error') return errorCopy(outcome.code, ctx.provider);
  if (outcome.kind === 'processing') return { title: '正在登录…', body: '请回到叮一下查看结果，这个页面可以关掉。' };
  if (outcome.linked) {
    return { title: '绑定成功', body: `以后可以用这个${providerName(ctx.provider)}登录了。可以回到叮一下了，这个页面可以关掉。` };
  }
  return { title: '登录成功', body: '登录成功，可以回到叮一下了，这个页面可以关掉。' };
}

const ICON_OK =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ERROR =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 6.5v7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.5" fill="currentColor"/></svg>';
const ICON_WAIT =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LOGO =
  '<svg viewBox="0 0 512 512" width="28" height="28" aria-hidden="true"><rect width="512" height="512" rx="120" fill="#121212"/><path d="M256 96c-62 0-104 48-104 112 0 88-36 116-36 116h280s-36-28-36-116c0-64-42-112-104-112z" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><path d="M292 384a36 36 0 0 1-72 0" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><circle cx="372" cy="128" r="44" fill="#E5322D"/></svg>';

export function resultPage(ctx: CallbackContext, outcome: Outcome): string {
  const copy = outcomeCopy(ctx, outcome);
  const tone = outcome.kind === 'ok' ? 'ok' : outcome.kind === 'error' ? 'error' : 'wait';
  const icon = tone === 'ok' ? ICON_OK : tone === 'error' ? ICON_ERROR : ICON_WAIT;
  const detail = outcome.kind === 'error' && outcome.detail
    ? `<p class="detail">错误详情（联系管理员时请附上）：${esc(cleanText(outcome.detail, 300))}</p>`
    : '';
  // 桌面版是在系统浏览器里打开的，「回到叮一下」= 切回桌面应用，不放网页版的链接，免得点进网页版
  const publicUrl = cfg.publicUrl();
  const link = ctx.client !== 'desktop' && /^https?:\/\//i.test(publicUrl) ? `<a class="btn" href="${esc(publicUrl)}/">打开叮一下</a>` : '';
  const org = '叮一下 · Pling';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${esc(copy.title)} · 叮一下</title>
<style>
:root {
  --bg: #eeece7; --card: #ffffff; --ink: #121212; --muted: #6f6c65; --hair: #d6d3cb;
  --ok: #3b7a2a; --ok-bg: #e6f0e1; --error: #c8261f; --error-bg: #fbe6e4; --wait: #121212; --wait-bg: #e4e2dc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --card: #22211f; --ink: #f2f0eb; --muted: #a3a097; --hair: #3a3935;
    --ok: #8cc777; --ok-bg: #26331f; --error: #ff7a70; --error-bg: #3a2220; --wait: #f2f0eb; --wait-bg: #33322e;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  min-height: 100vh; min-height: 100dvh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
  background: var(--bg); color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;
}
main {
  width: 100%; max-width: 400px; padding: 32px 28px 28px;
  background: var(--card); border: 1px solid var(--hair); border-radius: 20px;
  box-shadow: 0 8px 24px rgba(18, 18, 18, 0.08); text-align: center;
}
.mark {
  width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 50%;
  display: grid; place-items: center;
}
.mark.ok { color: var(--ok); background: var(--ok-bg); }
.mark.error { color: var(--error); background: var(--error-bg); }
.mark.wait { color: var(--wait); background: var(--wait-bg); }
h1 { margin: 0 0 8px; font-size: 21px; line-height: 1.35; font-weight: 650; letter-spacing: 0.01em; }
p { margin: 0; color: var(--muted); text-wrap: pretty; }
h1 { text-wrap: balance; }
.detail {
  margin-top: 16px; padding: 10px 12px; border-radius: 10px; background: var(--bg);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-align: left; word-break: break-all;
}
.btn {
  display: inline-block; margin-top: 22px; padding: 10px 22px; border-radius: 999px;
  background: var(--ink); color: var(--card); text-decoration: none; font-weight: 600;
}
footer { margin-top: 20px; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
footer svg { width: 20px; height: 20px; border-radius: 5px; }
@media (prefers-color-scheme: dark) { footer svg { box-shadow: 0 0 0 1px var(--hair); } }
@media (max-width: 420px) {
  main { padding: 28px 20px 24px; border-radius: 16px; }
  h1 { font-size: 19px; }
}
</style>
</head>
<body>
<main>
  <div class="mark ${tone}">${icon}</div>
  <h1>${esc(copy.title)}</h1>
  <p>${esc(copy.body)}</p>
  ${detail}
  ${link}
</main>
<footer>${LOGO}<span>${esc(org)}</span></footer>
</body>
</html>
`;
}
