// 假的服务器（界面测试用）：/config.json + Supabase 的几个接口（登录流程、自己的 profile），数据表都是空的。
// 登录测试（D）和「正式环境没有横幅」的布局测试共用。
import type { Page, Route } from '@playwright/test';

export const API = 'https://pling.example.cn/api';
export const CONFIG = {
  supabaseUrl: API,
  supabaseAnonKey: 'anon-test-key',
  publicUrl: 'https://pling.example.cn',
  orgName: '某某中学',
  logins: { email: true, wechat: true, wechatMp: true, qq: true },
  notify: { wechatMp: true },
  updatesUrl: '',
};
export const USER = '11111111-2222-4333-8444-555555555555';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export const JWT = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub: USER, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated', aud: 'authenticated' }))}.sig`;

export interface Backend {
  calls: { path: string; body: unknown; auth: string | null }[];
  profile: Record<string, unknown>;
  finish: unknown[];
}

export async function fakeBackend(page: Page, opts: { profile?: Record<string, unknown>; finish?: unknown[]; redeem?: unknown } = {}): Promise<Backend> {
  const be: Backend = {
    calls: [],
    profile: { id: USER, email: '', name: '微信昵称', team_id: null, role: 'member', lang: 'zh-CN', is_station: false, active: true, phone: '', avatar_url: '', name_confirmed: true, ...(opts.profile ?? {}) },
    finish: opts.finish ?? [{ status: 'done', token_hash: 'hashed-1', type: 'magiclink' }],
  };
  await page.route('**/config.json', (r) => r.fulfill({ json: CONFIG }));
  await page.route(`${API}/**`, async (r: Route) => {
    const req = r.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api', '');
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    be.calls.push({ path: path + url.search, body, auth: req.headers()['authorization'] ?? null });
    if (path === '/functions/v1/auth-start') {
      const b = body as { provider: string };
      return r.fulfill({ json: { id: 'req-1', secret: 'sec-1', url: `https://pling.example.cn/fake-oauth?provider=${b.provider}&state=req-1` } });
    }
    if (path === '/functions/v1/auth-finish') return r.fulfill({ json: be.finish.length > 1 ? be.finish.shift() : be.finish[0] });
    if (path === '/auth/v1/verify') {
      return r.fulfill({ json: { access_token: JWT, token_type: 'bearer', expires_in: 3600, refresh_token: 'rt', user: { id: USER, aud: 'authenticated', email: 'u.x@login.pling.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' } } });
    }
    if (path === '/auth/v1/user') return r.fulfill({ json: { id: USER, aud: 'authenticated', email: 'u.x@login.pling.invalid', app_metadata: {}, user_metadata: {} } });
    if (path === '/rest/v1/rpc/redeem_invite') {
      const res = opts.redeem ?? { ok: true, team_id: 'team-1', was_active: false };
      if ((res as { ok: boolean }).ok) Object.assign(be.profile, { active: true, team_id: 'team-1' });
      return r.fulfill({ json: res });
    }
    if (path.startsWith('/rest/v1/profiles')) {
      if (req.method() === 'PATCH') {
        Object.assign(be.profile, body as object);
        return r.fulfill({ status: 204, body: '' });
      }
      return r.fulfill({ json: [be.profile] });
    }
    if (path.startsWith('/rest/v1/teams')) return r.fulfill({ json: be.profile.team_id ? [{ id: 'team-1', name: '高一（3）班', color: '#3B7A2A', sort: 1 }] : [] });
    if (path.startsWith('/rest/v1/app_settings')) return r.fulfill({ json: { org_name: '某某中学', team_label: '班级', org_label: '全校', timezone: 'Asia/Shanghai', push_overdue_max: 2 } });
    if (req.headers()['accept']?.includes('vnd.pgrst.object')) return r.fulfill({ status: 406, json: { code: 'PGRST116', message: 'no rows' } });
    if (path.startsWith('/rest/v1/')) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, json: {} });
  });
  // 实时订阅：直接拒掉（测试里不需要）
  await page.routeWebSocket(/realtime/, (ws) => ws.close());
  // 假的微信 / QQ 授权页：网页版会跳到这里
  await page.route('https://pling.example.cn/fake-oauth**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>授权</title><p>fake oauth</p>' }));
  return be;
}

/** 走一遍网页版 QQ 登录（假授权页 → 回调 → 进应用） */
export async function loginWithFakeQQ(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'QQ 登录' }).click();
  await page.waitForURL(/fake-oauth/);
  await page.goto('/#pling-login=req-1');
}
