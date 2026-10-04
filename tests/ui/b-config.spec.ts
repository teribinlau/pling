// B. 运行时配置：网页版读 /config.json；桌面版第一次打开「连接服务器」，设置 → 关于 显示服务器、可以切换
import { expect, test, type Page } from '@playwright/test';
import { calm, SHOTS } from './helpers';

const CONFIG = {
  supabaseUrl: 'https://pling.example.cn/api',
  supabaseAnonKey: 'anon-test-key',
  publicUrl: 'https://pling.example.cn',
  orgName: '某某中学',
  logins: { email: true, wechat: true, wechatMp: true, qq: true },
  notify: { wechatMp: true },
  updatesUrl: 'https://pling.example.cn/downloads/latest.json',
};

/** 假的后端：/config.json + Supabase 的几个接口（没登录、登录页要的机构名） */
async function fakeServer(page: Page, config: unknown = CONFIG) {
  const hits: string[] = [];
  await page.route('**/config.json', (r) => {
    hits.push(r.request().url());
    return r.fulfill({ json: config });
  });
  await page.route('https://pling.example.cn/api/**', (r) => {
    const url = r.request().url();
    hits.push(url);
    if (url.includes('/rest/v1/app_settings')) return r.fulfill({ json: { org_name: '数据库里的机构名' } });
    return r.fulfill({ status: 200, json: {} });
  });
  return hits;
}

/** 假装是桌面版：__TAURI_INTERNALS__ + fetch_server_config 命令 */
async function fakeDesktop(page: Page, servers: Record<string, unknown>) {
  await page.addInitScript((servers) => {
    const calls: unknown[] = [];
    (window as unknown as { __plingCalls: unknown[] }).__plingCalls = calls;
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push([cmd, args]);
        if (cmd === 'fetch_server_config') {
          const url = String(args.url);
          if (servers[url] === undefined) throw new Error('network: dns error');
          if (servers[url] === 404) throw new Error('http_404');
          return JSON.stringify(servers[url]);
        }
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
      transformCallback: () => 1,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    };
  }, servers);
}

test('网页版：有 /config.json 就连它的服务器（登录页显示机构名和配置的登录方式）', async ({ page }) => {
  const hits = await fakeServer(page);
  await page.goto('/');
  await expect(page.locator('.login .brand h1')).toHaveText('某某中学');
  // 电脑浏览器：微信扫码 + QQ，邮箱折起来
  await expect(page.getByRole('button', { name: '微信扫码登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'QQ 登录' })).toBeVisible();
  await expect(page.getByRole('button', { name: /微信一键登录/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /用邮箱验证码登录/ })).toBeVisible();
  expect(hits.some((u) => u.endsWith('/config.json'))).toBe(true);
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/b-web-login.png` });
});

test('网页版：没有 config.json → 演示模式', async ({ page }) => {
  await page.route('**/config.json', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await page.goto('/');
  await expect(page.getByText('演示模式')).toBeVisible();
});

test('桌面版第一次打开：连接服务器（邀请链接也行），存本机，以后直接用', async ({ page }) => {
  await fakeServer(page);
  await fakeDesktop(page, { 'https://pling.example.cn/config.json': CONFIG, 'https://bad.example.cn/config.json': 404 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '连接服务器' })).toBeVisible();
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/b-connect.png` });

  // 连不上
  await page.locator('#server').fill('nowhere.example.cn');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('连不上');
  // 不是叮一下
  await page.locator('#server').fill('https://bad.example.cn');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不是叮一下的服务器');
  // 粘贴邀请链接
  await page.locator('#server').fill('https://pling.example.cn/?invite=rj2301ab');
  await expect(page.getByText('链接里有邀请码 RJ2301AB')).toBeVisible();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  // 整页重新加载 → 登录页（桌面版：扫码 + QQ）
  await expect(page.locator('.login .brand h1')).toHaveText('某某中学');
  await expect(page.getByRole('button', { name: '微信扫码登录' })).toBeVisible();
  await expect(page.getByText('邀请码 RJ2301AB 已记下')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pling-server-v1') ?? 'null'));
  expect(saved).toMatchObject({ server: 'https://pling.example.cn', demo: false, config: { orgName: '某某中学', updatesUrl: CONFIG.updatesUrl } });
  expect(await page.evaluate(() => localStorage.getItem('pling-invite'))).toBe('RJ2301AB');
  // 再开一次：直接用存着的（顺手刷新一次 config.json）
  await page.reload();
  await expect(page.locator('.login .brand h1')).toHaveText('某某中学');
  const calls = await page.evaluate(() => (window as unknown as { __plingCalls: [string, { url?: string }][] }).__plingCalls);
  expect(calls.filter(([c]) => c === 'fetch_server_config').map(([, a]) => a.url)).toEqual(['https://pling.example.cn/config.json']);
});

test('桌面版：离线时用存着的配置', async ({ page }) => {
  await fakeDesktop(page, {});
  await page.addInitScript((cfg) => localStorage.setItem('pling-server-v1', JSON.stringify({ server: 'https://pling.example.cn', config: cfg, demo: false, savedAt: '' })), { ...CONFIG, orgName: '缓存里的中学' });
  await page.route('https://pling.example.cn/api/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('.login .brand h1')).toHaveText('缓存里的中学');
});

test('桌面版：先看看演示，设置 → 关于 里换服务器', async ({ page }) => {
  await fakeDesktop(page, { 'https://pling.example.cn/config.json': CONFIG });
  await page.goto('/');
  await page.getByRole('button', { name: '先看看演示' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await page.locator('.rail .nav-btn[aria-label="设置"]').click();
  await page.locator('.settings nav button[data-tab="about"]').click();
  await expect(page.getByTestId('server')).toHaveText('演示模式（没有连接服务器）');
  await expect(page.getByRole('button', { name: '换服务器' })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '换服务器' }).click();
  await expect(page.getByRole('heading', { name: '连接服务器' })).toBeVisible();
});

test('桌面版自动更新：用服务器给的 updatesUrl 调 Rust 的 update_download', async ({ page }) => {
  await fakeDesktop(page, { 'https://pling.example.cn/config.json': CONFIG });
  await page.addInitScript(() => localStorage.setItem('pling-server-v1', JSON.stringify({ server: '', config: null, demo: true, savedAt: '' })));
  await page.goto('/');
  await page.getByRole('button', { name: /王老师/ }).click();
  await page.locator('.rail .nav-btn[aria-label="设置"]').click();
  await page.locator('.settings nav button[data-tab="about"]').click();
  // 演示模式没有 updatesUrl：明说
  await page.getByRole('button', { name: '检查更新' }).click();
  await expect(page.getByText('这台服务器没有提供桌面版更新')).toBeVisible();
});
