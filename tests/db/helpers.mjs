// 数据库权限测试的公共部分：连接、每个测试一个事务（结束时回滚）、切换身份、准备示例数据。
//
// 本机：scripts/dev-db/up.sh --db pling_db_test 之后 `node --test tests/db/`
// CI：  PLING_DB_TEST_URL 指向跑过迁移的库
//
// 身份切换和 Supabase 一样：set local role authenticated / anon + request.jwt.claims（auth.uid() 读它）。
import pg from 'pg';

export const DB_URL = process.env.PLING_DB_TEST_URL ?? 'postgres://postgres@127.0.0.1:54329/pling_db_test';

export const U = {
  admin: 'a0000000-0000-4000-8000-000000000001',
  teacher: 'a0000000-0000-4000-8000-000000000002',
  student: 'a0000000-0000-4000-8000-000000000003', // B 班
  student2: 'a0000000-0000-4000-8000-000000000004', // A 班
  pending: 'a0000000-0000-4000-8000-000000000005', // 待激活
  station: 'a0000000-0000-4000-8000-000000000006', // 共用设备
  outsider: 'a0000000-0000-4000-8000-000000000007', // 已激活，不在任何班
};
export const T = { A: 'b0000000-0000-4000-8000-000000000001', B: 'b0000000-0000-4000-8000-000000000002' };
export const R = {
  company: 'c0000000-0000-4000-8000-000000000001', // 老师建，全体可见
  teamA: 'c0000000-0000-4000-8000-000000000002', // 老师建，A 班可见
  private: 'c0000000-0000-4000-8000-000000000003', // 老师建，仅自己
  toStudent: 'c0000000-0000-4000-8000-000000000004', // 老师建，私人，但指派给学生（B 班）
  homework: 'c0000000-0000-4000-8000-000000000005', // 老师建，A 班可见，指派 A 班，要交文件
};
export const D = {
  company: 'd0000000-0000-4000-8000-000000000001', // 老师发起，全体
  teamB: 'd0000000-0000-4000-8000-000000000002', // 老师发起，范围 = B 班
};
export const OCC = '2026-10-09T09:00:00.000Z';

export class Tx {
  constructor(client) {
    this.c = client;
    this.sp = 0;
  }
  async q(sql, params = []) {
    return this.c.query(sql, params);
  }
  async rows(sql, params = []) {
    return (await this.c.query(sql, params)).rows;
  }
  async one(sql, params = []) {
    const r = await this.rows(sql, params);
    return r[0];
  }
  async val(sql, params = []) {
    const r = await this.c.query({ text: sql, values: params, rowMode: 'array' });
    return r.rows[0]?.[0];
  }
  async count(sql, params = []) {
    return Number(await this.val(`select count(*) from (${sql}) _x`, params));
  }
  /** 受影响的行数（UPDATE / DELETE 被权限过滤掉时是 0，不报错） */
  async affected(sql, params = []) {
    return (await this.c.query(sql, params)).rowCount;
  }
  /** 期望报错；用保存点，不影响后面的语句。返回错误信息 */
  async rejects(sql, params = [], pattern = /./) {
    const name = `sp${++this.sp}`;
    await this.c.query(`savepoint ${name}`);
    try {
      await this.c.query(sql, params);
    } catch (e) {
      await this.c.query(`rollback to savepoint ${name}`);
      if (!pattern.test(e.message)) throw new Error(`报错了，但信息不对：${e.message}`);
      return e.message;
    }
    await this.c.query(`rollback to savepoint ${name}`);
    throw new Error(`应该被拒绝，却成功了：${sql}`);
  }
  async as(uid) {
    await this.c.query('set local role authenticated');
    await this.c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  }
  async anon() {
    await this.c.query('set local role anon');
    await this.c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
  }
  /** 回到超级用户（准备数据、直接查结果） */
  async su() {
    await this.c.query('reset role');
    await this.c.query(`select set_config('request.jwt.claims', '', true)`);
  }
}

let client;
export async function connect() {
  if (!client) {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  }
  return client;
}
export async function disconnect() {
  if (client) {
    await client.end();
    client = undefined;
  }
}

/** 每个测试一个事务，结束回滚：测试之间互不影响，库里不留东西 */
export async function tx(fn) {
  const c = await connect();
  await c.query('begin');
  try {
    const t = new Tx(c);
    await seed(t);
    await fn(t);
  } finally {
    await c.query('rollback');
  }
}

const NAMES = { admin: '管理员', teacher: '王老师', student: '李同学', student2: '赵同学', pending: '新来的', station: '机房电脑', outsider: '张三' };

async function seed(t) {
  await t.su();
  // 库是新的：第一个注册的人自动成为管理员（handle_new_user）
  for (const [k, id] of Object.entries(U)) {
    await t.q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
      id,
      k === 'student' ? '' : `${k}@example.cn`,
      JSON.stringify(k === 'student' ? { name: '微信昵称', login_provider: 'wechat_open', avatar_url: 'https://wx.qlogo.cn/a.png' } : {}),
    ]);
  }
  await t.q(`insert into public.teams (id, name, color, sort) values ($1, 'A 班', '#0E7C6B', 1), ($2, 'B 班', '#6B4FBB', 2)`, [T.A, T.B]);
  for (const [k, id] of Object.entries(U)) {
    if (k === 'admin') continue;
    await t.q(`update public.profiles set active = $2, name = $3, team_id = $4, is_station = $5 where id = $1`, [
      id,
      k !== 'pending',
      NAMES[k],
      k === 'teacher' || k === 'student2' || k === 'station' ? T.A : k === 'student' ? T.B : null,
      k === 'station',
    ]);
  }
  const rem = (id, title, vis, team, extra = '') =>
    t.q(`insert into public.reminders (id, title, due_at, created_by, visibility, team_id${extra ? ', require_upload, completion_mode' : ''})
         values ($1, $2, $3, $4, $5, $6${extra ? `, true, 'each'` : ''})`, [id, title, OCC, U.teacher, vis, team]);
  await rem(R.company, '全体大扫除', 'company', null);
  await rem(R.teamA, 'A 班班会', 'team', T.A);
  await rem(R.private, '老师自己的备忘', 'private', null);
  await rem(R.toStudent, '给李同学的提醒', 'private', null);
  await rem(R.homework, '交实验报告', 'team', T.A, 'homework');
  await t.q(`insert into public.reminder_assignees (reminder_id, user_id) values ($1, $2)`, [R.toStudent, U.student]);
  await t.q(`insert into public.reminder_assignees (reminder_id, team_id) values ($1, $2)`, [R.homework, T.A]);

  await t.q(`insert into public.discussions (id, title, body, created_by, visibility) values ($1, '运动会报名', '', $2, 'company'), ($3, 'B 班的事', '', $2, 'members')`, [
    D.company,
    U.teacher,
    D.teamB,
  ]);
  await t.q(`insert into public.discussion_members (discussion_id, team_id) values ($1, $2)`, [D.teamB, T.B]);
}
