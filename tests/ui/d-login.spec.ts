// D. 登录和入门：按 config.logins 显示按钮；网页版 auth-start → 跳转 → #pling-login → auth-finish → verifyOtp；
//    #pling-login-error 显示中文错误；桌面版轮询；?invite= 存本机、登录后用掉；待激活页输入邀请码；先填真实姓名；账户里绑定
import { expect, test } from '@playwright/test';
import { calm, enterDemo, SHOTS, watchErrors } from './helpers';
import { CONFIG, fakeBackend, JWT } from './fake-backend';

test('电脑浏览器：扫码 + QQ，邮箱折起来；点开能填邮箱', async ({ page }) => {
  await fakeBackend(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '微信扫码登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'QQ 登录' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toHaveCount(0);
  await page.getByRole('button', { name: /用邮箱验证码登录/ }).click();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/d-login-desktop-browser.png` });
});

test('微信里打开：微信一键登录；手机普通浏览器：提示去微信里打开', async ({ browser }) => {
  const wx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p1 = await wx.newPage();
  await fakeBackend(p1);
  await p1.goto('/');
  await expect(p1.getByRole('button', { name: '微信一键登录' })).toBeVisible();
  await expect(p1.getByRole('button', { name: '微信扫码登录' })).toHaveCount(0);
  await calm(p1);
  await p1.screenshot({ path: `${SHOTS}/d-login-wechat.png` });
  await wx.close();
  const mob = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const p2 = await mob.newPage();
  await fakeBackend(p2);
  await p2.goto('/');
  await expect(p2.getByText('要用微信登录，请在微信里打开这个页面')).toBeVisible();
  await expect(p2.getByRole('button', { name: /微信/ })).toHaveCount(0);
  await expect(p2.getByRole('button', { name: 'QQ 登录' })).toBeVisible();
  await mob.close();
});

test('网页版完整流程：auth-start → 跳到授权页 → 回来 #pling-login → auth-finish → verifyOtp → 进应用，hash 清掉', async ({ page }) => {
  const errors = watchErrors(page);
  const be = await fakeBackend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QQ 登录' }).click();
  await page.waitForURL(/fake-oauth\?provider=qq/);
  const start = be.calls.find((c) => c.path === '/functions/v1/auth-start')!;
  expect(start.body).toEqual({ provider: 'qq', client: 'web' });
  // 微信 / QQ 授权完，auth-callback 302 回来
  await page.goto('/#pling-login=req-1');
  await expect(page.locator('.app')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  const finish = be.calls.find((c) => c.path === '/functions/v1/auth-finish')!;
  expect(finish.body).toEqual({ id: 'req-1', secret: 'sec-1' });
  const verify = be.calls.find((c) => c.path.startsWith('/auth/v1/verify'))!;
  expect(verify.body).toMatchObject({ token_hash: 'hashed-1', type: 'magiclink' });
  // 之后的数据请求带着用户的 JWT
  expect(be.calls.find((c) => c.path.startsWith('/rest/v1/profiles'))?.auth).toBe(`Bearer ${JWT}`);
  expect(await page.evaluate(() => sessionStorage.getItem('pling-login'))).toBeNull();
  expect(errors).toEqual([]);
});

test('#pling-login-error=<代码>：显示中文错误', async ({ page }) => {
  await fakeBackend(page);
  await page.goto('/#pling-login-error=already_linked');
  await expect(page.getByRole('alert')).toContainText('这个微信 / QQ 已经绑定了别的账号');
  expect(new URL(page.url()).hash).toBe('');
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/d-login-error.png` });
  // 回调是从别的地址 302 回来的整页加载：先离开再回来（只改 hash 不会重新加载页面）
  await page.goto('about:blank');
  await page.goto('/#pling-login-error=wechat_snapshot');
  await expect(page.getByRole('alert')).toContainText('朋友圈');
  // 回来时 id 对不上（比如在别的浏览器里打开了回调）
  await page.goto('about:blank');
  await page.goto('/#pling-login=someone-else');
  await expect(page.getByRole('alert')).toContainText('登录请求无效');
});

test('?invite= 存本机，登录后自动用掉：toast 说加入了哪个班', async ({ page }) => {
  const be = await fakeBackend(page, { profile: { active: false } });
  await page.goto('/?invite=rj2301ab');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(page.getByText('邀请码 RJ2301AB 已记下，登录后自动加入')).toBeVisible();
  await page.getByRole('button', { name: '微信扫码登录' }).click();
  await page.waitForURL(/fake-oauth/);
  await page.goto('/#pling-login=req-1');
  await expect(page.getByText('已加入 高一（3）班')).toBeVisible();
  await expect(page.locator('.app')).toBeVisible();
  const rpc = be.calls.find((c) => c.path === '/rest/v1/rpc/redeem_invite')!;
  expect(rpc.body).toEqual({ p_code: 'RJ2301AB' });
  expect(await page.evaluate(() => localStorage.getItem('pling-invite'))).toBeNull();
});

test('邀请码用不了：toast 说原因，留在待激活页，可以重新输入', async ({ page }) => {
  await fakeBackend(page, { profile: { active: false }, redeem: { ok: false, reason: 'expired' } });
  await page.goto('/?invite=OLD2025X');
  await page.getByRole('button', { name: 'QQ 登录' }).click();
  await page.waitForURL(/fake-oauth/);
  await page.goto('/#pling-login=req-1');
  await expect(page.getByText('这个邀请码已经过期了')).toBeVisible();
  await expect(page.getByRole('heading', { name: '等待激活' })).toBeVisible();
  await expect(page.getByLabel('邀请码')).toBeVisible();
});

