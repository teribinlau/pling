// 作业统计 / 已读回执 / 导出的纯函数
import { describe, expect, it } from 'vitest';
import { audienceOf, hasValidHomework, homeworkStats, homeworkTable, personHomework, readStatusOf, toCsv, toTsv, uploadRequiredFor } from '../../src/lib/homework';
import type { Assignee, Profile, Reminder, ReminderRead, Submission, Team } from '../../src/lib/types';

const DUE = new Date('2026-09-30T14:00:00Z'); // 22:00 上海
const P = (id: string, name: string, extra: Partial<Profile> = {}): Profile => ({
  id,
  name,
  email: '',
  team_id: 't1',
  role: 'member',
  lang: 'zh-CN',
  is_station: false,
  active: true,
  phone: '',
  avatar_url: '',
  name_confirmed: true,
  ...extra,
});
const teacher = P('T', '王老师', { role: 'admin', team_id: 't0' });
const li = P('L', '李同学');
const zhang = P('Z', '张伟');
const chen = P('C', '陈静');
const liu = P('U', '刘洋');
const yang = P('Y', '杨帆');
const huang = P('H', '黄磊');
const zhou = P('O', '周婷');
const lab = P('S', '实验室电脑', { is_station: true });
const inactive = P('N', '新同学', { active: false });
const people = [teacher, li, zhang, chen, liu, yang, huang, zhou, lab, inactive];
const teams: Team[] = [
  { id: 't0', name: '学院办公室', color: '#000', sort: 0 },
  { id: 't1', name: '软件 2301 班', color: '#3B7A2A', sort: 1 },
];

const R = (extra: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  title: '实验一',
  notes: '',
  due_at: DUE.toISOString(),
  tz: 'Asia/Shanghai',
  rrule: null,
  skip_holidays: true,
  remind_before_min: 0,
  overdue_repeat_min: 0,
  priority: 'high',
  visibility: 'team',
  team_id: 't1',
  created_by: 'T',
  link: '',
  completion_mode: 'each',
  require_upload: true,
  archived: false,
  source: null,
  source_key: null,
  created_at: '',
  updated_at: '',
  ...extra,
});
const at = (h: number) => new Date(DUE.getTime() + h * 3600000).toISOString();
let n = 0;
const S = (by: string, h: number, extra: Partial<Submission> = {}): Submission => ({
  id: `s${++n}`,
  reminder_id: 'r1',
  occurrence_at: DUE.toISOString(),
  uploaded_by: by,
  uploaded_by_name: '',
  file_path: '',
  file_name: `${by}.pdf`,
  size: 1,
  mime: 'application/pdf',
  created_at: at(h),
  status: 'submitted',
  review_note: '',
  reviewed_by: null,
  reviewed_at: null,
  ...extra,
});

const subs: Submission[] = [
  S('L', -26, { status: 'accepted', review_note: '不错', reviewed_by: 'T', reviewed_at: at(36) }),
  S('L', -25.9, { status: 'accepted', review_note: '不错', reviewed_by: 'T', reviewed_at: at(36) }),
  S('Z', -0.5),
  S('C', 11),
  S('U', -3, { status: 'returned', review_note: '缺截图', reviewed_by: 'T', reviewed_at: at(36.2) }),
  S('Y', -3.3, { status: 'returned', review_note: '复杂度写错', reviewed_by: 'T', reviewed_at: at(36.4) }),
  S('Y', 70),
  S('S', -5, { uploaded_by_name: '周婷', status: 'accepted', reviewed_by: 'T', reviewed_at: at(36.5) }),
];
const assignees: Assignee[] = [{ id: 'a1', reminder_id: 'r1', user_id: null, team_id: 't1' }];

describe('受众', () => {
  it('指派了小组：小组里激活的人，不含共用设备、没激活的、创建人', () => {
    const a = audienceOf(R(), assignees, people, teams);
    expect(a.map((p) => p.name).sort()).toEqual(['刘洋', '周婷', '张伟', '李同学', '杨帆', '陈静', '黄磊'].sort());
  });
  it('没指派：全体可见 = 全部成员；小组可见 = 那个小组；私人的 = 没有', () => {
    expect(audienceOf(R({ visibility: 'company' }), [], people, teams).length).toBe(7);
    expect(audienceOf(R({ visibility: 'team', team_id: 't0' }), [], people, teams).length).toBe(0); // 办公室只有创建人自己
    expect(audienceOf(R({ visibility: 'private' }), assignees, people, teams)).toEqual([]);
  });
  it('兼任也算', () => {
    const a = audienceOf(R(), assignees, [...people, P('X', '兼任的', { team_id: 't0' })], teams, [{ profile_id: 'X', team_id: 't1' }]);
    expect(a.some((p) => p.id === 'X')).toBe(true);
  });
});

