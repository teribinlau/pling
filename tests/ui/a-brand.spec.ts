// A. 改名和清理：叮一下 / Pling、图标、没有德语 / Notion / 承运商、通用模板、本机键名
import { expect, test } from '@playwright/test';
import { calm, enterDemo, openSettings, SHOTS, watchErrors } from './helpers';

test('标题、图标、manifest：叮一下', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/叮一下/);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', '叮一下');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon.svg');
  const svg = await (await request.get('/icon.svg')).text();
  expect(svg).toContain('<svg');
  expect(svg).toContain('#FF4B3E'); // 声波
  for (const f of ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']) {
    const r = await request.get(f);
    expect(r.ok(), f).toBe(true);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  await expect(page.locator('.login .brand h1')).toHaveText('示例大学 · 计算机学院');
  await expect(page.locator('.login .brand-sub')).toHaveText('叮一下 · Pling');
});

test('界面里没有德语、Notion、承运商、仓库的说法', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  const texts: string[] = [];
  // 皮肤列表里的「Notion」是配色方案的名字（来自 getdesign），不是 Notion 同步，不算
  const grab = async () => texts.push(await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.skin-grid').forEach((el) => el.remove());
    return clone.innerText;
  }));
  await grab();
  await page.getByRole('tab', { name: '列表' }).click();
  await grab();
  await page.locator('.card', { hasText: '实验一报告' }).first().click();
  await grab();
  await page.locator('.main-head .btn.primary').click(); // 新建提醒
  await grab();
  await page.keyboard.press('Escape');
  for (const tab of ['general', 'account', 'notifications', 'members', 'invites', 'bots', 'org', 'holidays', 'about']) {
    await openSettings(page, tab);
    await grab();
  }
  const all = texts.join('\n');
  for (const bad of ['Deutsch', 'DZF', 'Notion', '承运商', 'DPD', 'FedEx', '仓库', '工位', '员工', '同事', '黑森', '柏林', 'Europe/Berlin', '班组', '全公司可见']) {
    expect(all, bad).not.toContain(bad);
  }
  expect(errors).toEqual([]);
});

test('新建提醒的常用模板：交作业 / 收材料 / 开会 / 值日 / 报名截止 / 周报', async ({ page }) => {
  await enterDemo(page, 'admin');
  await page.locator('.main-head .btn.primary').click();
  const tpl = page.locator('.templates button');
  await expect(tpl).toHaveText(['交作业', '收材料', '开会', '值日', '报名截止', '周报']);
  await tpl.filter({ hasText: '交作业' }).click();
  await expect(page.locator('#f-title')).toHaveValue('交作业 — 请在截止前上传');
  await expect(page.locator('#f-time')).toHaveValue('22:00');
  await expect(page.locator('.upload-opt')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.chip.active', { hasText: '每人各自完成' })).toBeVisible();
  await tpl.filter({ hasText: '值日' }).click();
  await expect(page.locator('.chip.active', { hasText: '每个工作日' })).toBeVisible();
  await expect(page.locator('.upload-opt')).toHaveAttribute('aria-pressed', 'false');
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/a-templates.png` });
});

test('默认皮肤叫「默认」；设置存在 pling- 开头的本机键里', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'general');
  await expect(page.locator('.skin-opt').first().locator('.skin-name')).toHaveText('默认');
  await page.locator('.skin-opt', { hasText: 'Notion' }).click();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain('pling-settings-v1');
  expect(keys.some((k) => /dzf/i.test(k))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe('notion');
});

test('返回键的历史记录：plingLayer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterDemo(page, 'admin');
  await page.locator('.tabbar button', { hasText: '看板' }).click();
  await page.locator('.card', { hasText: '实验一报告' }).first().click();
  await expect(page.locator('.detail.open')).toBeVisible();
  const state = await page.evaluate(() => history.state);
  expect(state).toMatchObject({ plingLayer: 1 });
  await page.goBack();
  await expect(page.locator('.detail.open')).toHaveCount(0);
});