test('桌面版：系统浏览器打开授权页，「请在浏览器里完成登录」，每 2 秒问一次，取消', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __calls: unknown[] }).__calls = calls;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        calls.push([cmd, args]);
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
      transformCallback: () => 1,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    };
    localStorage.setItem('pling-server-v1', JSON.stringify({ server: 'https://pling.example.cn', config: null, demo: false, savedAt: '' }));
  });
  const be = await fakeBackend(page, { finish: [{ status: 'pending' }] });
  // 桌面版取配置走 Rust：直接把配置放进存储，离线也能用（fetch_server_config 返回 null → 用缓存）
  await page.addInitScript((cfg) => localStorage.setItem('pling-server-v1', JSON.stringify({ server: 'https://pling.example.cn', config: cfg, demo: false, savedAt: '' })), CONFIG);
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '微信扫码登录' }).click();
  await expect(page.getByRole('heading', { name: '请在浏览器里完成登录' })).toBeVisible();
  const start = be.calls.find((c) => c.path === '/functions/v1/auth-start')!;
  expect(start.body).toEqual({ provider: 'wechat_open', client: 'desktop' });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __calls: [string, { url?: string }][] }).__calls.find(([c]) => c === 'plugin:opener|open_url')?.[1].url ?? ''))
    .toContain('fake-oauth?provider=wechat_open');
  const before = be.calls.filter((c) => c.path === '/functions/v1/auth-finish').length;
  await page.clock.runFor(6100);
  await expect.poll(() => be.calls.filter((c) => c.path === '/functions/v1/auth-finish').length).toBeGreaterThanOrEqual(before + 3);
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/d-desktop-waiting.png` });
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('button', { name: '微信扫码登录' })).toBeVisible();
  // 取消后不再问
  const n = be.calls.filter((c) => c.path === '/functions/v1/auth-finish').length;
  await page.clock.runFor(10000);
  expect(be.calls.filter((c) => c.path === '/functions/v1/auth-finish').length).toBe(n);
});

test('桌面版：浏览器里登录好了 → 自动进应用', async ({ page }) => {
  await page.addInitScript((cfg) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === 'plugin:event|listen' ? 1 : null),
      transformCallback: () => 1,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    };
    localStorage.setItem('pling-server-v1', JSON.stringify({ server: 'https://pling.example.cn', config: cfg, demo: false, savedAt: '' }));
  }, CONFIG);
  await fakeBackend(page, { finish: [{ status: 'pending' }, { status: 'pending' }, { status: 'done', token_hash: 'hashed-1', type: 'magiclink' }] });
  await page.goto('/');
  await page.getByRole('button', { name: 'QQ 登录' }).click();
  await expect(page.getByRole('heading', { name: '请在浏览器里完成登录' })).toBeVisible();
  await expect(page.locator('.app')).toBeVisible({ timeout: 15000 });
});

test('演示：新同学先填真实姓名（预填昵称），再在待激活页输入邀请码进班', async ({ page }) => {
  await enterDemo(page, 'newcomer');
  await expect(page.getByLabel('姓名')).toHaveValue('星星点灯');
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/d-name.png` });
  await page.getByLabel('姓名').fill('赵小明');
  await page.getByRole('button', { name: '开始使用' }).click();
  await expect(page.getByRole('heading', { name: '等待激活' })).toBeVisible();
  await expect(page.getByText('你已经登录了（赵小明）')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/d-pending.png` });
  await page.getByLabel('邀请码').fill('nope123');
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('没有这个邀请码')).toBeVisible();
  await page.getByLabel('邀请码').fill('rj2301ab');
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('已加入 软件 2301 班')).toBeVisible();
  await expect(page.locator('.app')).toBeVisible();
  // 王老师那边：邀请码次数 +1，成员里有赵小明
  await page.locator('.rail-me').click();
  await expect(page.locator('.settings nav button[data-tab="members"]')).toHaveCount(0);
});

test('账户：改姓名、手机号；绑定微信 / QQ（加绑走 auth-start link: true）', async ({ page }) => {
  const be = await fakeBackend(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'QQ 登录' }).click();
  await page.waitForURL(/fake-oauth/);
  await page.goto('/#pling-login=req-1');
  await expect(page.locator('.app')).toBeVisible();
  await page.locator('.rail-me').click();
  await expect(page.locator('.settings nav button.active')).toHaveText(/账户/);
  // 手机号格式不对
  await page.getByLabel('手机号（选填）').fill('12345');
  await expect(page.getByText('手机号格式不对')).toBeVisible();
  await page.getByLabel('手机号（选填）').fill('13800001234');
  await page.getByLabel('手机号（选填）').press('Enter');
  await expect.poll(() => be.calls.some((c) => c.path.startsWith('/rest/v1/profiles') && (c.body as { phone?: string })?.phone === '13800001234')).toBe(true);
  // 绑定 QQ
  await page.locator('.acct-item', { hasText: 'QQ' }).getByRole('button', { name: '绑定' }).click();
  await page.waitForURL(/fake-oauth\?provider=qq/);
  const linkStart = be.calls.filter((c) => c.path === '/functions/v1/auth-start').pop()!;
  expect(linkStart.body).toEqual({ provider: 'qq', client: 'web', link: true });
  expect(linkStart.auth).toBe(`Bearer ${JWT}`);
  // 回来：服务器说加绑好了（没有令牌）
  be.finish = [{ status: 'done', linked: true }];
  await page.goto('/#pling-login=req-1');
  await expect(page.getByText('已绑定QQ')).toBeVisible();
  await expect(page.locator('.settings nav button.active')).toHaveText(/账户/);
});
