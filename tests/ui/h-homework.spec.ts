// H. 作业统计：创建人 / 管理员在需要回传的提醒里看 应交 / 已交（按时 / 迟交）/ 未交 / 退回 / 通过 + 进度条，
//    每人一行：状态、时间、文件、「通过」、「退回（写一句批语）」；退回会撤掉那个人这一次的完成；
//    导出名单（CSV，UTF-8 BOM）、复制表格（TSV）；交作业的人看到自己的状态和批语，退回后可以重交；
//    共用设备交的按所选名字认；卡片上创建人看到「已交 n/总数」
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { calm, enterDemo, openReminder, SHOTS, switchUser, watchErrors } from './helpers';

const HW1 = '数据结构 · 实验一报告（单链表）';

/** 统计格子：{ 应交: 7, 已交: 5, … } */
async function stats(page: Page): Promise<Record<string, number>> {
  return page.locator('.hw-stat').evaluateAll((els) =>
    Object.fromEntries(
      els.map((el) => {
        const label = (el.querySelector('span')?.firstChild?.textContent ?? '').trim();
        return [label, Number(el.querySelector('b')?.textContent ?? 'NaN')];
      }),
    ),
  );
}

const row = (page: Page, name: string) => page.locator(`.hw-row[data-person="${name}"]`);

test('老师看实验一的统计：应交 7 / 已交 5（按时 4 · 迟交 1）/ 未交 1 / 退回 1 / 通过 2，每人一行', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  await expect(page.locator('.homework .kicker').first()).toHaveText('作业统计');
  expect(await stats(page)).toEqual({ 应交: 7, 已交: 5, 未交: 1, 退回: 1, 通过: 2 });
  await expect(page.locator('.hw-stat.good small')).toHaveText('按时 4 · 迟交 1');
  await expect(page.locator('.hw-progress .hint-text')).toHaveText('收齐 5 / 7 · 待批 3');
  // 排序：待批在前（陈静 / 杨帆 / 张伟），然后退回、未交、通过
  expect(await page.locator('.hw-row .hw-name').allInnerTexts()).toEqual(['陈静', '杨帆', '张伟', '刘洋', '黄磊', '李同学', '周婷']);
  // 迟交 = 第一次交的时间晚于截止；杨帆第一次是按时交的，退回后重交不算迟交
  await expect(row(page, '陈静').locator('.hw-pill.late')).toHaveText('迟交');
  await expect(row(page, '杨帆').locator('.hw-pill.late')).toHaveCount(0);
  await expect(row(page, '杨帆').locator('.hw-meta')).toContainText('重新提交');
  await expect(row(page, '刘洋').locator('.hw-pill.returned')).toHaveText('已退回');
  await expect(row(page, '刘洋').locator('.hw-note')).toContainText('批语：缺运行截图，补上再交');
  await expect(row(page, '黄磊').locator('.hw-pill.missing')).toHaveText('未交');
  await expect(row(page, '黄磊').locator('.hw-acts')).toHaveCount(0);
  // 共用设备（实验室电脑）上交的，按所选的名字记在周婷名下
  await expect(row(page, '周婷').locator('.hw-pill.accepted')).toHaveText('已通过');
  await expect(row(page, '周婷').locator('.hw-file')).toHaveText('IMG_2041.jpg');
  // 李同学交了两个文件（报告 + 源码）
  await expect(row(page, '李同学').locator('.hw-meta')).toContainText('2 个文件');
  expect(errors).toEqual([]);
  await calm(page);
  await page.locator('.homework').screenshot({ path: `${SHOTS}/h-homework-teacher.png` });
  await page.screenshot({ path: `${SHOTS}/h-homework-teacher-full.png` });
});

test('卡片上创建人看到「已交 n/总数」：看板的实验一、日历里的高数习题', async ({ page }) => {
  await enterDemo(page, 'admin');
  await page.locator('.rail .nav-btn[aria-label="看板"]').click();
  await expect(page.locator('.card', { hasText: '实验一报告' }).locator('.label')).toContainText('已交 5/7');
  // 日历（默认从今天开始两周）：高数第三章习题是赵老师布置的，管理员也能看统计：2302 班 5 个人（含兼管的林主任）交了 2 个
  await page.locator('.rail .nav-btn[aria-label="日历"]').click();
  await expect(page.locator('.card', { hasText: '高等数学' }).locator('.meta-pill')).toHaveText('已交 2/5');
});

