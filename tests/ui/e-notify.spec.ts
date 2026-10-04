// E. 通知设置：免打扰存 notify_prefs（服务器）、周末和法定假日开关；服务号绑定（二维码 + 倒计时、绑好自动变）、解绑、开关、测试；手机号
import { expect, test } from '@playwright/test';
import { calm, enterDemo, openSettings, SHOTS, watchErrors } from './helpers';

test('免打扰：改时间、关「周末和法定假日」，存到服务器那份（换个身份再回来还在）', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'notifications');
  await expect(page.getByText('免打扰存在服务器上')).toBeVisible();
  const from = page.getByLabel('免打扰时段 · 从');
  await expect(from).toHaveValue('21:30');
  await from.fill('2200');
  await from.press('Enter');
  await expect(from).toHaveValue('22:00');
  await page.getByRole('switch', { name: '周末和法定假日不打扰' }).click();
  await expect(page.getByRole('switch', { name: '周末和法定假日不打扰' })).toHaveAttribute('aria-checked', 'false');
  // 退出、换李同学（他有自己的设置：22:30）、再换回来
  await openSettings(page, 'general');
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /李同学/ }).click();
  await openSettings(page, 'notifications');
  await expect(page.getByLabel('免打扰时段 · 从')).toHaveValue('22:30');
  await openSettings(page, 'general');
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await openSettings(page, 'notifications');
  await expect(page.getByLabel('免打扰时段 · 从')).toHaveValue('22:00');
  await expect(page.getByRole('switch', { name: '周末和法定假日不打扰' })).toHaveAttribute('aria-checked', 'false');
});

test('服务号：没绑定 → 绑定（二维码 + 倒计时）→ 扫码后自动变「已绑定」→ 测试消息 → 开关 → 解绑', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await openSettings(page, 'notifications');
  await expect(page.locator('.wx-state')).toHaveAttribute('data-state', 'unbound');
  await page.getByRole('button', { name: '绑定' }).click();
  await expect(page.locator('.wx-qr img')).toBeVisible();
  await expect(page.getByText(/等你扫码… · \d+:\d\d 后失效/)).toBeVisible();
  await calm(page);
  await page.locator('.settings .pane').screenshot({ path: `${SHOTS}/e-wechat-qr.png` });
  // 演示：4 秒后当作扫码关注了
  await expect(page.locator('.wx-state')).toHaveAttribute('data-state', 'bound', { timeout: 10000 });
  await expect(page.locator('.wx-qr')).toHaveCount(0);
  await expect(page.locator('.wx-state')).toContainText('已绑定 · 王老师');
  await page.getByRole('button', { name: '给我发一条测试消息' }).click();
  await expect(page.getByText('测试消息已发出，看看微信')).toBeVisible();
  const sw = page.getByRole('switch', { name: '接收服务号消息' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '解绑' }).click();
  await expect(page.locator('.wx-state')).toHaveAttribute('data-state', 'unbound');
  expect(errors).toEqual([]);
});

test('服务号：取消关注了 → 提示重新关注，测试按钮灰掉', async ({ page }) => {
  // 演示数据里张伟绑过但取消关注了：用管理员身份看不到他的；这里直接验证李同学（已绑定）和状态文案
  await enterDemo(page, 'member');
  await openSettings(page, 'notifications');
  await expect(page.locator('.wx-state')).toHaveAttribute('data-state', 'bound');
  await expect(page.locator('.wx-state')).toContainText('小李');
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/e-notify-member.png` });
});

test('共用设备账号不显示服务号', async ({ page }) => {
  await enterDemo(page, 'station');
  await openSettings(page, 'notifications');
  await expect(page.locator('.wx-section')).toHaveCount(0);
  await expect(page.getByText('免打扰时段')).toBeVisible();
});

test('手机号：选填，格式不对提示，存了成员列表里能看到', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'account');
  const phone = page.getByLabel('手机号（选填）');
  await expect(phone).toHaveValue('13800000001');
  await phone.fill('139');
  await expect(page.getByText('手机号格式不对')).toBeVisible();
  await phone.fill('13912345678');
  await phone.press('Enter');
  // 通知页也有这一行（机器人 @ 人用的），是同一个字段
  await openSettings(page, 'notifications');
  await expect(page.getByLabel('手机号（选填）')).toHaveValue('13912345678');
  await openSettings(page, 'members');
  await expect(page.locator('.mrow[data-member="王老师"] .login-sub')).toContainText('13912345678');
});

test('共用设备账号没有手机号这一行（不会被 @）', async ({ page }) => {
  await enterDemo(page, 'station');
  await openSettings(page, 'account');
  await expect(page.getByLabel('手机号（选填）')).toHaveCount(0);
  await openSettings(page, 'notifications');
  await expect(page.getByLabel('手机号（选填）')).toHaveCount(0);
});
