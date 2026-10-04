// 演示模式：没有连接服务器时用的内存数据。场景是「示例大学 · 计算机学院」：
//   班级：软件 2301 班、软件 2302 班、学院办公室（team_label = 班级，org_label = 全院）
//   王老师 = 管理员（学院办公室，兼任 2301 班主任）、李同学 = 2301 班学生、实验室电脑 = 共用设备
// 能演示：已读回执、作业（按时 / 迟交 / 退回 / 重交 / 通过 / 未交 / 共用设备代交）、国庆假期和调休、讨论、附件、邀请码、群机器人。
import QRCode from 'qrcode';
import {
  DISCUSSION_WINDOW_DAYS,
  RECENT_DAYS,
  randomInviteCode,
  type CommentDraft,
  type FileBucket,
  type InviteInput,
  type RedeemResult,
  type Repo,
  type Session,
  type Snapshot,
  type SubmissionMeta,
  type WebhookInput,
} from './repo';
import type {
  AppSettings,
  Assignee,
  Attachment,
  Completion,
  Discussion,
  DiscussionComment,
  DiscussionFile,
  DiscussionInput,
  DiscussionMember,
  DiscussionRead,
  LoginIdentity,
  NotifyPrefs,
  Profile,
  Reminder,
  ReminderInput,
  ReminderRead,
  Snooze,
  Submission,
  SubmissionStatus,
  Team,
  TeamInvite,
  TeamMembership,
  TeamWebhook,
  WechatBinding,
} from './types';
import { TZ } from './types';
import { CN_HOLIDAYS_2026, isRestDay, type Holiday } from './holidays';
import { localToUtc } from './recurrence';
import { toZonedTime } from 'date-fns-tz';
import type { AuthFinishResponse, AuthStartResponse, NotifyTestResponse, WechatBindResponse } from './functions';
import { FnError } from './functions';

const T_2301 = '11111111-1111-4111-8111-111111111111';
const T_2302 = '22222222-2222-4222-8222-222222222222';
const T_OFFICE = '33333333-3333-4333-8333-333333333333';

export const DEMO_USERS = {
  admin: 'u-wang',
  member: 'u-li',
  station: 'u-lab',
  newcomer: 'u-new',
};

