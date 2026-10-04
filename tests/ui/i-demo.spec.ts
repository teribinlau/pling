// I. 演示模式：「示例大学 · 计算机学院」（软件 2301 班 / 软件 2302 班 / 学院办公室；王老师管理员、李同学成员、实验室电脑共用设备；
//    称呼 班级 / 全院）。要能演示：已读回执、作业（按时 / 迟交 / 退回 / 通过 / 未交）、国庆放假和调休、讨论、附件、邀请码、机器人列表。
//    已读回执、作业、节假日、邀请码、机器人各自的流程在 C / F / G / H 里测；这里测演示场景本身和讨论、附件、共用设备。
import { expect, test } from '@playwright/test';
import { calm, enterDemo, openReminder, openSettings, SHOTS, switchUser, watchErrors } from './helpers';

// 收假后的第二个工作日傍晚：实验室值日（17:30）刚过点还没人做，日历上能看到国庆的「休」和 10 月 10 日调休的「班」
const CLOCK = new Date('2026-10-09T18:00:00+08:00');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('演示场景一览：机构名、三个班组、四个身份，各块数据都在', async ({ page }) => {
  const errors = watchErrors(page);
  await page.clock.setFixedTime(CLOCK);
  await page.goto('/');
  await expect(page.locator('.login .brand h1')).toHaveText('示例大学 · 计算机学院');
  await expect(page.locator('.login .brand-sub')).toHaveText('叮一下 · Pling');
  for (const who of ['以管理员「王老师」进入', '以学生「李同学」进入', '以共用设备「实验室电脑」进入', /以还没激活的新同学进入/]) {
    await expect(page.getByRole('button', { name: who })).toBeVisible();
  }
  await calm(page);
  await page.screenshot({ path: `${SHOTS}/i-demo-login.png` });
  await page.getByRole('button', { name: '以管理员「王老师」进入' }).click();
  await expect(page.locator('.banner')).toHaveText('演示模式 · 没有连接服务器，数据只在这台设备的内存里');
  await expect(page).toHaveTitle('示例大学 · 计算机学院 · 叮一下');
  // 国庆放假、调休上班（迷你月历）
  await expect(page.locator('.mini-month .cell[aria-label^="2026-10-01"] .hday')).toHaveText('休');
  await expect(page.locator('.mini-month .cell[aria-label^="2026-10-10"] .hday')).toHaveText('班');
  // 三个班组；称呼是「班级 / 全院」
  await page.locator('.rail .nav-btn[aria-label="看板"]').click();
  for (const name of ['软件 2301 班', '软件 2302 班', '学院办公室']) await expect(page.locator('.toolbar .chip', { hasText: name })).toBeVisible();
  // 已读回执、作业
  await openReminder(page, '国庆收假返校通知');
  await expect(page.locator('.detail .label')).toContainText('全院');
  await expect(page.locator('.reads-count')).toHaveText('已读 10 / 13');
  await openReminder(page, '实验一报告');
  await expect(page.locator('.hw-row .hw-pill')).toHaveText(['已交', '迟交', '已交', '已交', '已退回', '未交', '已通过', '已通过']);
  // 讨论：进行中 2 个、已结束 1 个
  await page.locator('.rail .nav-btn[aria-label="讨论"]').click();
  await expect(page.locator('.dlist-tabs [role=tab]')).toHaveText([/进行中\s*2/, /已结束\s*1/]);
  // 邀请码、机器人
  await openSettings(page, 'invites');
  await expect(page.locator('.inv-card')).toHaveCount(4);
  await openSettings(page, 'bots');
  await expect(page.locator('.bot-card')).toHaveCount(3);
  await expect(page.locator('.bot-kind-tag')).toHaveText(['企业微信', '钉钉', '飞书']);
  expect(errors).toEqual([]);
});