test('通过 / 退回：退回要写批语，数字跟着变', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  await page.getByRole('button', { name: '通过 张伟' }).click();
  await expect(row(page, '张伟').locator('.hw-pill.accepted')).toHaveText('已通过');
  expect(await stats(page)).toEqual({ 应交: 7, 已交: 5, 未交: 1, 退回: 1, 通过: 3 });

  await page.getByRole('button', { name: '退回 陈静' }).click();
  const box = page.getByRole('textbox', { name: '退回 陈静 的作业' });
  await expect(box).toBeFocused();
  // 没写批语不能退回
  await expect(page.getByRole('button', { name: '退回重交' })).toBeDisabled();
  await box.fill('格式不对，按模板重新排一下');
  await page.getByRole('button', { name: '退回重交' }).click();
  await expect(row(page, '陈静').locator('.hw-pill.returned')).toHaveText('已退回');
  await expect(row(page, '陈静').locator('.hw-note')).toContainText('批语：格式不对，按模板重新排一下');
  await expect(row(page, '陈静').locator('.hw-note')).toContainText('王老师 批改');
  // 退回的不算交了：已交 4（按时 4 · 迟交 0），退回 2
  expect(await stats(page)).toEqual({ 应交: 7, 已交: 4, 未交: 1, 退回: 2, 通过: 3 });
  await expect(page.locator('.hw-stat.good small')).toHaveText('按时 4 · 迟交 0');
  // 完成记录里陈静那一条也撤掉了
  await expect(page.locator('.detail .history')).not.toContainText('陈静');
});

test('退回 → 学生看到「已退回」和批语、完成被撤掉 → 重交 → 老师那边变回「已交」', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  await page.getByRole('button', { name: '退回 李同学' }).click();
  await page.getByRole('textbox', { name: '退回 李同学 的作业' }).fill('请补上测试用例和运行截图');
  await page.getByRole('button', { name: '退回重交' }).click();
  await expect(row(page, '李同学').locator('.hw-pill.returned')).toBeVisible();

  await switchUser(page, 'member');
  // 完成记录撤掉了：实验一回到看板的「逾期」里，卡片上写着自己的状态
  await page.locator('.rail .nav-btn[aria-label="看板"]').click();
  const card = page.locator('.group', { hasText: '逾期' }).locator('.card', { hasText: '实验一报告' });
  await expect(card.locator('.label')).toContainText('已退回');
  await card.click();
  await expect(page.locator('.detail h2')).toHaveText(HW1);
  const mine = page.locator('.my-hw');
  await expect(mine.locator('.hw-pill.returned')).toHaveText('已退回');
  await expect(mine).toContainText('被退回了，请改好重新提交');
  await expect(mine.locator('.hw-note')).toContainText('批语：请补上测试用例和运行截图');
  await expect(mine.locator('.hw-note')).toContainText('王老师 批改');
  // 学生看不到全班的统计和已读回执
  await expect(page.locator('.homework')).toHaveCount(0);
  await expect(page.locator('.reads')).toHaveCount(0);
  await calm(page);
  await page.locator('.my-hw').screenshot({ path: `${SHOTS}/h-homework-returned.png` });

  // 重交：主按钮变成「重新提交」→ 选文件 → 提交并完成
  await expect(page.locator('.detail .actions .btn.primary')).toHaveText(/重新提交/);
  await page.locator('.detail .actions input[type=file]').setInputFiles({ name: '实验一_李同学_改.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo') });
  await page.getByRole('button', { name: '提交并完成（1 个文件）' }).click();
  await expect(mine.locator('.hw-pill.submitted')).toHaveText('已交');
  await expect(mine).toContainText('已交，等待批改');
  // 第一次是按时交的：重交不算迟交
  await expect(mine.locator('.hw-pill.late')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撤销完成' })).toBeVisible();

  await switchUser(page, 'admin');
  await openReminder(page, '实验一报告');
  await expect(row(page, '李同学').locator('.hw-pill.submitted')).toHaveText('已交');
  await expect(row(page, '李同学').locator('.hw-meta')).toContainText('重新提交');
  await expect(row(page, '李同学').locator('.hw-file')).toHaveText('实验一_李同学_改.pdf');
  expect(await stats(page)).toEqual({ 应交: 7, 已交: 5, 未交: 1, 退回: 1, 通过: 1 });
  expect(errors).toEqual([]);
});

