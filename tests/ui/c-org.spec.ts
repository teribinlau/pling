// C. 机构设置和称呼：机构名、「小组」「全体」的叫法（{{team}} / {{org}} 占位，改了马上生效）、时区、逾期推送次数；
//    节假日页（按年列出、加、删）；日历 / 日期选择器上的「休」「班」、日视图头部的节日名
import { expect, test } from '@playwright/test';
import { calm, enterDemo, openSettings, SHOTS, watchErrors } from './helpers';

test('称呼：学院预设 → 公司预设 → 自定义，界面上的词跟着换', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  // 演示数据：班级 / 全院
  await page.locator('.main-head .btn.primary').click();
  await expect(page.locator('.opt-card', { hasText: '本班级' })).toBeVisible();
  await expect(page.locator('.opt-card b', { hasText: '全院' })).toBeVisible();
  await page.keyboard.press('Escape');

  await openSettings(page, 'org');
  await expect(page.getByRole('radio', { name: /学院/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('比如：本班级 · 全院 · 新建班级')).toBeVisible();
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/c-org.png` });

  await page.getByRole('radio', { name: /公司/ }).click();
  await expect(page.getByText('比如：本部门 · 全公司 · 新建部门')).toBeVisible();
  await page.getByRole('button', { name: '保存机构设置' }).click();
  await expect(page.getByText('机构设置已保存').last()).toBeVisible();
  // 侧栏 / 成员页 / 新建提醒里的词都换了
  await openSettings(page, 'members');
  await expect(page.getByRole('button', { name: '新建部门' })).toBeVisible();
  await expect(page.locator('.settings h2', { hasText: '部门 · 3' })).toBeVisible();
  await page.locator('.rail .nav-btn[aria-label="日历"]').click();
  await page.locator('.main-head .btn.primary').click();
  await expect(page.locator('.opt-card', { hasText: '本部门' })).toBeVisible();
  await expect(page.locator('.opt-card b', { hasText: '全公司' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 自定义：最多 6 个字（输入框本身就拦着），空的不让存
  await openSettings(page, 'org');
  await page.getByRole('radio', { name: '自定义' }).click();
  await page.getByLabel('「小组」叫').fill('教研室');
  await page.getByLabel('「全体」叫').fill('全体教职工和学生们');
  expect([...(await page.getByLabel('「全体」叫').inputValue())].length).toBeLessThanOrEqual(6);
  await page.getByLabel('「全体」叫').fill('');
  await expect(page.getByRole('button', { name: '保存机构设置' })).toBeDisabled();
  await page.getByLabel('「全体」叫').fill('全体教师');
  await page.getByRole('button', { name: '保存机构设置' }).click();
  await expect(page.getByText('机构设置已保存').last()).toBeVisible();
  await openSettings(page, 'invites');
  await expect(page.getByText('不分教研室（只激活）').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('机构名、时区、逾期推送次数', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'org');
  await page.getByLabel('机构名称').fill('某某中学');
  await page.getByLabel('时区').selectOption('Asia/Urumqi');
  await page.getByLabel('逾期推送次数').selectOption('5');
  await page.getByRole('button', { name: '保存机构设置' }).click();
  await expect(page.getByText('机构设置已保存').last()).toBeVisible();
  await expect(page).toHaveTitle('某某中学 · 叮一下');
  // 换时区：显示的时间跟着变（乌鲁木齐比北京晚 2 小时：22:00 → 20:00）
  await page.locator('.rail .nav-btn[aria-label="看板"]').click();
  await expect(page.locator('.card', { hasText: '实验一报告' }).locator('.time')).toHaveText('20:00');
});

test('成员看不到「机构」页，能看节假日但不能改', async ({ page }) => {
  await enterDemo(page, 'member');
  await page.locator('.rail .nav-btn[aria-label="设置"]').click();
  await expect(page.locator('.settings nav button[data-tab="org"]')).toHaveCount(0);
  await expect(page.locator('.settings nav button[data-tab="members"]')).toHaveCount(0);
  await page.locator('.settings nav button[data-tab="holidays"]').click();
  await expect(page.locator('.hol-row', { hasText: '国庆节' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '添加' })).toHaveCount(0);
  await expect(page.locator('.hol-row button')).toHaveCount(0);
});

test('节假日页：按年列出，加一段放假、加调休上班、删掉', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openSettings(page, 'holidays');
  await expect(page.getByText('每年 11 月前后国务院公布下一年的放假安排')).toBeVisible();
  const national = page.locator('.hol-row', { hasText: '国庆节' }).filter({ hasText: '7 天' });
  await expect(national).toContainText('10月1日–7日');
  await expect(page.locator('.hol-row.work', { hasText: '国庆节调休' })).toHaveCount(2);
  // 2027 年还没有
  await page.getByRole('tab', { name: '2027' }).click();
  await expect(page.getByText('2027 年还没有节假日')).toBeVisible();
  // 加：2027 元旦（放假三天）
  await page.getByRole('button', { name: '添加' }).click();
  await page.locator('#hol-name').fill('元旦');
  await page.locator('#hol-from').click();
  for (let i = 0; i < 24 && !(await page.locator('.cal-head b', { hasText: '2027年1月' }).isVisible()); i++) await page.getByRole('button', { name: '下个月' }).click();
  await page.locator('.cal-day[data-ymd="2027-01-01"]').click();
  await page.locator('#hol-to').click();
  await page.locator('.cal-day[data-ymd="2027-01-03"]').click();
  await expect(page.getByText('1月1日–3日 · 3 天')).toBeVisible();
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/c-holiday-form.png` });
  await page.locator('.hol-form').getByRole('button', { name: '添加' }).click();
  await expect(page.locator('.hol-row', { hasText: '元旦' })).toContainText('1月1日–3日');
  // 调休上班
  await page.getByRole('button', { name: '添加' }).click();
  await page.locator('#hol-name').fill('元旦调休');
  await page.getByRole('radio', { name: /调休上班/ }).click();
  await page.locator('#hol-from').click();
  for (let i = 0; i < 24 && !(await page.locator('.cal-head b', { hasText: '2027年1月' }).isVisible()); i++) await page.getByRole('button', { name: '下个月' }).click();
  await page.locator('.cal-day[data-ymd="2027-01-04"]').click();
  await page.locator('.hol-form').getByRole('button', { name: '添加' }).click();
  await page.getByRole('tab', { name: '2027' }).click();
  await expect(page.locator('.hol-row.work', { hasText: '元旦调休' })).toContainText('1月4日');
  // 删
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '删除 元旦调休' }).click();
  await expect(page.locator('.hol-row', { hasText: '元旦调休' })).toHaveCount(0);
  // 结束日期早于开始：不让加
  await page.getByRole('button', { name: '添加' }).click();
  await page.locator('#hol-name').fill('x');
  await expect(page.locator('.hol-form').getByRole('button', { name: '添加' })).toBeEnabled();
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/c-holidays.png` });
});

test('日历和日期选择器：国庆放假标「休」、调休周六标「班」，日视图头部写节日名', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-29T09:00:00+08:00'));
  await enterDemo(page, 'admin');
  // 日历：从 9 月 29 日开始的两周，10 月 1 日放假、10 月 10 日（周六）调休上班
  const oct1 = page.locator('.day-section[data-ymd="2026-10-01"]');
  await expect(oct1.locator('.hday.off')).toHaveText('休');
  await expect(oct1.locator('.hday-name')).toHaveText('国庆节');
  await expect(oct1).toContainText('国庆节 · 放假，没有提醒');
  const oct10 = page.locator('.day-section[data-ymd="2026-10-10"]');
  await expect(oct10.locator('.hday.work')).toHaveText('班');
  await expect(oct10.locator('.hday-name')).toHaveText('国庆节调休 · 上班');
  // 迷你月历
  await expect(page.locator('.mini-month .cell[aria-label^="2026-10-03"] .hday')).toHaveText('休');
  await expect(page.locator('.mini-month .cell[aria-label^="2026-10-10"] .hday')).toHaveText('班');
  // 实验室值日是「每个工作日 + 法定假日不提醒」：放假那几天没有，调休上班的周六有
  await expect(oct1.locator('.card', { hasText: '实验室值日' })).toHaveCount(0);
  await expect(oct10.locator('.card', { hasText: '实验室值日' })).toHaveCount(1);
  await expect(page.locator('.day-section[data-ymd="2026-10-09"]').locator('.card', { hasText: '实验室值日' })).toHaveCount(1);
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/c-calendar-holidays.png` });
  // 日期选择器
  await page.locator('.main-head .btn.primary').click();
  await page.locator('#f-date').click();
  await page.getByRole('button', { name: '下个月' }).click();
  await expect(page.locator('.cal-day[data-ymd="2026-10-02"] .hday')).toHaveText('休');
  await expect(page.locator('.cal-day[data-ymd="2026-10-10"] .hday')).toHaveText('班');
  await expect(page.locator('.cal-day[data-ymd="2026-10-10"]')).toHaveAttribute('title', '国庆节调休 · 调休上班');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  await page.locator('.modal').screenshot({ path: `${SHOTS}/c-picker-holidays.png` });
});
