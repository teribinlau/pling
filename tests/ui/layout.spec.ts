// 布局：桌面 1440 / 窄窗 1000 / iPhone 13 / Pixel 7 × 4 个皮肤，主要页面都没有横向溢出、文字没被挤成竖排；
// 另外：正式环境（没有演示横幅）手机上底栏贴着屏幕底边（DZF 踩过的坑：横幅 display:none 把底栏顶出屏幕）。
// 每个组合截一张看板 + 一张作业详情，放在 scratchpad/ui/layout/。
import { mkdirSync } from 'node:fs';
import { devices, expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { scanLayout, SHOTS } from './helpers';
import { fakeBackend, loginWithFakeQQ } from './fake-backend';

const SIZES: { name: string; ctx: BrowserContextOptions }[] = [
  { name: 'desktop-1440', ctx: { viewport: { width: 1440, height: 900 } } },
  { name: 'narrow-1000', ctx: { viewport: { width: 1000, height: 760 } } },
  // 都用 chromium 跑（iPhone 13 原本是 WebKit：这里只要它的尺寸、触屏和 UA）
  { name: 'iphone-13', ctx: { ...devices['iPhone 13'], defaultBrowserType: undefined } as BrowserContextOptions },
  { name: 'pixel-7', ctx: { ...devices['Pixel 7'], defaultBrowserType: undefined } as BrowserContextOptions },
];
const SKINS = ['default', 'opencode', 'notion', 'popcart'];
const DIR = `${SHOTS}/layout`;
mkdirSync(DIR, { recursive: true });

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 900;

async function open(browser: Browser, size: (typeof SIZES)[number], skin: string): Promise<Page> {
  const context = await browser.newContext({ ...size.ctx, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-10-09T10:00:00+08:00'));
  await page.addInitScript((skin) => {
    try {
      localStorage.setItem('pling-settings-v1', JSON.stringify({ skin }));
    } catch {
      /* ignore */
    }
  }, skin);
  return page;
}

async function quiet(page: Page): Promise<void> {
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}.toasts{display:none!important}' });
}

async function nav(page: Page, where: '日历' | '看板' | '讨论' | '设置'): Promise<void> {
  if (isPhone(page)) {
    const label = where === '日历' ? '今天' : where;
    await page.locator('.tabbar button', { hasText: label }).click();
  } else {
    await page.locator(`.rail .nav-btn[aria-label="${where}"]`).click();
  }
}

/** 扫一遍，问题带上是哪一步 */
async function check(page: Page, step: string, out: string[]): Promise<void> {
  await page.waitForTimeout(60);
  for (const p of await scanLayout(page)) out.push(`${step}: ${p}`);
}

/** 手机上详情是盖住列表的底部抽屉：点 × 关掉才能点下一张卡片（桌面详情在右边一栏，不用关） */
async function closeDetail(page: Page): Promise<void> {
  if (isPhone(page)) await page.locator('.detail.open .head').getByRole('button', { name: '关闭' }).click();
}

for (const size of SIZES) {
  for (const skin of SKINS) {
    test(`布局 · ${size.name} · ${skin}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const page = await open(browser, size, skin);
      const problems: string[] = [];
      const tag = `${size.name}-${skin}`;

      // 登录页（演示）
      await page.goto('/');
      await quiet(page);
      await expect(page.getByRole('button', { name: /王老师/ })).toBeVisible();
      await check(page, '登录页', problems);
      await page.getByRole('button', { name: /王老师/ }).click();
      await expect(page.locator('.app')).toBeVisible();

      // 日历
      await check(page, '日历', problems);
      // 看板
      await nav(page, '看板');
      await expect(page.locator('.card').first()).toBeVisible();
      await check(page, '看板', problems);
      await page.screenshot({ path: `${DIR}/${tag}-board.png` });
      // 详情：作业（统计 + 名单）、已读回执
      await page.locator('.card', { hasText: '实验一报告' }).first().click();
      await expect(page.locator('.detail .homework')).toBeVisible();
      await page.getByRole('button', { name: '退回 张伟' }).click();
      await check(page, '作业详情', problems);
      await page.locator('.detail').evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.45));
      await page.screenshot({ path: `${DIR}/${tag}-homework.png` });
      await page.locator('.hw-return').getByRole('button', { name: '取消' }).click();
      await closeDetail(page);
      await page.locator('.card', { hasText: '国庆收假返校通知' }).first().click();
      await page.getByRole('button', { name: '看名单' }).click();
      await check(page, '已读回执', problems);
      await closeDetail(page);

      // 新建提醒弹窗 + 日期选择器（休 / 班）
      if (isPhone(page)) await page.locator('.fab').first().click();
      else await page.locator('.main-head .btn.primary').click();
      await expect(page.locator('.modal')).toBeVisible();
      await check(page, '新建提醒', problems);
      await page.locator('#f-date').click();
      await expect(page.locator('.cal-pop')).toBeVisible();
      await check(page, '日期选择器', problems);
      await page.keyboard.press('Escape');
      await page.locator('.modal').getByRole('button', { name: '取消' }).click();

      // 讨论
      await nav(page, '讨论');
      await check(page, '讨论列表', problems);
      await page.locator('.ditem', { hasText: '运动会方阵口号征集' }).click();
      await expect(page.locator('.dpost-title')).toBeVisible();
      await check(page, '讨论', problems);
      if (isPhone(page)) await page.locator('.dt-back').click();

      // 设置的每一页
      await nav(page, '设置');
      for (const tab of ['general', 'account', 'notifications', 'members', 'invites', 'bots', 'org', 'holidays', 'about']) {
        await page.locator(`.settings nav button[data-tab="${tab}"]`).click();
        await page.waitForTimeout(30);
        await check(page, `设置/${tab}`, problems);
      }
      // 打开表单的状态：生成邀请码、添加机器人、添加节假日
      await page.locator('.settings nav button[data-tab="invites"]').click();
      await page.getByRole('button', { name: '生成邀请码' }).click();
      await check(page, '设置/invites 表单', problems);
      await page.locator('.settings nav button[data-tab="bots"]').click();
      await page.locator('.bots-pane .h2-line').getByRole('button', { name: '添加机器人' }).click();
      await check(page, '设置/bots 表单', problems);
      await page.locator('.settings nav button[data-tab="holidays"]').click();
      await page.locator('.hol-pane .h2-line').getByRole('button', { name: '添加' }).click();
      await check(page, '设置/holidays 表单', problems);
      await page.locator('.settings nav button[data-tab="members"]').click();
      await page.screenshot({ path: `${DIR}/${tag}-members.png` });

      expect(problems, problems.join('\n')).toEqual([]);
      await page.context().close();
    });
  }
}

test('学生 / 共用设备 / 新同学的页面也不溢出（窄屏 + 手机）', async ({ browser }) => {
  test.setTimeout(120_000);
  for (const size of [SIZES[1], SIZES[2]]) {
    const page = await open(browser, size, 'default');
    const problems: string[] = [];
    // 学生：被退回的作业 → 我的作业 + 重新提交
    await page.goto('/?r=demo-hw1');
    await quiet(page);
    await page.getByRole('button', { name: /李同学/ }).click();
    await expect(page.locator('.detail .my-hw')).toBeVisible();
    await check(page, `${size.name} 学生/我的作业`, problems);
    // 共用设备：未交名单 + 选人
    await page.goto('about:blank');
    await page.goto('/?r=demo-hw1');
    await quiet(page);
    await page.getByRole('button', { name: /实验室电脑/ }).click();
    await expect(page.locator('.detail h2')).toBeVisible();
    await check(page, `${size.name} 共用设备/作业`, problems);
    // 新同学：填姓名 → 待激活
    await page.goto('about:blank');
    await page.goto('/');
    await quiet(page);
    await page.getByRole('button', { name: /新同学/ }).click();
    await check(page, `${size.name} 新同学/填姓名`, problems);
    await page.getByRole('button', { name: '开始使用' }).click();
    await expect(page.getByRole('heading', { name: '等待激活' })).toBeVisible();
    await check(page, `${size.name} 新同学/待激活`, problems);
    expect(problems, problems.join('\n')).toEqual([]);
    await page.context().close();
  }
});

test('正式环境（没有演示横幅）：手机上底栏贴着屏幕底边，登录页也不溢出', async ({ browser }) => {
  for (const size of [SIZES[2], SIZES[3]]) {
    const page = await open(browser, size, 'default');
    await fakeBackend(page);
    await page.goto('/');
    await quiet(page);
    await expect(page.getByRole('button', { name: 'QQ 登录' })).toBeVisible();
    const problems: string[] = [];
    await check(page, `${size.name} 正式登录页`, problems);
    await loginWithFakeQQ(page);
    await expect(page.locator('.app')).toBeVisible();
    await expect(page.locator('.banner')).toHaveText('');
    const vh = page.viewportSize()!.height;
    const bar = await page.locator('.tabbar').boundingBox();
    expect(bar, 'tabbar 可见').not.toBeNull();
    expect(Math.round(bar!.y + bar!.height)).toBe(vh);
    expect(bar!.y).toBeLessThan(vh - 50);
    await check(page, `${size.name} 正式环境日历`, problems);
    await page.screenshot({ path: `${DIR}/${size.name}-real-mode.png` });
    expect(problems, problems.join('\n')).toEqual([]);
    await page.context().close();
  }
});
