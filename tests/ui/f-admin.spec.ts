// F. 管理员：邀请码（有效期 / 次数 / 备注、链接 + 二维码 + 复制 + 停用、不分组）；群机器人（企业微信 / 钉钉 / 飞书、加签、阶段、启用、测试）；
//    成员列表的登录方式和手机号（微信 / QQ 用户没有邮箱，不显示空的）
import { expect, test } from '@playwright/test';
import { calm, enterDemo, openSettings, SHOTS, watchErrors } from './helpers';

test('邀请码：按班级分组，状态、次数、到期都对', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'invites');
  const c2301 = page.locator('.inv-card[data-code="RJ2301AB"]');
  await expect(c2301.locator('.inv-state')).toHaveText('可以用');
  await expect(c2301).toContainText('已用 6 次');
  await expect(c2301.locator('.inv-link')).toHaveText('http://localhost:1420/?invite=RJ2301AB');
  await expect(page.locator('.inv-card[data-code="RJ2302CD"]')).toContainText('已用 3 / 40 次');
  await expect(page.locator('.inv-card[data-code="OLD2025X"] .inv-state')).toHaveText('已停用');
  await expect(page.locator('.inv-card[data-code="XYTEACH26"]')).toContainText('不分班级（只激活）');
  await expect(page.locator('.inv-card[data-code="XYTEACH26"]')).toContainText('不过期');
});

test('生成邀请码（30 天、限 45 次、备注）→ 二维码自动展开 → 复制链接 → 停用 / 启用', async ({ page, context }) => {
  const errors = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enterDemo(page, 'admin');
  await openSettings(page, 'invites');
  await page.getByRole('button', { name: '生成邀请码' }).click();
  await page.locator('#inv-team').selectOption({ label: '软件 2302 班' });
  await page.getByRole('button', { name: '30 天' }).click();
  await page.getByRole('button', { name: '自定义' }).click();
  await page.getByLabel('可以用几次').fill('0');
  await expect(page.getByText('次数要是正整数')).toBeVisible();
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled();
  await page.getByLabel('可以用几次').fill('45');
  await page.locator('#inv-note').fill('周一班会发');
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/f-invite-form.png` });
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const card = page.locator('.inv-card', { hasText: '周一班会发' });
  await expect(card).toContainText('已用 0 / 45 次');
  await expect(card).toContainText('软件 2302 班');
  const code = (await card.locator('.inv-code').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{8}$/);
  // 二维码（npm qrcode 本机生成）
  await expect(card.locator('.inv-qr img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.screenshot({ path: `${SHOTS}/f-invite-qr.png` });
  await card.getByRole('button', { name: '复制链接' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://localhost:1420/?invite=${code}`);
  await card.getByRole('button', { name: '停用' }).click();
  await expect(card.locator('.inv-state')).toHaveText('已停用');
  await expect(card.getByRole('button', { name: '复制链接' })).toBeDisabled();
  await card.getByRole('button', { name: '启用' }).click();
  await expect(card.locator('.inv-state')).toHaveText('可以用');
  expect(errors).toEqual([]);
});

test('新邀请码真的能用：管理员生成 → 新同学用它进班', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'invites');
  await page.getByRole('button', { name: '生成邀请码' }).click();
  await page.locator('#inv-team').selectOption({ label: '软件 2301 班' });
  await page.getByRole('button', { name: '生成', exact: true }).click();
  const code = (await page.locator('.inv-card').first().locator('.inv-code').innerText()).trim();
  await openSettings(page, 'general');
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /新同学/ }).click();
  await page.getByLabel('姓名').fill('钱多多');
  await page.getByRole('button', { name: '开始使用' }).click();
  await page.getByLabel('邀请码').fill(code.toLowerCase());
  await page.getByRole('button', { name: '加入' }).click();
  await expect(page.getByText('已加入 软件 2301 班')).toBeVisible();
  await openSettings(page, 'general');
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await openSettings(page, 'invites');
  await expect(page.locator(`.inv-card[data-code="${code}"]`)).toContainText('已用 1 次');
  await openSettings(page, 'members');
  await expect(page.locator('.mrow[data-member="钱多多"]')).toContainText('已激活');
});