describe('每个人的作业状态', () => {
  const of = (p: Profile) => personHomework(subs.filter((s) => (s.uploaded_by_name ? s.uploaded_by_name === p.name : s.uploaded_by === p.id)), DUE);
  it('按时通过', () => {
    const h = of(li);
    expect(h.status).toBe('accepted');
    expect(h.late).toBe(false);
    expect(h.current.length).toBe(2);
    expect(h.note).toBe('不错');
  });
  it('卡着点交的不算迟交；迟交按第一次提交时间', () => {
    expect(of(zhang)).toMatchObject({ status: 'submitted', late: false });
    expect(of(chen)).toMatchObject({ status: 'submitted', late: true });
  });
  it('退回还没重交', () => {
    expect(of(liu)).toMatchObject({ status: 'returned', note: '缺截图', resubmitted: false });
    expect(hasValidHomework({ submissions: subs, at: DUE }, liu)).toBe(false);
  });
  it('退回后重交：新的一批是「已交」，第一次按时交的不算迟交', () => {
    const h = of(yang);
    expect(h.status).toBe('submitted');
    expect(h.resubmitted).toBe(true);
    expect(h.current.map((s) => s.file_name)).toEqual(['Y.pdf']);
    expect(h.current.length).toBe(1);
    expect(h.late).toBe(false);
    expect(h.note).toBe(''); // 重交之后旧批语不再显示
  });
  it('共用设备代交：按名字算到本人头上', () => {
    expect(of(zhou)).toMatchObject({ status: 'accepted', late: false });
  });
  it('没交', () => {
    expect(of(huang)).toMatchObject({ status: 'missing', current: [], firstAt: null });
  });
});

describe('统计', () => {
  const audience = audienceOf(R(), assignees, people, teams);
  const st = homeworkStats({ submissions: subs, at: DUE }, audience);
  it('应交 / 已交（按时 / 迟交）/ 未交 / 退回 / 通过', () => {
    expect(st).toMatchObject({ expected: 7, submitted: 5, onTime: 4, late: 1, missing: 1, returned: 1, accepted: 2, waiting: 3 });
  });
  it('排序：待批 → 退回 → 未交 → 通过', () => {
    expect(st.rows.map((r) => r.status)).toEqual(['submitted', 'submitted', 'submitted', 'returned', 'missing', 'accepted', 'accepted']);
  });
  it('导出：表头 + 每人一行；CSV 有 BOM、逗号引号转义；复制表格是制表符', () => {
    const table = homeworkTable(
      st,
      teams,
      { name: '姓名', team: '班级', status: '状态', time: '提交时间', late: '是否迟交', note: '批语', files: '文件数', yes: '是', no: '否', statusText: { missing: '未交', submitted: '已交', returned: '已退回', accepted: '已通过' } },
      (iso) => iso.slice(0, 16).replace('T', ' '),
    );
    expect(table[0]).toEqual(['姓名', '班级', '状态', '提交时间', '是否迟交', '批语', '文件数']);
    expect(table.length).toBe(8);
    const chenRow = table.find((r) => r[0] === '陈静')!;
    expect(chenRow).toEqual(['陈静', '软件 2301 班', '已交', at(11).slice(0, 16).replace('T', ' '), '是', '', '1']);
    const huangRow = table.find((r) => r[0] === '黄磊')!;
    expect(huangRow[2]).toBe('未交');
    expect(huangRow[3]).toBe('');
    expect(huangRow[4]).toBe('');
    const csv = toCsv([['a,b', 'he said "hi"', 'x\ny', ' pad'], ['1', '2', '3', '4']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿"a,b","he said ""hi""","x\ny"," pad"\r\n1,2,3,4\r\n');
    expect(toTsv([['a\tb', 'c\nd'], ['1', '2']])).toBe('a b\tc d\n1\t2');
  });
});

describe('谁要交文件', () => {
  const audience = audienceOf(R(), assignees, people, teams);
  it('学生要交；布置作业的老师不用；共用设备要交；普通提醒都不用', () => {
    expect(uploadRequiredFor(R(), li, audience)).toBe(true);
    expect(uploadRequiredFor(R(), teacher, audience)).toBe(false);
    expect(uploadRequiredFor(R(), lab, audience)).toBe(true);
    expect(uploadRequiredFor(R({ require_upload: false }), li, audience)).toBe(false);
    expect(uploadRequiredFor(R(), P('X', '别班的'), audience)).toBe(true);
  });
});

describe('已读回执', () => {
  const audience = audienceOf(R(), assignees, people, teams);
  const reads: ReminderRead[] = [
    { reminder_id: 'r1', occurrence_at: DUE.toISOString(), user_id: 'Z', read_at: at(-10) },
    { reminder_id: 'r1', occurrence_at: '2026-09-30T14:00:00.000000+00:00', user_id: 'C', read_at: at(-20) }, // 服务器的时间格式也认
    { reminder_id: 'r1', occurrence_at: at(24), user_id: 'L', read_at: at(-5) }, // 别的一次到期，不算
    { reminder_id: 'r1', occurrence_at: DUE.toISOString(), user_id: 'T', read_at: at(-1) }, // 老师自己不在受众里
  ];
  it('已读 / 未读名单，按读的时间排', () => {
    const st = readStatusOf({ reminder: R(), at: DUE }, reads, audience);
    expect(st.read.map((r) => r.person.name)).toEqual(['陈静', '张伟']);
    expect(st.unread.length).toBe(5);
    expect(st.people.length).toBe(7);
  });
});