/** 演示用的图：链表示意图 / 运动会方阵草图 / 实验室照片（现画的 SVG） */
const DEMO_LIST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700">
<rect width="1200" height="700" fill="#f6f5f1"/>
<text x="600" y="110" font-family="sans-serif" font-size="44" font-weight="800" text-anchor="middle" fill="#121212">单链表 · 插入结点</text>
${[0, 1, 2, 3].map((i) => `<rect x="${90 + i * 270}" y="270" width="190" height="110" rx="14" fill="${i === 2 ? '#e5322d' : '#121212'}"/><text x="${150 + i * 270}" y="340" font-family="monospace" font-size="40" font-weight="700" fill="#fff" text-anchor="middle">${['A', 'B', 'X', 'C'][i]}</text><rect x="${210 + i * 270}" y="270" width="70" height="110" rx="0" fill="#6f6c65"/>${i < 3 ? `<path d="M ${280 + i * 270} 325 L ${355 + i * 270} 325" stroke="#121212" stroke-width="8"/><path d="M ${345 + i * 270} 310 L ${360 + i * 270} 325 L ${345 + i * 270} 340" fill="none" stroke="#121212" stroke-width="8"/>` : ''}`).join('')}
<text x="600" y="520" font-family="sans-serif" font-size="32" text-anchor="middle" fill="#6f6c65">p->next = x; x->next = c;</text>
</svg>`;
const DEMO_FORMATION_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<rect width="1200" height="900" fill="#d7e8d0"/>
<rect x="80" y="80" width="1040" height="740" rx="40" fill="none" stroke="#fff" stroke-width="14"/>
${Array.from({ length: 6 }, (_, r) => Array.from({ length: 8 }, (_, c) => `<circle cx="${300 + c * 85}" cy="${260 + r * 80}" r="22" fill="${r === 0 ? '#e5322d' : '#121212'}"/>`).join('')).join('')}
<text x="600" y="180" font-family="sans-serif" font-size="46" font-weight="800" text-anchor="middle" fill="#121212">软件 2301 · 方阵草图</text>
</svg>`;
const DEMO_LAB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#e4e2dc"/>
${Array.from({ length: 4 }, (_, i) => `<rect x="${110 + i * 260}" y="300" width="200" height="130" rx="10" fill="#121212"/><rect x="${125 + i * 260}" y="315" width="170" height="100" fill="#0e7c6b"/><rect x="${180 + i * 260}" y="430" width="60" height="40" fill="#6f6c65"/>`).join('')}
<rect x="60" y="470" width="1080" height="40" fill="#a8560a"/>
<text x="600" y="190" font-family="sans-serif" font-size="46" font-weight="800" text-anchor="middle" fill="#121212">实验楼 A302</text>
</svg>`;

function uid(): string {
  return 'd-' + Math.random().toString(36).slice(2, 10);
}

/** 今天（机构时区）往后 dayOffset 天的 HH:mm，返回 ISO */
function at(dayOffset: number, hm: string): string {
  const now = toZonedTime(new Date(), TZ);
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  return localToUtc(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m).toISOString();
}

/** 今天往后 dayOffset 天的日期 YYYY-MM-DD（讨论的截止日期用） */
function ymdIn(dayOffset: number): string {
  const now = toZonedTime(new Date(), TZ);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 现在往前推 minutes 分钟，返回 ISO */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

/** 从今天往后（n > 0）/ 往前（n < 0）数第 |n| 个工作日（放假、不调休的周末都跳过），那天的 HH:mm —— 演示数据哪天打开都像样 */
function workdayAt(n: number, hm: string): string {
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  let off = 0;
  while (left > 0) {
    off += step;
    const ymd = ymdIn(off);
    if (!isRestDay(ymd, new Date(ymd + 'T00:00:00Z').getUTCDay())) left--;
  }
  return at(off, hm);
}

/** 某个时间前后几小时 */
function shift(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3600000).toISOString();
}

function discussion(p: Partial<Discussion> & { title: string; created_by: string; created_at: string }): Discussion {
  return {
    id: uid(),
    body: '',
    created_by_name: '',
    visibility: 'members',
    closed_at: null,
    conclusion: '',
    due_date: null,
    comment_count: 0,
    last_activity_at: p.created_at,
    last_activity_by: p.created_by,
    updated_at: p.created_at,
    ...p,
  };
}

function reminder(p: Partial<Reminder> & { title: string; due_at: string; created_by: string }): Reminder {
  return {
    id: uid(),
    notes: '',
    tz: TZ,
    rrule: null,
    skip_holidays: true,
    remind_before_min: 15,
    overdue_repeat_min: 30,
    priority: 'medium',
    visibility: 'team',
    team_id: null,
    link: '',
    completion_mode: 'any',
    require_upload: false,
    archived: false,
    source: null,
    source_key: null,
    created_at: ago(7 * 24 * 60),
    updated_at: ago(7 * 24 * 60),
    ...p,
  };
}

function person(p: Partial<Profile> & { id: string; name: string }): Profile {
  return {
    email: '',
    team_id: null,
    role: 'member',
    lang: 'zh-CN',
    is_station: false,
    active: true,
    phone: '',
    avatar_url: '',
    name_confirmed: true,
    ...p,
  };
}

function identity(user_id: string, provider: LoginIdentity['provider'], nickname: string, unionid = ''): LoginIdentity {
  return { provider, subject: `o${provider}-${user_id}`, unionid, user_id, nickname, avatar_url: '', created_at: ago(30 * 24 * 60), last_login_at: ago(60) };
}

interface DemoData extends Snapshot {
  /** 每个人的通知设置 / 服务号绑定（loadAll 只给自己的） */
  allPrefs: NotifyPrefs[];
  allBindings: WechatBinding[];
}

function buildData(): DemoData {
  const teams: Team[] = [
    { id: T_2301, name: '软件 2301 班', color: '#3B7A2A', sort: 1 },
    { id: T_2302, name: '软件 2302 班', color: '#1E5A8A', sort: 2 },
    { id: T_OFFICE, name: '学院办公室', color: '#A8560A', sort: 3 },
  ];
  const profiles: Profile[] = [
    person({ id: DEMO_USERS.admin, name: '王老师', email: 'wang.laoshi@example.edu.cn', team_id: T_OFFICE, role: 'admin', phone: '13800000001' }),
    person({ id: 'u-zhao', name: '赵老师', email: '', team_id: T_2302, role: 'admin', phone: '13800000002' }),
    person({ id: 'u-lin', name: '林主任', email: 'lin@example.edu.cn', team_id: T_OFFICE }),
    person({ id: DEMO_USERS.member, name: '李同学', team_id: T_2301 }),
    person({ id: 'u-zhang', name: '张伟', team_id: T_2301, phone: '13900000003' }),
    person({ id: 'u-chen', name: '陈静', email: 'chenjing@stu.example.edu.cn', team_id: T_2301 }),
    person({ id: 'u-liu', name: '刘洋', team_id: T_2301 }),
    person({ id: 'u-yang', name: '杨帆', team_id: T_2301 }),
    person({ id: 'u-huang', name: '黄磊', team_id: T_2301 }),
    person({ id: 'u-zhou', name: '周婷', email: 'zhouting@stu.example.edu.cn', team_id: T_2301 }),
    person({ id: 'u-wu', name: '吴昊', team_id: T_2302 }),
    person({ id: 'u-xu', name: '徐丽', team_id: T_2302 }),
    person({ id: 'u-sun', name: '孙鹏', email: 'sunpeng@stu.example.edu.cn', team_id: T_2302 }),
    person({ id: 'u-ma', name: '马欣', team_id: T_2302 }),
    person({ id: DEMO_USERS.station, name: '实验室电脑', email: 'lab-a302@example.edu.cn', team_id: T_2301, is_station: true }),
    // 刚用微信登录、还没激活的新同学：名字是微信昵称，进来先填真实姓名
    person({ id: DEMO_USERS.newcomer, name: '星星点灯', team_id: null, active: false, name_confirmed: false }),
  ];
  const identities: LoginIdentity[] = [
    identity(DEMO_USERS.admin, 'wechat_open', '王老师', 'un-wang'),
    identity('u-zhao', 'wechat_open', '赵老师', 'un-zhao'),
    identity('u-zhao', 'wechat_mp', '赵老师', 'un-zhao'),
    identity(DEMO_USERS.member, 'wechat_mp', '小李', 'un-li'),
    identity(DEMO_USERS.member, 'wechat_open', '小李', 'un-li'),
    identity('u-zhang', 'qq', '伟哥'),
    identity('u-liu', 'wechat_mp', '刘洋', 'un-liu'),
    identity('u-yang', 'wechat_mp', '帆', 'un-yang'),
    identity('u-huang', 'qq', '黄磊'),
    identity('u-wu', 'wechat_mp', '吴昊', 'un-wu'),
    identity('u-xu', 'qq', '丽丽'),
    identity('u-ma', 'wechat_mp', '马欣', 'un-ma'),
    identity(DEMO_USERS.newcomer, 'wechat_mp', '星星点灯', 'un-new'),
  ];
  // 王老师兼任 2301 班主任；林主任兼管 2302
  const memberships: TeamMembership[] = [
    { profile_id: DEMO_USERS.admin, team_id: T_2301 },
    { profile_id: 'u-lin', team_id: T_2302 },
  ];

  // ---------------------------------------------------------------------------
  // 提醒
  // ---------------------------------------------------------------------------
  const due1 = workdayAt(-1, '22:00');
  const hw1 = reminder({
    id: 'demo-hw1',
    title: '数据结构 · 实验一报告（单链表）',
    notes: '按附件里的要求完成实验一，报告和源代码一起交（PDF + 压缩包）。\n迟交会在名单里标出来；退回的请改好重新提交。',
    due_at: due1,
    remind_before_min: 1440,
    overdue_repeat_min: 0,
    priority: 'high',
    team_id: T_2301,
    completion_mode: 'each',
    require_upload: true,
    link: '实验要求（网盘） https://pan.example.edu.cn/s/lab1',
    created_by: DEMO_USERS.admin,
    created_at: shift(due1, -240),
  });
  const hw2 = reminder({
    id: 'demo-hw2',
    title: '高等数学 · 第三章习题',
    notes: '习题 3.1–3.4 单号题，拍照或扫描都行，一页一张。',
    due_at: workdayAt(3, '20:00'),
    remind_before_min: 1440,
    team_id: T_2302,
    completion_mode: 'each',
    require_upload: true,
    created_by: 'u-zhao',
    created_at: ago(2 * 24 * 60),
  });
  const notice = reminder({
    id: 'demo-notice',
    title: '国庆收假返校通知 — 收假后第一天正常上课',
    notes: '假期最后一天 21:00 前返校，在班级群里报平安。\n调休上班的周六按课表上课（日历上标「班」的那天）。',
    due_at: workdayAt(1, '07:30'),
    remind_before_min: 0,
    overdue_repeat_min: 0,
    visibility: 'company',
    team_id: T_OFFICE,
    created_by: DEMO_USERS.admin,
    created_at: ago(5 * 24 * 60),
  });
  const meeting = reminder({
    id: 'demo-meeting',
    title: '班会：校运动会报名和方阵训练',
    notes: '地点：教学楼 B204。体育委员带报名表。',
    due_at: workdayAt(1, '14:00'),
    remind_before_min: 30,
    team_id: T_2301,
    created_by: DEMO_USERS.admin,
    created_at: ago(24 * 60),
  });
  const duty = reminder({
    id: 'demo-duty',
    title: '实验室值日 — 关电脑、关窗、断电',
    notes: '实验楼 A302，最后走的同学负责，完成后在共用电脑上点完成。',
    due_at: at(-20, '17:30'),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    skip_holidays: true,
    remind_before_min: 15,
    team_id: T_2301,
    created_by: DEMO_USERS.admin,
    created_at: ago(30 * 24 * 60),
  });
  const weekly = reminder({
    id: 'demo-weekly',
    title: '周报 — 本周教学工作总结',
    due_at: at(-21, '16:00'),
    rrule: 'FREQ=WEEKLY;BYDAY=FR',
    skip_holidays: true,
    team_id: T_OFFICE,
    created_by: 'u-lin',
    created_at: ago(30 * 24 * 60),
  });
  const signup = reminder({
    id: 'demo-signup',
    title: '报名截止 · 校运动会（个人项目）',
    notes: '每人最多报两项，在线表格里填。',
    due_at: workdayAt(4, '17:00'),
    remind_before_min: 1440,
    visibility: 'company',
    team_id: T_OFFICE,
    link: '报名表 https://forms.example.edu.cn/sports-2026',
    created_by: 'u-lin',
    created_at: ago(3 * 24 * 60),
  });
  const calendarTask = reminder({
    id: 'demo-calendar',
    title: '提交本学期教学日历',
    due_at: workdayAt(-1, '17:00'),
    priority: 'high',
    team_id: T_OFFICE,
    created_by: 'u-lin',
    created_at: ago(6 * 24 * 60),
  });
  const exam = reminder({
    id: 'demo-exam',
    title: '准备期中考试卷（A / B 卷）',
    due_at: workdayAt(6, '12:00'),
    visibility: 'private',
    priority: 'low',
    team_id: T_OFFICE,
    created_by: DEMO_USERS.admin,
  });
  const collect = reminder({
    id: 'demo-collect',
    title: '收材料 · 奖学金申请表（签字扫描件）',
    due_at: workdayAt(2, '18:00'),
    remind_before_min: 60,
    visibility: 'company',
    team_id: T_OFFICE,
    completion_mode: 'each',
    require_upload: true,
    created_by: 'u-lin',
  });
  const reminders = [hw1, hw2, notice, meeting, duty, weekly, signup, calendarTask, exam, collect];
  const assignees: Assignee[] = [
    { id: uid(), reminder_id: hw1.id, user_id: null, team_id: T_2301 },
    { id: uid(), reminder_id: hw2.id, user_id: null, team_id: T_2302 },
    { id: uid(), reminder_id: meeting.id, user_id: null, team_id: T_2301 },
    { id: uid(), reminder_id: duty.id, user_id: DEMO_USERS.station, team_id: null },
    { id: uid(), reminder_id: duty.id, user_id: null, team_id: T_2301 },
    { id: uid(), reminder_id: weekly.id, user_id: null, team_id: T_OFFICE },
    { id: uid(), reminder_id: calendarTask.id, user_id: DEMO_USERS.admin, team_id: null },
    { id: uid(), reminder_id: calendarTask.id, user_id: 'u-zhao', team_id: null },
    { id: uid(), reminder_id: exam.id, user_id: DEMO_USERS.admin, team_id: null },
    { id: uid(), reminder_id: collect.id, user_id: DEMO_USERS.member, team_id: null },
    { id: uid(), reminder_id: collect.id, user_id: 'u-chen', team_id: null },
    { id: uid(), reminder_id: collect.id, user_id: 'u-wu', team_id: null },
  ];

  // ---------------------------------------------------------------------------
  // 作业：实验一（已经截止）—— 按时 / 迟交 / 退回 / 退回后重交 / 通过 / 共用设备代交 / 未交
  // ---------------------------------------------------------------------------
  const occ1 = hw1.due_at;
  const sub = (p: Partial<Submission> & { uploaded_by: string; file_name: string; created_at: string }): Submission => ({
    id: uid(),
    reminder_id: hw1.id,
    occurrence_at: occ1,
    uploaded_by_name: '',
    file_path: 'demo-file/' + uid(),
    size: 180000,
    mime: 'application/pdf',
    status: 'submitted',
    review_note: '',
    reviewed_by: null,
    reviewed_at: null,
    ...p,
  });
  const reviewed = shift(due1, 36);
  const submissions: Submission[] = [
    // 李同学：按时交，已通过
    sub({ uploaded_by: DEMO_USERS.member, file_name: '实验一_李同学.pdf', created_at: shift(due1, -26), status: 'accepted', review_note: '思路清楚，注释可以再多写一点', reviewed_by: DEMO_USERS.admin, reviewed_at: reviewed }),
    sub({ uploaded_by: DEMO_USERS.member, file_name: 'lab1_src.zip', mime: 'application/zip', size: 24000, created_at: shift(due1, -25.9), status: 'accepted', review_note: '思路清楚，注释可以再多写一点', reviewed_by: DEMO_USERS.admin, reviewed_at: reviewed }),
    // 张伟：卡着点按时交，还没批
    sub({ uploaded_by: 'u-zhang', file_name: '张伟-实验一.pdf', created_at: shift(due1, -0.5) }),
    // 陈静：迟交（截止后 11 小时）
    sub({ uploaded_by: 'u-chen', file_name: '实验一报告（陈静）.pdf', created_at: shift(due1, 11) }),
    // 刘洋：被退回，还没重交
    sub({ uploaded_by: 'u-liu', file_name: 'lab1-liuyang.pdf', created_at: shift(due1, -3), status: 'returned', review_note: '缺运行截图，补上再交', reviewed_by: DEMO_USERS.admin, reviewed_at: shift(reviewed, 0.2) }),
    // 杨帆：被退回后重交了（新的一批待批；第一次是按时交的，不算迟交）
    sub({ uploaded_by: 'u-yang', file_name: '杨帆_实验一.pdf', created_at: shift(due1, -3.3), status: 'returned', review_note: '第二题的时间复杂度写错了', reviewed_by: DEMO_USERS.admin, reviewed_at: shift(reviewed, 0.4) }),
    sub({ uploaded_by: 'u-yang', file_name: '杨帆_实验一_改.pdf', created_at: shift(due1, 70) }),
    // 周婷：在实验室共用电脑上交的（记在她名下），已通过
    sub({ uploaded_by: DEMO_USERS.station, uploaded_by_name: '周婷', file_name: 'IMG_2041.jpg', mime: 'image/jpeg', size: 820000, file_path: 'demo-img/lab.svg', created_at: shift(due1, -5), status: 'accepted', review_note: '', reviewed_by: DEMO_USERS.admin, reviewed_at: shift(reviewed, 0.5) }),
    // 黄磊：没交
    // 高数习题（还没截止）：两个人已经交了
    { ...sub({ uploaded_by: 'u-wu', file_name: '第三章_吴昊.jpg', mime: 'image/jpeg', file_path: 'demo-img/list.svg', created_at: ago(26 * 60) }), reminder_id: hw2.id, occurrence_at: hw2.due_at },
    { ...sub({ uploaded_by: 'u-xu', file_name: '高数第三章-徐丽.pdf', created_at: ago(3 * 60) }), reminder_id: hw2.id, occurrence_at: hw2.due_at },
  ];
  const completion = (r: Reminder, occ: string, by: string, when: string, name = ''): Completion => ({ id: uid(), reminder_id: r.id, occurrence_at: occ, completed_by: by, completed_by_name: name, completed_at: when, note: '' });
  const completions: Completion[] = [
    completion(hw1, occ1, DEMO_USERS.member, shift(due1, -25.9)),
    completion(hw1, occ1, 'u-zhang', shift(due1, -0.5)),
    completion(hw1, occ1, 'u-chen', shift(due1, 11)),
    completion(hw1, occ1, 'u-yang', shift(due1, 70)),
    completion(hw1, occ1, DEMO_USERS.station, shift(due1, -5), '周婷'),
    completion(hw2, hw2.due_at, 'u-wu', ago(26 * 60)),
    completion(hw2, hw2.due_at, 'u-xu', ago(3 * 60)),
  ];
  // 实验室值日：过去的工作日大多有人做了（放假的日子本来就不提醒；调休上班的周六照样要值日）
  for (let d = 1; d <= 14; d++) {
    const ymd = ymdIn(-d);
    if (isRestDay(ymd, new Date(ymd + 'T00:00:00Z').getUTCDay()) || d === 2) continue;
    completions.push(completion(duty, at(-d, '17:30'), DEMO_USERS.station, at(-d, '17:42'), ['张伟', '陈静', '黄磊'][d % 3]));
  }

  // ---------------------------------------------------------------------------
  // 已读回执：收假通知（全院）读了一大半；班会通知读了几个
  // ---------------------------------------------------------------------------
  const read = (r: Reminder, user_id: string, minutesAgo: number): ReminderRead => ({ reminder_id: r.id, occurrence_at: r.due_at, user_id, read_at: ago(minutesAgo) });
  const reads: ReminderRead[] = [
    ...[DEMO_USERS.member, 'u-zhang', 'u-chen', 'u-liu', 'u-zhou', 'u-wu', 'u-xu', 'u-sun', 'u-zhao', 'u-lin'].map((u, i) => read(notice, u, 2 * 24 * 60 - i * 37)),
    ...['u-zhang', 'u-chen', 'u-zhou'].map((u, i) => read(meeting, u, 300 - i * 50)),
    { reminder_id: hw1.id, occurrence_at: occ1, user_id: 'u-zhang', read_at: shift(due1, -100) },
    { reminder_id: hw1.id, occurrence_at: occ1, user_id: 'u-chen', read_at: shift(due1, -50) },
    { reminder_id: hw1.id, occurrence_at: occ1, user_id: DEMO_USERS.member, read_at: shift(due1, -30) },
  ];

  // 附件：实验一挂一份要求 + 一张链表示意图
  const attachments: Attachment[] = [
    { id: uid(), reminder_id: hw1.id, uploaded_by: DEMO_USERS.admin, file_path: 'demo-img/list.svg', file_name: '单链表示意图.jpg', size: 312300, mime: 'image/jpeg', created_at: hw1.created_at },
    { id: uid(), reminder_id: hw1.id, uploaded_by: DEMO_USERS.admin, file_path: 'demo-file/lab1.pdf', file_name: '实验一要求.pdf', size: 188000, mime: 'application/pdf', created_at: hw1.created_at },
  ];

  // ---------------------------------------------------------------------------
  // 讨论
  // ---------------------------------------------------------------------------
  const d1 = discussion({
    title: '运动会方阵口号征集，大家投个票',
    body: '方阵要喊一句口号，下周三前定下来。草图是体育委员画的，口号直接在下面留言。',
    created_by: DEMO_USERS.admin,
    created_at: ago(26 * 60),
    due_date: ymdIn(3),
  });
  const d2 = discussion({
    title: '期中考试安排（征求意见）',
    body: '期中考试打算放在第 9 周，有冲突的课程请在这里说一下。',
    created_by: 'u-lin',
    visibility: 'company',
    created_at: ago(3 * 24 * 60),
    due_date: ymdIn(6),
  });
  const d3 = discussion({
    title: '实验室晚上开放到几点？',
    body: '期末前想晚上去实验室写代码，开放时间能不能延长？',
    created_by: DEMO_USERS.member,
    created_at: ago(9 * 24 * 60),
    closed_at: ago(2 * 24 * 60),
    conclusion: '工作日开放到 21:30，最后走的同学负责关电脑断电。',
    due_date: ymdIn(-3),
    last_activity_by: DEMO_USERS.member,
    last_activity_at: ago(2 * 24 * 60),
  });
  const discussions = [d1, d2, d3];
  const discussionMembers: DiscussionMember[] = [
    { id: uid(), discussion_id: d1.id, user_id: null, team_id: T_2301 },
    { id: uid(), discussion_id: d3.id, user_id: null, team_id: T_2301 },
    { id: uid(), discussion_id: d3.id, user_id: DEMO_USERS.admin, team_id: null },
  ];
  const c = (d: Discussion, author_id: string, minutesAgo: number, body: string, author_name = ''): DiscussionComment => ({ id: uid(), discussion_id: d.id, author_id, author_name, body, created_at: ago(minutesAgo) });
  const comments: DiscussionComment[] = [
    c(d1, 'u-zhang', 25 * 60, '「代码改变世界，2301 永不宕机！」'),
    c(d1, 'u-chen', 24 * 60, '我投张伟的，再加个动作：喊到「宕机」的时候一起摆手。'),
    c(d1, DEMO_USERS.member, 3 * 60, '+1，顺便问下方阵要不要统一穿班服？'),
    c(d1, DEMO_USERS.station, 40, '班服上周订了，周五到。', '周婷'),
    c(d2, 'u-zhao', 2 * 24 * 60, '高数可以放第 9 周周三上午。'),
    c(d2, 'u-sun', 20 * 60, '第 9 周周四有英语四级模拟，能不能避开？'),
    c(d3, DEMO_USERS.admin, 8 * 24 * 60, '我问一下实验中心。'),
    c(d3, DEMO_USERS.admin, 2 * 24 * 60 + 5, '实验中心同意了，工作日开放到 21:30。'),
  ];
  for (const d of discussions) {
    const mine = comments.filter((x) => x.discussion_id === d.id);
    d.comment_count = mine.length;
    const last = mine[mine.length - 1];
    if (last && !d.closed_at) {
      d.last_activity_at = last.created_at;
      d.last_activity_by = last.author_id;
    }
  }
  const discussionFiles: DiscussionFile[] = [
    { id: uid(), discussion_id: d1.id, comment_id: null, uploaded_by: DEMO_USERS.admin, file_path: 'demo-img/formation.svg', file_name: '方阵草图.jpg', size: 386000, mime: 'image/jpeg', created_at: d1.created_at },
    { id: uid(), discussion_id: d2.id, comment_id: null, uploaded_by: 'u-lin', file_path: 'demo-file/exam.pdf', file_name: '第 9 周考试安排（草稿）.pdf', size: 142000, mime: 'application/pdf', created_at: d2.created_at },
  ];
  const discussionReads: DiscussionRead[] = [
    { discussion_id: d2.id, user_id: DEMO_USERS.admin, last_read_at: comments[4].created_at },
    { discussion_id: d1.id, user_id: DEMO_USERS.member, last_read_at: comments[1].created_at },
    { discussion_id: d3.id, user_id: DEMO_USERS.admin, last_read_at: d3.last_activity_at },
  ];

  // ---------------------------------------------------------------------------
  // 邀请码、群机器人、服务号
  // ---------------------------------------------------------------------------
  const invites: TeamInvite[] = [
    { code: 'RJ2301AB', team_id: T_2301, note: '开学发在班级群', created_by: DEMO_USERS.admin, created_at: ago(20 * 24 * 60), expires_at: ago(-10 * 24 * 60), max_uses: null, uses: 6, disabled: false },
    { code: 'RJ2302CD', team_id: T_2302, note: '2302 新生', created_by: 'u-zhao', created_at: ago(2 * 24 * 60), expires_at: ago(-5 * 24 * 60), max_uses: 40, uses: 3, disabled: false },
    { code: 'XYTEACH26', team_id: null, note: '学院新老师（只激活）', created_by: DEMO_USERS.admin, created_at: ago(40 * 24 * 60), expires_at: null, max_uses: null, uses: 1, disabled: false },
    { code: 'OLD2025X', team_id: T_2301, note: '去年的', created_by: DEMO_USERS.admin, created_at: ago(300 * 24 * 60), expires_at: null, max_uses: null, uses: 31, disabled: true },
  ];
  const webhooks: TeamWebhook[] = [
    { id: uid(), team_id: T_2301, kind: 'wecom', name: '2301 班级群', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-2301', secret: '', stages: ['pre', 'due'], enabled: true, created_at: ago(20 * 24 * 60), last_at: ago(35), last_status: 'ok' },
    { id: uid(), team_id: T_2302, kind: 'dingtalk', name: '2302 钉钉群', url: 'https://oapi.dingtalk.com/robot/send?access_token=demo-2302', secret: 'SECdemo2302', stages: ['due', 'overdue'], enabled: true, created_at: ago(15 * 24 * 60), last_at: ago(26 * 60), last_status: 'errcode 310000: sign not match' },
    { id: uid(), team_id: null, kind: 'feishu', name: '学院通知群', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-all', secret: '', stages: ['due'], enabled: false, created_at: ago(9 * 24 * 60), last_at: null, last_status: '' },
  ];
  const allBindings: WechatBinding[] = [
    { user_id: DEMO_USERS.member, openid: 'o-mp-li', unionid: 'un-li', subscribed: true, nickname: '小李', bound_at: ago(20 * 24 * 60) },
    { user_id: 'u-zhang', openid: 'o-mp-zhang', unionid: '', subscribed: false, nickname: '伟哥', bound_at: ago(15 * 24 * 60) },
  ];
  const allPrefs: NotifyPrefs[] = [{ user_id: DEMO_USERS.member, wechat: true, dnd_enabled: true, dnd_from: '22:30', dnd_to: '07:00', dnd_rest_days: false }];
  const appSettings: AppSettings = { org_name: '示例大学 · 计算机学院', team_label: '班级', org_label: '全院', timezone: 'Asia/Shanghai', push_overdue_max: 2 };

  return {
    teams,
    profiles,
    memberships,
    reminders,
    assignees,
    completions,
    snoozes: [],
    submissions,
    attachments,
    discussions,
    discussionMembers,
    comments,
    discussionFiles,
    discussionReads,
    discussionsReady: true,
    appSettings,
    holidays: CN_HOLIDAYS_2026.map((h) => ({ ...h })),
    reads,
    notifyPrefs: null,
    wechatBinding: null,
    identities,
    invites,
    webhooks,
    allPrefs,
    allBindings,
  };
}

const notInDemo = () => new FnError('demo', '演示模式里不能用', 400);

export class DemoRepo implements Repo {
  mode = 'demo' as const;
  private data: DemoData = buildData();
  private session: Session | null = null;
  private listeners = new Set<() => void>();
  private authListeners = new Set<(s: Session | null) => void>();
  private bindTimer: ReturnType<typeof setTimeout> | undefined;
  /** 测试用：扫码后多久「绑好」 */
  bindDelayMs = 4000;

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private me(): Profile | undefined {
    return this.data.profiles.find((p) => p.id === this.session?.userId);
  }

  private isAdmin(): boolean {
    const me = this.me();
    return !!me && me.role === 'admin' && me.active;
  }

  async getSession(): Promise<Session | null> {
    return this.session;
  }

  onAuthChange(cb: (s: Session | null) => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }

  async signInWithEmail(): Promise<void> {
    throw notInDemo();
  }

  async verifyEmailCode(): Promise<void> {
    throw notInDemo();
  }

  async signInDemo(userId: string): Promise<void> {
    const p = this.data.profiles.find((x) => x.id === userId);
    this.session = p ? { userId: p.id, email: p.email } : null;
    this.authListeners.forEach((l) => l(this.session));
  }

  async signOut(): Promise<void> {
    this.session = null;
    clearTimeout(this.bindTimer);
    this.authListeners.forEach((l) => l(null));
  }

  async authStart(): Promise<AuthStartResponse> {
    throw notInDemo();
  }

  async authFinish(): Promise<AuthFinishResponse> {
    throw notInDemo();
  }

  async verifyTokenHash(): Promise<void> {
    throw notInDemo();
  }

  /** 和数据库里的 redeem_invite() 一样的规则 */
  async redeemInvite(code: string): Promise<RedeemResult> {
    const me = this.me();
    if (!me) return { ok: false, reason: 'not_signed_in' };
    const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const inv = this.data.invites.find((x) => x.code === c);
    if (!inv) return { ok: false, reason: 'not_found' };
    if (inv.disabled) return { ok: false, reason: 'disabled' };
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return { ok: false, reason: 'expired' };
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) return { ok: false, reason: 'used_up' };
    if (me.is_station) return { ok: false, reason: 'station' };
    const wasActive = me.active;
    const prevTeam = me.team_id;
    me.active = true;
    me.team_id = me.team_id ?? inv.team_id;
    if (inv.team_id && prevTeam && prevTeam !== inv.team_id && !this.data.memberships.some((m) => m.profile_id === me.id && m.team_id === inv.team_id)) {
      this.data.memberships.push({ profile_id: me.id, team_id: inv.team_id });
    }
    inv.uses += 1;
    this.emit();
    return { ok: true, team_id: inv.team_id, was_active: wasActive };
  }

  async loadAll(userId: string): Promise<Snapshot> {
    const d = JSON.parse(JSON.stringify(this.data)) as DemoData;
    const me = d.profiles.find((p) => p.id === userId);
    const admin = !!me && me.role === 'admin' && me.active;
    const active = !!me?.active;
    const since = new Date(Date.now() - DISCUSSION_WINDOW_DAYS * 86400000).toISOString();
    const recent = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    const createdByMe = new Set(d.reminders.filter((r) => r.created_by === userId).map((r) => r.id));
    const { allPrefs, allBindings, ...snap } = d;
    // 和服务器一样：待激活的人只看得到自己；已读只给自己的和自己发的；邀请码 / 机器人只给管理员
    return {
      ...snap,
      teams: active ? snap.teams : [],
      profiles: active ? snap.profiles : snap.profiles.filter((p) => p.id === userId),
      memberships: active ? snap.memberships : [],
      reminders: active ? snap.reminders : [],
      comments: snap.comments.filter((c) => c.created_at >= since),
      discussionFiles: snap.discussionFiles.filter((f) => !f.comment_id || f.created_at >= since),
      discussionReads: snap.discussionReads.filter((r) => r.user_id === userId),
      discussions: active ? snap.discussions.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at)) : [],
      reads: snap.reads.filter((r) => r.occurrence_at >= recent && (admin || r.user_id === userId || createdByMe.has(r.reminder_id))),
      notifyPrefs: allPrefs.find((p) => p.user_id === userId) ?? null,
      wechatBinding: allBindings.find((b) => b.user_id === userId) ?? null,
      identities: snap.identities.filter((i) => admin || i.user_id === userId),
      invites: admin ? snap.invites : [],
      webhooks: admin ? snap.webhooks : [],
    };
  }

  subscribe(onChange: () => void, _onRead?: (row: ReminderRead) => void): () => void {
    // 演示数据都在内存里：任何改动都整体刷新（便宜）
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  private applyAssignees(reminderId: string, input: ReminderInput) {
    this.data.assignees = this.data.assignees.filter((a) => a.reminder_id !== reminderId);
    input.assignee_user_ids.forEach((user_id) => this.data.assignees.push({ id: uid(), reminder_id: reminderId, user_id, team_id: null }));
    input.assignee_team_ids.forEach((team_id) => this.data.assignees.push({ id: uid(), reminder_id: reminderId, user_id: null, team_id }));
  }

  async createReminder(input: ReminderInput, userId: string): Promise<string> {
    const { assignee_user_ids: _u, assignee_team_ids: _t, ...row } = input;
    const r = reminder({ ...row, created_by: userId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    this.data.reminders.push(r);
    this.applyAssignees(r.id, input);
    this.emit();
    return r.id;
  }

  async updateReminder(id: string, input: ReminderInput): Promise<void> {
    const r = this.data.reminders.find((x) => x.id === id);
    if (!r) return;
    const { assignee_user_ids: _u, assignee_team_ids: _t, ...row } = input;
    Object.assign(r, row, { updated_at: new Date().toISOString() });
    this.applyAssignees(id, input);
    this.emit();
  }

  async deleteReminder(id: string): Promise<void> {
    this.data.reminders = this.data.reminders.filter((x) => x.id !== id);
    this.emit();
  }

  async addCompletion(c: Omit<Completion, 'id' | 'completed_at'>): Promise<void> {
    this.data.completions = this.data.completions.filter(
      (x) => !(x.reminder_id === c.reminder_id && x.occurrence_at === c.occurrence_at && x.completed_by === c.completed_by && x.completed_by_name === c.completed_by_name),
    );
    this.data.completions.push({ ...c, id: uid(), completed_at: new Date().toISOString() });
    this.emit();
  }

  async removeCompletion(id: string): Promise<void> {
    this.data.completions = this.data.completions.filter((x) => x.id !== id);
    this.emit();
  }

  async setSnooze(s: Omit<Snooze, 'id'>): Promise<void> {
    this.data.snoozes = this.data.snoozes.filter((x) => !(x.reminder_id === s.reminder_id && x.user_id === s.user_id && x.occurrence_at === s.occurrence_at));
    this.data.snoozes.push({ ...s, id: uid() });
    this.emit();
  }

  async clearSnooze(reminderId: string, userId: string, occurrenceAt: string): Promise<void> {
    this.data.snoozes = this.data.snoozes.filter((x) => !(x.reminder_id === reminderId && x.user_id === userId && x.occurrence_at === occurrenceAt));
    this.emit();
  }

  private blobs = new Map<string, string>(); // 演示模式：文件只存在内存里

  async addSubmission(meta: SubmissionMeta, file: File): Promise<Submission> {
    const row: Submission = {
      ...meta,
      id: uid(),
      file_path: 'demo/' + uid(),
      file_name: file.name,
      size: file.size,
      mime: file.type,
      created_at: new Date().toISOString(),
      status: 'submitted',
      review_note: '',
      reviewed_by: null,
      reviewed_at: null,
    };
    this.blobs.set(row.file_path, URL.createObjectURL(file));
    this.data.submissions.push(row);
    this.emit();
    return row;
  }

  async removeSubmission(s: Submission): Promise<void> {
    this.data.submissions = this.data.submissions.filter((x) => x.id !== s.id);
    this.blobs.delete(s.file_path);
    this.emit();
  }

  async reviewSubmissions(ids: string[], status: SubmissionStatus, note: string): Promise<void> {
    const now = new Date().toISOString();
    for (const s of this.data.submissions) {
      if (!ids.includes(s.id)) continue;
      const r = this.data.reminders.find((x) => x.id === s.reminder_id);
      if (!this.isAdmin() && r?.created_by !== this.session?.userId) throw new Error('not allowed');
      Object.assign(s, { status, review_note: note.slice(0, 500), reviewed_by: this.session?.userId ?? null, reviewed_at: now });
    }
    this.emit();
  }

  async submissionUrl(s: Submission): Promise<string> {
    return this.fileUrl('submissions', s.file_path);
  }

  async markRead(reminderId: string, occurrenceAt: string, userId: string): Promise<void> {
    const t = new Date(occurrenceAt).getTime();
    if (this.data.reads.some((r) => r.reminder_id === reminderId && r.user_id === userId && Math.abs(new Date(r.occurrence_at).getTime() - t) < 60000)) return;
    this.data.reads.push({ reminder_id: reminderId, occurrence_at: occurrenceAt, user_id: userId, read_at: new Date().toISOString() });
    this.emit();
  }

  async addAttachment(reminderId: string, userId: string, file: File): Promise<Attachment> {
    const row: Attachment = { id: uid(), reminder_id: reminderId, uploaded_by: userId, file_path: 'demo/' + uid(), file_name: file.name, size: file.size, mime: file.type, created_at: new Date().toISOString() };
    this.blobs.set(row.file_path, URL.createObjectURL(file));
    this.data.attachments.push(row);
    this.emit();
    return row;
  }

  async removeAttachment(a: Attachment): Promise<void> {
    this.data.attachments = this.data.attachments.filter((x) => x.id !== a.id);
    this.blobs.delete(a.file_path);
    this.emit();
  }

  async fileUrl(_bucket: FileBucket, path: string): Promise<string> {
    const u = this.blobs.get(path);
    if (u) return u;
    // 预置的演示文件：图片给一张现画的占位图，其他给一个小文本文件
    const svg = path === 'demo-img/formation.svg' ? DEMO_FORMATION_SVG : path === 'demo-img/lab.svg' ? DEMO_LAB_SVG : DEMO_LIST_SVG;
    const blob = path.startsWith('demo-img/') ? new Blob([svg], { type: 'image/svg+xml' }) : new Blob(['演示文件'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    this.blobs.set(path, url);
    return url;
  }

  async fileUrls(bucket: FileBucket, paths: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of paths) out[p] = await this.fileUrl(bucket, p);
    return out;
  }

  async updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
    const p = this.data.profiles.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
    this.emit();
  }

  async setMemberships(profileId: string, teamIds: string[]): Promise<void> {
    this.data.memberships = this.data.memberships.filter((m) => m.profile_id !== profileId);
    for (const team_id of teamIds) this.data.memberships.push({ profile_id: profileId, team_id });
    this.emit();
  }

  async upsertTeam(team: Partial<Team> & { name: string; color: string }): Promise<void> {
    const existing = team.id ? this.data.teams.find((t) => t.id === team.id) : undefined;
    if (existing) Object.assign(existing, team);
    else this.data.teams.push({ id: uid(), sort: this.data.teams.length + 1, ...team } as Team);
    this.emit();
  }

  async deleteTeam(id: string): Promise<void> {
    this.data.teams = this.data.teams.filter((t) => t.id !== id);
    this.data.memberships = this.data.memberships.filter((m) => m.team_id !== id);
    for (const p of this.data.profiles) if (p.team_id === id) p.team_id = null;
    this.data.invites = this.data.invites.filter((i) => i.team_id !== id);
    this.data.webhooks = this.data.webhooks.filter((w) => w.team_id !== id);
    this.emit();
  }

  // ---- 机构设置、节假日 ----
  async updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
    if (!this.isAdmin()) throw new Error('not allowed');
    Object.assign(this.data.appSettings, patch);
    this.emit();
  }

  async addHolidays(rows: Holiday[]): Promise<void> {
    if (!this.isAdmin()) throw new Error('not allowed');
    const days = new Set(rows.map((r) => r.day));
    this.data.holidays = [...this.data.holidays.filter((h) => !days.has(h.day)), ...rows].sort((a, b) => a.day.localeCompare(b.day));
    this.emit();
  }

  async removeHolidays(days: string[]): Promise<void> {
    if (!this.isAdmin()) throw new Error('not allowed');
    this.data.holidays = this.data.holidays.filter((h) => !days.includes(h.day));
    this.emit();
  }

  // ---- 通知 ----
  async saveNotifyPrefs(p: NotifyPrefs): Promise<void> {
    this.data.allPrefs = [...this.data.allPrefs.filter((x) => x.user_id !== p.user_id), { ...p }];
    this.emit();
  }

  /** 演示：给一张二维码，过几秒当作扫码关注了（设置页会马上变成「已绑定」） */
  async wechatBind(): Promise<WechatBindResponse> {
    const me = this.me();
    if (!me) throw notInDemo();
    const scene = `bind_${randomInviteCode(10).toLowerCase()}`;
    const qrUrl = await QRCode.toDataURL(`https://mp.weixin.qq.com/demo?scene=${scene}`, { margin: 1, width: 360 });
    clearTimeout(this.bindTimer);
    this.bindTimer = setTimeout(() => {
      this.data.allBindings = [
        ...this.data.allBindings.filter((b) => b.user_id !== me.id),
        { user_id: me.id, openid: `o-mp-${me.id}`, unionid: '', subscribed: true, nickname: me.name, bound_at: new Date().toISOString() },
      ];
      this.emit();
    }, this.bindDelayMs);
    return { qrUrl, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
  }

  async unbindWechat(userId: string): Promise<void> {
    this.data.allBindings = this.data.allBindings.filter((b) => b.user_id !== userId);
    this.emit();
  }

  async notifyTest(body: { webhookId: string } | { wechat: true }): Promise<NotifyTestResponse> {
    if ('webhookId' in body) {
      const w = this.data.webhooks.find((x) => x.id === body.webhookId);
      if (!w) return { ok: false, error: 'not_found' };
      const ok = !w.secret || w.secret !== 'SECdemo2302';
      w.last_at = new Date().toISOString();
      w.last_status = ok ? 'ok' : 'errcode 310000: sign not match';
      this.emit();
      return ok ? { ok: true } : { ok: false, error: w.last_status };
    }
    const b = this.data.allBindings.find((x) => x.user_id === this.session?.userId);
    if (!b) return { ok: false, error: '还没绑定服务号' };
    if (!b.subscribed) return { ok: false, error: '已经取消关注服务号' };
    return { ok: true };
  }

  // ---- 邀请码、群机器人 ----
  async createInvite(input: InviteInput, userId: string): Promise<TeamInvite> {
    if (!this.isAdmin()) throw new Error('not allowed');
    const inv: TeamInvite = { ...input, code: randomInviteCode(), created_by: userId, created_at: new Date().toISOString(), uses: 0, disabled: false };
    this.data.invites.unshift(inv);
    this.emit();
    return { ...inv };
  }

  async setInviteDisabled(code: string, disabled: boolean): Promise<void> {
    const inv = this.data.invites.find((x) => x.code === code);
    if (inv) inv.disabled = disabled;
    this.emit();
  }

  async upsertWebhook(w: WebhookInput): Promise<void> {
    if (!this.isAdmin()) throw new Error('not allowed');
    if (!/^https:\/\//.test(w.url)) throw new Error('url must start with https://');
    const existing = w.id ? this.data.webhooks.find((x) => x.id === w.id) : undefined;
    if (existing) Object.assign(existing, { team_id: w.team_id, kind: w.kind, name: w.name, url: w.url, secret: w.secret, stages: w.stages, enabled: w.enabled });
    else this.data.webhooks.push({ id: uid(), team_id: w.team_id, kind: w.kind, name: w.name, url: w.url, secret: w.secret, stages: w.stages, enabled: w.enabled, created_at: new Date().toISOString(), last_at: null, last_status: '' });
    this.emit();
  }

  async deleteWebhook(id: string): Promise<void> {
    this.data.webhooks = this.data.webhooks.filter((x) => x.id !== id);
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // 讨论（演示模式：数据在内存里，时间用本机时钟）
  // ---------------------------------------------------------------------------
  private findDiscussion(id: string): Discussion {
    const d = this.data.discussions.find((x) => x.id === id);
    if (!d) throw new Error('not found');
    return d;
  }

  private touch(d: Discussion, by: string | null) {
    const now = new Date().toISOString();
    d.last_activity_at = now;
    d.last_activity_by = by;
    d.updated_at = now;
  }

  private applyDiscussionMembers(discussionId: string, input: DiscussionInput) {
    this.data.discussionMembers = this.data.discussionMembers.filter((m) => m.discussion_id !== discussionId);
    if (input.visibility === 'company') return;
    input.member_user_ids.forEach((user_id) => this.data.discussionMembers.push({ id: uid(), discussion_id: discussionId, user_id, team_id: null }));
    input.member_team_ids.forEach((team_id) => this.data.discussionMembers.push({ id: uid(), discussion_id: discussionId, user_id: null, team_id }));
  }

  async createDiscussion(input: DiscussionInput, userId: string): Promise<string> {
    const d = discussion({
      title: input.title,
      body: input.body,
      visibility: input.visibility,
      created_by: userId,
      created_by_name: input.created_by_name,
      due_date: input.due_date,
      created_at: new Date().toISOString(),
    });
    this.data.discussions.push(d);
    this.applyDiscussionMembers(d.id, input);
    this.emit();
    return d.id;
  }

  async updateDiscussion(id: string, input: DiscussionInput): Promise<void> {
    const d = this.findDiscussion(id);
    if (d.closed_at) throw new Error('discussion is closed');
    Object.assign(d, { title: input.title, body: input.body, visibility: input.visibility, due_date: input.due_date });
    this.touch(d, this.session?.userId ?? null);
    this.applyDiscussionMembers(id, input);
    this.emit();
  }

  async setDiscussionClosed(id: string, closed: boolean, conclusion?: string): Promise<void> {
    const d = this.findDiscussion(id);
    if (d.created_by !== this.session?.userId) throw new Error('only the creator can close / reopen this discussion');
    d.closed_at = closed ? new Date().toISOString() : null;
    if (closed) d.conclusion = conclusion ?? '';
    this.touch(d, this.session.userId);
    this.emit();
  }

  async deleteDiscussion(id: string): Promise<void> {
    for (const f of this.data.discussionFiles.filter((x) => x.discussion_id === id)) this.blobs.delete(f.file_path);
    this.data.discussions = this.data.discussions.filter((x) => x.id !== id);
    this.data.discussionMembers = this.data.discussionMembers.filter((x) => x.discussion_id !== id);
    this.data.comments = this.data.comments.filter((x) => x.discussion_id !== id);
    this.data.discussionFiles = this.data.discussionFiles.filter((x) => x.discussion_id !== id);
    this.data.discussionReads = this.data.discussionReads.filter((x) => x.discussion_id !== id);
    this.emit();
  }

  private demoFile(discussionId: string, userId: string, file: File, commentId: string | null): DiscussionFile {
    const row: DiscussionFile = {
      id: uid(),
      discussion_id: discussionId,
      comment_id: commentId,
      uploaded_by: userId,
      file_path: 'demo/' + uid(),
      file_name: file.name,
      size: file.size,
      mime: file.type,
      created_at: new Date().toISOString(),
    };
    this.blobs.set(row.file_path, URL.createObjectURL(file));
    return row;
  }

  async addDiscussionFile(discussionId: string, userId: string, file: File): Promise<DiscussionFile> {
    const row = this.demoFile(discussionId, userId, file, null);
    this.data.discussionFiles.push(row);
    this.emit();
    return row;
  }

  async removeDiscussionFile(f: DiscussionFile): Promise<void> {
    this.data.discussionFiles = this.data.discussionFiles.filter((x) => x.id !== f.id);
    this.blobs.delete(f.file_path);
    this.emit();
  }

  async addComment(c: CommentDraft, files: File[], onProgress?: (done: number) => void): Promise<{ comment: DiscussionComment; files: DiscussionFile[] }> {
    const d = this.findDiscussion(c.discussion_id);
    if (d.closed_at) throw new Error('discussion is closed');
    const comment: DiscussionComment = { ...c, id: uid(), created_at: new Date().toISOString() };
    const rows: DiscussionFile[] = [];
    for (const f of files) {
      rows.push(this.demoFile(c.discussion_id, c.author_id, f, comment.id));
      onProgress?.(rows.length);
    }
    this.data.comments.push(comment);
    this.data.discussionFiles.push(...rows);
    d.comment_count += 1;
    d.last_activity_at = comment.created_at;
    d.last_activity_by = c.author_id;
    this.emit();
    return { comment, files: rows };
  }

  async removeComment(c: DiscussionComment, files: DiscussionFile[]): Promise<void> {
    this.data.comments = this.data.comments.filter((x) => x.id !== c.id);
    this.data.discussionFiles = this.data.discussionFiles.filter((x) => x.comment_id !== c.id);
    files.forEach((f) => this.blobs.delete(f.file_path));
    const d = this.data.discussions.find((x) => x.id === c.discussion_id);
    if (d) d.comment_count = Math.max(0, d.comment_count - 1);
    this.emit();
  }

  async markDiscussionRead(discussionId: string, userId: string, at: string): Promise<void> {
    const r = this.data.discussionReads.find((x) => x.discussion_id === discussionId && x.user_id === userId);
    if (r) {
      if (at > r.last_read_at) r.last_read_at = at;
    } else this.data.discussionReads.push({ discussion_id: discussionId, user_id: userId, last_read_at: at });
    this.emit();
  }

  async loadThread(discussionId: string): Promise<{ comments: DiscussionComment[]; files: DiscussionFile[] }> {
    const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    return {
      comments: copy(this.data.comments.filter((x) => x.discussion_id === discussionId)),
      files: copy(this.data.discussionFiles.filter((x) => x.discussion_id === discussionId)),
    };
  }
}