test('学生看自己的作业：已通过 + 批语 + 批改人', async ({ page }) => {
  // 李同学已经交过、完成了，实验一不在看板上：用服务号消息里的链接打开
  await enterDemo(page, 'member', { query: '?r=demo-hw1' });
  await expect(page.locator('.detail h2')).toHaveText(HW1);
  const mine = page.locator('.my-hw');
  await expect(mine.locator('.kicker')).toHaveText('我的作业');
  await expect(mine.locator('.hw-pill.accepted')).toHaveText('已通过');
  await expect(mine).toContainText('老师已通过');
  await expect(mine.locator('.hw-note')).toContainText('批语：思路清楚，注释可以再多写一点');
  await expect(mine.locator('.hw-note')).toContainText('王老师 批改');
  await expect(page.locator('.homework')).toHaveCount(0);
  // 通过了就不用再传
  await expect(page.getByRole('button', { name: '再传一份' })).toHaveCount(0);
  await calm(page);
  await page.locator('.detail').screenshot({ path: `${SHOTS}/h-homework-student.png` });
});

test('导出名单：CSV 带 UTF-8 BOM，列 = 姓名、班级、状态、提交时间、是否迟交、批语、文件数', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出名单' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^数据结构 · 实验一报告（单链表）_\d{4}-\d{2}-\d{2}_名单\.csv$/);
  const buf = await readFile((await download.path())!);
  expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = buf.toString('utf8').slice(1).split('\r\n');
  expect(lines[0]).toBe('姓名,班级,状态,提交时间,是否迟交,批语,文件数');
  expect(lines.filter(Boolean)).toHaveLength(8);
  const byName = Object.fromEntries(lines.slice(1).filter(Boolean).map((l) => [l.split(',')[0], l.split(',')]));
  expect(byName['陈静'].slice(1, 3)).toEqual(['软件 2301 班', '已交']);
  expect(byName['陈静'][3]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(byName['陈静'][4]).toBe('是');
  expect(byName['黄磊']).toEqual(['黄磊', '软件 2301 班', '未交', '', '', '', '0']);
  expect(byName['刘洋'].slice(2)).toEqual(['已退回', byName['刘洋'][3], '否', '缺运行截图，补上再交', '1']);
  expect(byName['李同学'].slice(4)).toEqual(['否', '思路清楚，注释可以再多写一点', '2']);
  await expect(page.locator('.toast', { hasText: '名单已导出' })).toBeVisible();
});

test('复制表格：制表符分隔，直接粘到 Excel / WPS', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  await page.getByRole('button', { name: '复制表格' }).click();
  await expect(page.locator('.toast', { hasText: '表格已复制' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split('\n');
  expect(lines[0].split('\t')).toEqual(['姓名', '班级', '状态', '提交时间', '是否迟交', '批语', '文件数']);
  expect(lines).toHaveLength(8);
  expect(lines.find((l) => l.startsWith('周婷\t'))!.split('\t')[2]).toBe('已通过');
});

test('共用设备替人交：选文件 → 选名字 → 记在那个人名下（迟交）', async ({ page }) => {
  await enterDemo(page, 'station', { query: '?r=demo-hw1' });
  await expect(page.locator('.detail h2')).toHaveText(HW1);
  // 共用设备看到全班谁还没交（按名字对）
  await expect(page.locator('.detail .hint-text.bad', { hasText: '未交：' })).toHaveText('未交：刘洋、黄磊');
  await page.locator('.detail .actions input[type=file]').setInputFiles({ name: 'IMG_3001.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  await page.getByRole('button', { name: '提交并完成（1 个文件）' }).click();
  await expect(page.getByRole('dialog')).toContainText('谁完成的？');
  await page.getByRole('dialog').getByRole('button', { name: '黄磊' }).click();
  await expect(page.locator('.detail .hint-text.bad', { hasText: '未交：' })).toHaveText('未交：刘洋');

  await switchUser(page, 'admin');
  await openReminder(page, '实验一报告');
  await expect(row(page, '黄磊').locator('.hw-pill.submitted')).toHaveText('已交');
  await expect(row(page, '黄磊').locator('.hw-pill.late')).toHaveText('迟交');
  await expect(row(page, '黄磊').locator('.hw-file')).toHaveText('IMG_3001.jpg');
  expect(await stats(page)).toEqual({ 应交: 7, 已交: 6, 未交: 0, 退回: 1, 通过: 2 });
  await expect(page.locator('.hw-stat.good small')).toHaveText('按时 4 · 迟交 2');
});

test('布置作业的老师不用交文件：直接「标记完成」= 收齐了', async ({ page }) => {
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  await expect(page.getByRole('button', { name: '选择要交的文件' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '附上照片 / 文件再完成' })).toHaveCount(0);
  await page.locator('.detail .actions').getByRole('button', { name: '标记完成' }).click();
  await expect(page.locator('.detail .actions').getByRole('button', { name: '撤销完成' })).toBeVisible();
  // 统计不受影响
  expect(await stats(page)).toEqual({ 应交: 7, 已交: 5, 未交: 1, 退回: 1, 通过: 2 });
});