test('群机器人：列表、上次状态、测试（失败 / 成功）、开关', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'bots');
  const wecom = page.locator('.bot-card[data-bot="2301 班级群"]');
  await expect(wecom.locator('.bot-kind-tag')).toHaveText('企业微信');
  await expect(wecom.locator('.bot-status')).toContainText('成功');
  const ding = page.locator('.bot-card[data-bot="2302 钉钉群"]');
  await expect(ding).toContainText('加签密钥');
  await expect(ding.locator('.bot-status')).toContainText('sign not match');
  await ding.getByRole('button', { name: '测试' }).click();
  await expect(page.getByText(/没发出去：errcode 310000/)).toBeVisible();
  await wecom.getByRole('button', { name: '测试' }).click();
  await expect(page.getByText('测试消息已发出，看看群里')).toBeVisible();
  const feishu = page.locator('.bot-card[data-bot="学院通知群"]');
  await expect(feishu).toHaveClass(/off/);
  await feishu.getByRole('switch', { name: '启用' }).click();
  await expect(feishu).not.toHaveClass(/off/);
  await expect(page.locator('.inv-group-h', { hasText: '「全院」的提醒' })).toBeVisible();
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/f-bots.png` });
});

test('添加 / 编辑 / 删除机器人：飞书 + 加签、阶段至少一个、地址要 https', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await openSettings(page, 'bots');
  await page.getByRole('button', { name: '添加机器人 · 学院办公室' }).click();
  await page.getByRole('radio', { name: '飞书' }).click();
  await page.locator('#bot-name').fill('办公室飞书群');
  await page.locator('#bot-url').fill('http://open.feishu.cn/x');
  await expect(page.getByText('地址要以 https:// 开头')).toBeVisible();
  await page.locator('#bot-url').fill('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
  await page.locator('#bot-secret').fill('feishu-secret');
  await page.getByRole('button', { name: '到点' }).click(); // 取消唯一的阶段
  await expect(page.getByText('至少选一个')).toBeVisible();
  await page.getByRole('button', { name: '逾期' }).click();
  await page.getByRole('button', { name: '提前提醒' }).click();
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/f-bot-form.png` });
  await page.locator('.bot-form').getByRole('button', { name: '保存' }).click();
  const card = page.locator('.bot-card[data-bot="办公室飞书群"]');
  await expect(card.locator('.bot-kind-tag')).toHaveText('飞书');
  await expect(card.locator('.bot-meta')).toContainText('提前提醒 / 逾期');
  await expect(card.locator('.bot-status')).toHaveText('还没发过');
  // 编辑：改名
  await card.getByRole('button', { name: '编辑机器人' }).click();
  await page.locator('#bot-name').fill('办公室群');
  await page.locator('.bot-form').getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.bot-card[data-bot="办公室群"]')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.locator('.bot-card[data-bot="办公室群"]').getByRole('button', { name: '删除' }).click();
  await expect(page.locator('.bot-card[data-bot="办公室群"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('成员列表：登录方式（微信 / QQ / 邮箱）、手机号；微信 / QQ 用户不显示空邮箱', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'members');
  const li = page.locator('.mrow[data-member="李同学"]');
  await expect(li.locator('.ltag')).toHaveText(['微信']);
  await expect(li.locator('.login-sub')).toHaveText('「小李」');
  const zhang = page.locator('.mrow[data-member="张伟"]');
  await expect(zhang.locator('.ltag')).toHaveText(['QQ']);
  await expect(zhang.locator('.login-sub')).toContainText('13900000003');
  const chen = page.locator('.mrow[data-member="陈静"]');
  await expect(chen.locator('.ltag')).toHaveText(['邮箱']);
  await expect(chen.locator('.login-sub')).toHaveText('chenjing@stu.example.edu.cn');
  const wang = page.locator('.mrow[data-member="王老师"]');
  await expect(wang.locator('.ltag')).toHaveText(['微信', '邮箱']);
  // 待激活的人排在最前面
  await expect(page.locator('.mrow').first()).toHaveAttribute('data-member', '星星点灯');
  await page.locator('.mrow[data-member="星星点灯"]').getByRole('button', { name: '激活' }).click();
  await expect(page.locator('.mrow[data-member="星星点灯"]')).toContainText('已激活');
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/f-members.png`, fullPage: false });
});