test('讨论：正文附件点开看大图、留言带图片、已结束的显示结论', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await page.locator('.rail .nav-btn[aria-label="讨论"]').click();
  await page.locator('.ditem', { hasText: '运动会方阵口号征集' }).click();
  await expect(page.locator('.dpost-title')).toHaveText('运动会方阵口号征集，大家投个票');
  await expect(page.locator('.dpost .ddue')).toBeVisible();
  // 正文附件：方阵草图 → 大图
  await page.locator('.dpost .thumb-img').click();
  await expect(page.getByRole('dialog', { name: '方阵草图.jpg' })).toBeVisible();
  await expect(page.locator('.viewer-img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.viewer')).toHaveCount(0);
  // 留言：共用设备上留的署名周婷、注明是哪台设备
  const comments = page.locator('.dcomment');
  await expect(comments).toHaveCount(4);
  await expect(comments.last().locator('.dc-name')).toHaveText('周婷');
  await expect(comments.last().locator('.dc-via')).toHaveText('实验室电脑');
  // 发一条带图片的留言
  await page.getByRole('textbox', { name: '写留言…' }).fill('口号就定张伟这个，周三前交给体育委员。');
  await page.locator('.dcomposer input[type=file]').first().setInputFiles({ name: '口号定稿.png', mimeType: 'image/png', buffer: PNG_1PX });
  await expect(page.locator('.dcomposer .tray-item')).toHaveCount(1);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(comments).toHaveCount(5);
  await expect(comments.last()).toHaveClass(/mine/);
  await expect(comments.last().locator('.dc-body')).toHaveText('口号就定张伟这个，周三前交给体育委员。');
  await expect(comments.last().locator('img')).toHaveAttribute('alt', '口号定稿.png');
  await expect(page.locator('.ditem', { hasText: '运动会方阵口号征集' }).locator('.ditem-sub')).toHaveText('王老师：口号就定张伟这个，周三前交给体育委员。');
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/i-discussion.png` });
  // 已结束的讨论：列表里预览结论，打开只读
  await page.getByRole('tab', { name: /已结束/ }).click();
  await expect(page.locator('.ditem .ditem-sub')).toHaveText('结论：工作日开放到 21:30，最后走的同学负责关电脑断电。');
  await page.locator('.ditem', { hasText: '实验室晚上开放到几点' }).click();
  await expect(page.locator('.dclosed')).toContainText('工作日开放到 21:30');
  await expect(page.locator('.dt-readonly')).toHaveText(/讨论已结束/);
  await expect(page.getByRole('textbox', { name: '写留言…' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('共用设备留言要先选署名，留言记在所选的人名下', async ({ page }) => {
  await enterDemo(page, 'station');
  await page.locator('.rail .nav-btn[aria-label="讨论"]').click();
  await page.locator('.ditem', { hasText: '运动会方阵口号征集' }).click();
  await page.getByRole('textbox', { name: '写留言…' }).fill('我报 4×100 接力。');
  const send = page.getByRole('button', { name: '发送' });
  await expect(send).toBeDisabled();
  await page.getByRole('combobox', { name: '署名' }).selectOption('张伟');
  await expect(send).toBeEnabled();
  await send.click();
  const last = page.locator('.dcomment').last();
  await expect(last.locator('.dc-body')).toHaveText('我报 4×100 接力。');
  await expect(last.locator('.dc-name')).toHaveText('张伟');
  await expect(last.locator('.dc-via')).toHaveText('实验室电脑');
});

test('附件：大家都能看、点开看大图；只有创建人 / 管理员能加、能删', async ({ page }) => {
  const errors = watchErrors(page);
  await enterDemo(page, 'admin');
  await openReminder(page, '实验一报告');
  const att = page.locator('.detail .field', { has: page.locator('.kicker', { hasText: '附件 ·' }) });
  await expect(att.locator('.kicker')).toHaveText('附件 · 2');
  await expect(att.locator('.sub-name')).toHaveText('实验一要求.pdf');
  await att.locator('.thumb-img').click();
  await expect(page.getByRole('dialog', { name: '单链表示意图.jpg' })).toBeVisible();
  await page.keyboard.press('Escape');
  // 老师再加一份
  await att.locator('input[type=file]').setInputFiles({ name: '实验报告模板.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('demo docx') });
  await expect(att.locator('.kicker')).toHaveText('附件 · 3');
  await expect(att.locator('.sub-name')).toHaveText(['实验一要求.pdf', '实验报告模板.docx']);
  await expect(att.getByRole('button', { name: '删除' })).toHaveCount(3);
  // 学生：能看、能下载，不能加、不能删
  await switchUser(page, 'member');
  await page.goto('/?r=demo-hw1');
  await page.getByRole('button', { name: /李同学/ }).click();
  await expect(page.locator('.detail h2')).toContainText('实验一报告');
  const att2 = page.locator('.detail .field', { has: page.locator('.kicker', { hasText: '附件 ·' }) });
  // 刷新过页面：演示数据回到初始的两份（演示数据只在内存里）
  await expect(att2.locator('.kicker')).toHaveText('附件 · 2');
  await expect(att2.getByRole('button', { name: '添加文件' })).toHaveCount(0);
  await expect(att2.getByRole('button', { name: '删除' })).toHaveCount(0);
  await expect(att2.getByRole('button', { name: '下载' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('共用设备点完成：先选是谁做的，完成记录写那个人的名字', async ({ page }) => {
  await page.clock.setFixedTime(CLOCK);
  await enterDemo(page, 'station');
  await page.locator('.rail .nav-btn[aria-label="看板"]').click();
  const duty = page.locator('.group', { hasText: '逾期' }).locator('.card', { hasText: '实验室值日' });
  await expect(duty).toHaveCount(1);
  await duty.locator('.check').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('谁完成的？');
  // 同班的人（兼任也算：王老师兼 2301 班主任）排在前面，别的班 / 办公室的在后面
  const names = (await dialog.locator('.opt-card b').allInnerTexts()).map((s) => s.trim());
  expect(names.slice(0, 8).sort()).toEqual(['王老师', '李同学', '张伟', '陈静', '刘洋', '杨帆', '黄磊', '周婷'].sort());
  expect(names.slice(8).sort()).toEqual(['赵老师', '林主任', '吴昊', '徐丽', '孙鹏', '马欣'].sort());
  await calm(page, true);
  await page.screenshot({ path: `${SHOTS}/i-station-picker.png` });
  await dialog.getByRole('button', { name: '黄磊' }).click();
  await expect(dialog).toHaveCount(0);
  const done = page.locator('.group', { hasText: '已完成' }).locator('.card', { hasText: '实验室值日' }).first();
  await expect(done.locator('.time-sub')).toHaveText('黄磊 完成');
  await done.click();
  await expect(page.locator('.detail .time-block .ok')).toHaveText('已完成 · 黄磊');
});
