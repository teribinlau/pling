// G. 已读回执：打开详情（窗口可见且有焦点）→ 记已读；?r=<提醒>&o=<ISO> 直接打开那一次、然后清掉参数；
//    创建人 / 管理员在详情里看「已读 x / y」和名单；共用设备不记；私人的不显示
import { expect, test, type Page } from '@playwright/test';
import { calm, enterDemo, openReminder, SHOTS, watchErrors } from './helpers';

async function readCount(page: Page): Promise<string> {
  return (await page.locator('.reads-count').innerText()).trim();
}

test('管理员看已读回执：「已读 x / y」+ 已读 / 未读名单（受众 = 全院激活的成员，不含发通知的人、共用设备、没激活的）', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await openReminder(page, '国庆收假返校通知');
  // 全院 14 个激活的人（16 个账号 - 王老师自己 - 实验室电脑；星星点灯没激活不算）
  await expect(page.locator('.reads-count')).toHaveText('已读 10 / 13');
  await page.getByRole('button', { name: '看名单' }).click();
  await expect(page.locator('.reads-group').first().locator('.pchip-name')).toHaveCount(10);
  const unread = page.locator('.reads-group').nth(1);
  await expect(unread.locator('.scope-sub')).toHaveText('未读 · 3');
  const names = (await unread.locator('.pchip-name').allInnerTexts()).sort();
  expect(names).toEqual(['杨帆', '马欣', '黄磊'].sort());
  expect(errors).toEqual([]);
  await calm(page);
  await page.locator('.detail').screenshot({ path: `${SHOTS}/g-reads.png` });
});

test('学生打开详情 → 记已读 → 老师那边数字 +1', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openReminder(page, '班会：校运动会报名');
  await expect(page.locator('.reads-count')).toHaveText('已读 3 / 7');
  // 换李同学：看不到回执，但打开就算读了
  await page.locator('.rail-me').click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /李同学/ }).click();
  await openReminder(page, '班会：校运动会报名');
  await expect(page.locator('.reads')).toHaveCount(0);
  await page.locator('.rail-me').click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await openReminder(page, '班会：校运动会报名');
  await expect(page.locator('.reads-count')).toHaveText('已读 4 / 7');
  await page.getByRole('button', { name: '看名单' }).click();
  await expect(page.locator('.reads-group').first()).toContainText('李同学');
});

test('窗口在后台（没有焦点）打开详情不算读', async ({ page }) => {
  await enterDemo(page, 'member');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
  });
  await openReminder(page, '班会：校运动会报名');
  await page.locator('.rail-me').click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await openReminder(page, '班会：校运动会报名');
  expect(await readCount(page)).toBe('已读 3 / 7');
});

test('共用设备打开不记已读', async ({ page }) => {
  await enterDemo(page, 'station');
  await openReminder(page, '班会：校运动会报名');
  await page.locator('.rail-me').click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await openReminder(page, '班会：校运动会报名');
  expect(await readCount(page)).toBe('已读 3 / 7');
});

test('私人提醒不显示已读回执', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openReminder(page, '准备期中考试卷');
  await expect(page.locator('.reads')).toHaveCount(0);
});

test('?r=&o=：服务号 / 机器人消息里的链接，打开就定位到那一次，然后参数清掉', async ({ page }) => {
  // 先拿到实验一的到期时间（ISO）
  await enterDemo(page, 'admin');
  const iso = await page.evaluate(async () => {
    const entry = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/lib/store.ts'));
    const mod = await import(/* @vite-ignore */ entry ?? '/src/lib/store.ts');
    return (mod.useStore.getState().reminders as { id: string; due_at: string }[]).find((r) => r.id === 'demo-hw1')!.due_at;
  });
  await page.goto(`/?r=demo-hw1&o=${encodeURIComponent(iso)}&utm=wx`);
  await page.getByRole('button', { name: /李同学/ }).click();
  await expect(page.locator('.detail h2')).toHaveText('数据结构 · 实验一报告（单链表）');
  await expect.poll(() => new URL(page.url()).search).toBe('?utm=wx');
  // 李同学打开了 → 算读过
  await page.locator('.rail-me').click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('button', { name: /王老师/ }).click();
  await openReminder(page, '实验一报告');
  await expect(page.locator('.reads-count')).toHaveText('已读 3 / 7');
});

test('?r= 指向看不到 / 不存在的提醒：提示找不到', async ({ page }) => {
  await page.goto('/?r=demo-exam'); // 王老师的私人提醒，李同学看不到
  await page.getByRole('button', { name: /李同学/ }).click();
  await expect(page.getByText('找不到这条提醒')).toBeVisible();
  await expect(page.locator('.detail h2')).toHaveCount(0);
});

test('手机上点链接打开：详情从底下滑出来', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?r=demo-meeting');
  await page.getByRole('button', { name: /王老师/ }).click();
  await expect(page.locator('.detail.open h2')).toContainText('班会');
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/g-deeplink-phone.png` });
});
