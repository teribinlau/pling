// 数据库权限测试：每张表「谁能看、谁能改」。
// 运行：scripts/dev-db/up.sh --db pling_db_test && node --test tests/db/
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { D, OCC, R, T, U, disconnect, tx } from './helpers.mjs';

after(disconnect);

// ---------------------------------------------------------------------------
describe('整体', () => {
  test('public 里每张表都开了行级权限', () =>
    tx(async (t) => {
      const missing = await t.rows(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`);
      assert.deepEqual(missing.map((r) => r.relname), []);
    }));

  test('没登录的人（anon）只能读机构设置，别的什么都看不到', () =>
    tx(async (t) => {
      await t.anon();
      assert.equal(await t.count('select * from public.app_settings'), 1);
      for (const tbl of ['profiles', 'teams', 'reminders', 'completions', 'holidays', 'discussions', 'team_invites', 'login_identities', 'login_requests', 'wechat_bindings', 'team_webhooks', 'notification_log', 'kv_cache', 'notify_prefs', 'reminder_reads']) {
        assert.equal(await t.count(`select * from public.${tbl}`), 0, tbl);
      }
      // anon 没有 update 的 policy：改不了（0 行）
      assert.equal(await t.affected(`update public.app_settings set org_name = 'x'`), 0);
      await t.rejects(`select public.redeem_invite('ABCDEF')`, [], /permission denied/);
    }));

  test('普通成员碰不到 pling_private 和清理函数', () =>
    tx(async (t) => {
      await t.as(U.teacher);
      await t.rejects(`select * from pling_private.settings`, [], /permission denied/);
      await t.rejects(`select * from pling_private.migrations`, [], /permission denied|does not exist/);
      await t.rejects(`select pling_private.call_notify()`, [], /permission denied/);
      await t.rejects(`select public.pling_cleanup()`, [], /permission denied/);
    }));
});

// ---------------------------------------------------------------------------
describe('新用户和个人资料（0007）', () => {
  test('第一个注册的是管理员并激活，其余默认待激活；微信用户没有邮箱，名字用昵称', () =>
    tx(async (t) => {
      const admin = await t.one('select role, active, name_confirmed from public.profiles where id = $1', [U.admin]);
      assert.deepEqual(admin, { role: 'admin', active: true, name_confirmed: false });
      await t.q(`insert into auth.users (id, email, raw_user_meta_data) values ('a0000000-0000-4000-8000-0000000000aa', 'u.x@login.pling.invalid', '{"name":"小明","login_provider":"qq","avatar_url":"https://q.qlogo.cn/x"}')`);
      const p = await t.one(`select email, name, role, active, avatar_url from public.profiles where id = 'a0000000-0000-4000-8000-0000000000aa'`);
      assert.deepEqual(p, { email: '', name: '小明', role: 'member', active: false, avatar_url: 'https://q.qlogo.cn/x' });
      await t.q(`insert into auth.users (id, email) values ('a0000000-0000-4000-8000-0000000000ab', '')`);
      assert.equal(await t.val(`select name from public.profiles where id = 'a0000000-0000-4000-8000-0000000000ab'`), '新成员');
    }));

  test('待激活的人只看得到自己，看不到别人、小组、提醒', () =>
    tx(async (t) => {
      await t.as(U.pending);
      assert.deepEqual((await t.rows('select id from public.profiles')).map((r) => r.id), [U.pending]);
      assert.equal(await t.count('select * from public.teams'), 0);
      assert.equal(await t.count('select * from public.profile_teams'), 0);
      assert.equal(await t.count('select * from public.reminders'), 0);
      assert.equal(await t.count('select * from public.discussions'), 0);
    }));

  test('自己不能激活自己、不能改角色 / 小组 / 共用设备 / 邮箱', () =>
    tx(async (t) => {
      await t.as(U.pending);
      for (const set of [`active = true`, `role = 'admin'`, `team_id = '${T.A}'`, `is_station = true`, `email = 'x@y.cn'`]) {
        await t.rejects(`update public.profiles set ${set} where id = $1`, [U.pending], /row-level security/);
      }
      await t.su();
      assert.equal(await t.val('select active from public.profiles where id = $1', [U.pending]), false);
    }));

  test('自己能改名字、手机号、头像、语言，确认真实姓名', () =>
    tx(async (t) => {
      await t.as(U.student);
      assert.equal(await t.affected(`update public.profiles set name = '李明', phone = '13800001111', avatar_url = '', lang = 'en-US', name_confirmed = true where id = $1`, [U.student]), 1);
      assert.equal(await t.affected(`update public.profiles set name = '改别人' where id = $1`, [U.student2]), 0);
    }));

  test('管理员能激活、分组、设管理员；最后一个管理员不能被撤', () =>
    tx(async (t) => {
      await t.as(U.admin);
      assert.equal(await t.affected(`update public.profiles set active = true, team_id = $2 where id = $1`, [U.pending, T.B]), 1);
      assert.equal(await t.affected(`update public.profiles set role = 'admin' where id = $1`, [U.teacher]), 1);
      assert.equal(await t.affected(`update public.profiles set role = 'member' where id = $1`, [U.teacher]), 1);
      await t.rejects(`update public.profiles set role = 'member' where id = $1`, [U.admin], /at least one active admin/);
    }));

  test('普通成员不能改别人、不能建小组', () =>
    tx(async (t) => {
      await t.as(U.teacher);
      assert.equal(await t.affected(`update public.profiles set active = false where id = $1`, [U.student]), 0);
      await t.rejects(`insert into public.teams (name, color) values ('C 班', '#000')`, [], /row-level security/);
      assert.equal(await t.affected(`delete from public.teams where id = $1`, [T.A]), 0);
      await t.rejects(`insert into public.profile_teams (profile_id, team_id) values ($1, $2)`, [U.teacher, T.B], /row-level security/);
    }));
});

// ---------------------------------------------------------------------------
describe('机构设置和节假日（0007）', () => {
  test('只有管理员能改机构设置', () =>
    tx(async (t) => {
      await t.as(U.teacher);
      assert.equal(await t.affected(`update public.app_settings set org_name = '偷改'`), 0);
      await t.as(U.admin);
      assert.equal(await t.affected(`update public.app_settings set org_name = '示例中学', team_label = '班级', org_label = '全校'`), 1);
      await t.rejects(`update public.app_settings set team_label = '一二三四五六七'`, [], /check/);
      await t.rejects(`insert into public.app_settings (id) values (2)`, [], /row-level security|check/);
    }));

  test('节假日：已激活的人能看，只有管理员能加删；内置了 2026 年的安排', () =>
    tx(async (t) => {
      await t.as(U.student);
      assert.ok((await t.count('select * from public.holidays')) >= 39);
      assert.equal(await t.val(`select kind from public.holidays where day = '2026-10-10'`), 'work');
      await t.rejects(`insert into public.holidays (day, kind, name) values ('2027-01-01', 'off', '元旦')`, [], /row-level security/);
      assert.equal(await t.affected(`delete from public.holidays where day = '2026-10-01'`), 0);
      await t.as(U.admin);
      await t.q(`insert into public.holidays (day, kind, name) values ('2027-01-01', 'off', '元旦')`);
      assert.equal(await t.affected(`delete from public.holidays where day = '2027-01-01'`), 1);
      await t.rejects(`insert into public.holidays (day, kind) values ('2027-01-02', 'maybe')`, [], /check/);
    }));
});

// ---------------------------------------------------------------------------
describe('邀请码（0007）', () => {
  const addInvite = (t, code, extra = {}) =>
    t.q(`insert into public.team_invites (code, team_id, created_by, expires_at, max_uses, uses, disabled) values ($1, $2, $3, $4, $5, $6, $7)`, [
      code,
      extra.team === undefined ? T.B : extra.team,
      U.admin,
      extra.expires ?? null,
      extra.max ?? null,
      extra.uses ?? 0,
      extra.disabled ?? false,
    ]);

  test('普通成员看不到、建不了邀请码；管理员只能以自己的名义建', () =>
    tx(async (t) => {
      await t.su();
      await addInvite(t, 'CLASSB01');
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.team_invites'), 0);
      await t.rejects(`insert into public.team_invites (code, team_id, created_by) values ('MINE0001', $1, $2)`, [T.A, U.teacher], /row-level security/);
      await t.as(U.admin);
      assert.equal(await t.count('select * from public.team_invites'), 1);
      await t.rejects(`insert into public.team_invites (code, team_id, created_by) values ('FAKE0001', $1, $2)`, [T.A, U.teacher], /row-level security/);
      await t.q(`insert into public.team_invites (code, team_id, created_by) values ('REAL0001', $1, $2)`, [T.A, U.admin]);
      await t.rejects(`insert into public.team_invites (code, created_by) values ('ab', $1)`, [U.admin], /check/);
    }));

  test('待激活的人用邀请码：激活、进小组、次数 +1；小写和空格也认', () =>
    tx(async (t) => {
      await t.su();
      await addInvite(t, 'CLASSB01');
      await t.as(U.pending);
      const r = await t.val(`select public.redeem_invite(' classb-01 ')`);
      assert.equal(r.ok, true);
      assert.equal(r.was_active, false);
      await t.su();
      assert.deepEqual(await t.one('select active, team_id from public.profiles where id = $1', [U.pending]), { active: true, team_id: T.B });
      assert.equal(await t.val(`select uses from public.team_invites where code = 'CLASSB01'`), 1);
    }));

  test('已激活的人用别的小组的码 = 兼任，主小组不变', () =>
    tx(async (t) => {
      await t.su();
      await addInvite(t, 'CLASSB01');
      await t.as(U.teacher);
      assert.equal((await t.val(`select public.redeem_invite('CLASSB01')`)).ok, true);
      await t.su();
      assert.equal(await t.val('select team_id from public.profiles where id = $1', [U.teacher]), T.A);
      assert.equal(await t.count('select * from public.profile_teams where profile_id = $1 and team_id = $2', [U.teacher, T.B]), 1);
    }));

  test('不分组的码只激活', () =>
    tx(async (t) => {
      await t.su();
      await addInvite(t, 'JUSTJOIN', { team: null });
      await t.as(U.pending);
      assert.equal((await t.val(`select public.redeem_invite('JUSTJOIN')`)).ok, true);
      await t.su();
      assert.deepEqual(await t.one('select active, team_id from public.profiles where id = $1', [U.pending]), { active: true, team_id: null });
    }));

  test('无效的码：不存在 / 停用 / 过期 / 用完 / 共用设备账号，都不激活', () =>
    tx(async (t) => {
      await t.su();
      await addInvite(t, 'DISABLED', { disabled: true });
      await addInvite(t, 'EXPIRED0', { expires: '2020-01-01T00:00:00Z' });
      await addInvite(t, 'USEDUP00', { max: 2, uses: 2 });
      await addInvite(t, 'GOODCODE');
      await t.as(U.pending);
      for (const [code, reason] of [['NOSUCHCD', 'not_found'], ['DISABLED', 'disabled'], ['EXPIRED0', 'expired'], ['USEDUP00', 'used_up']]) {
        const r = await t.val(`select public.redeem_invite($1)`, [code]);
        assert.deepEqual([r.ok, r.reason], [false, reason], code);
      }
      await t.as(U.station);
      assert.equal((await t.val(`select public.redeem_invite('GOODCODE')`)).reason, 'station');
      await t.su();
      assert.equal(await t.val('select active from public.profiles where id = $1', [U.pending]), false);
      assert.equal(await t.val(`select uses from public.team_invites where code = 'GOODCODE'`), 0);
    }));
});

// ---------------------------------------------------------------------------
describe('提醒的可见范围（继承 DZF，0001 / 0003）', () => {
  const visible = async (t, uid) => {
    await t.as(uid);
    return new Set((await t.rows('select id from public.reminders')).map((r) => r.id));
  };

  test('全体 / 小组 / 私人 / 指派', () =>
    tx(async (t) => {
      const teacher = await visible(t, U.teacher);
      assert.equal(teacher.size, 5);
      const s2 = await visible(t, U.student2); // A 班
      assert.deepEqual([...s2].sort(), [R.company, R.teamA, R.homework].sort());
      const s = await visible(t, U.student); // B 班 + 被指派
      assert.deepEqual([...s].sort(), [R.company, R.toStudent].sort());
      const o = await visible(t, U.outsider);
      assert.deepEqual([...o], [R.company]);
      const a = await visible(t, U.admin);
      assert.equal(a.size, 5);
    }));

  test('兼任小组的提醒也看得到', () =>
    tx(async (t) => {
      await t.su();
      await t.q('insert into public.profile_teams (profile_id, team_id) values ($1, $2)', [U.student, T.A]);
      const s = await visible(t, U.student);
      assert.ok(s.has(R.teamA) && s.has(R.homework));
    }));

  test('只能以自己的名义建提醒；只有创建人和管理员能改、能删', () =>
    tx(async (t) => {
      await t.as(U.student);
      await t.rejects(`insert into public.reminders (title, due_at, created_by) values ('冒名', now(), $1)`, [U.teacher], /row-level security/);
      await t.q(`insert into public.reminders (title, due_at, created_by, visibility) values ('我的', now(), $1, 'private')`, [U.student]);
      assert.equal(await t.affected(`update public.reminders set title = '改了' where id = $1`, [R.company]), 0);
      assert.equal(await t.affected(`delete from public.reminders where id = $1`, [R.company]), 0);
      await t.rejects(`insert into public.reminder_assignees (reminder_id, user_id) values ($1, $2)`, [R.company, U.student], /row-level security/);
      await t.as(U.pending);
      await t.rejects(`insert into public.reminders (title, due_at, created_by) values ('待激活', now(), $1)`, [U.pending], /row-level security/);
      await t.as(U.admin);
      assert.equal(await t.affected(`update public.reminders set title = '管理员改' where id = $1`, [R.private]), 1);
    }));

  test('完成记录：只能记自己的，看不到的提醒不能记', () =>
    tx(async (t) => {
      await t.as(U.student);
      await t.q(`insert into public.completions (reminder_id, occurrence_at, completed_by) values ($1, $2, $3)`, [R.company, OCC, U.student]);
      await t.rejects(`insert into public.completions (reminder_id, occurrence_at, completed_by) values ($1, $2, $3)`, [R.company, OCC, U.student2], /row-level security/);
      await t.rejects(`insert into public.completions (reminder_id, occurrence_at, completed_by) values ($1, $2, $3)`, [R.private, OCC, U.student], /row-level security/);
    }));

  test('稍后提醒和讨论已读：只能写自己能看到的', () =>
    tx(async (t) => {
      await t.as(U.student);
      await t.q(`insert into public.snoozes (reminder_id, user_id, occurrence_at, until) values ($1, $2, $3, now())`, [R.company, U.student, OCC]);
      await t.rejects(`insert into public.snoozes (reminder_id, user_id, occurrence_at, until) values ($1, $2, $3, now())`, [R.private, U.student, OCC], /row-level security/);
      await t.q(`insert into public.discussion_reads (discussion_id, user_id, last_read_at) values ($1, $2, now())`, [D.teamB, U.student]);
      await t.as(U.student2);
      await t.rejects(`insert into public.discussion_reads (discussion_id, user_id, last_read_at) values ($1, $2, now())`, [D.teamB, U.student2], /row-level security/);
    }));
});

// ---------------------------------------------------------------------------
describe('已读回执（0008）', () => {
  test('只能记自己的、看得到的提醒；已读时间用服务器时间', () =>
    tx(async (t) => {
      await t.as(U.student2);
      await t.q(`insert into public.reminder_reads (reminder_id, occurrence_at, user_id, read_at) values ($1, $2, $3, '2000-01-01')`, [R.homework, OCC, U.student2]);
      await t.rejects(`insert into public.reminder_reads (reminder_id, occurrence_at, user_id) values ($1, $2, $3)`, [R.homework, OCC, U.student], /row-level security/);
      await t.rejects(`insert into public.reminder_reads (reminder_id, occurrence_at, user_id) values ($1, $2, $3)`, [R.private, OCC, U.student2], /row-level security/);
      await t.su();
      const at = await t.val(`select read_at from public.reminder_reads where user_id = $1`, [U.student2]);
      assert.ok(new Date(at).getFullYear() >= 2026);
    }));

  test('待激活的人不能记已读', () =>
    tx(async (t) => {
      await t.as(U.pending);
      await t.rejects(`insert into public.reminder_reads (reminder_id, occurrence_at, user_id) values ($1, $2, $3)`, [R.company, OCC, U.pending], /row-level security/);
    }));

  test('谁看过：创建人和管理员看得到全部，其他人只看得到自己的；不能改不能删', () =>
    tx(async (t) => {
      await t.su();
      await t.q(`insert into public.reminder_reads (reminder_id, occurrence_at, user_id) values ($1, $2, $3), ($1, $2, $4), ($1, $2, $5)`, [R.company, OCC, U.student, U.student2, U.outsider]);
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.reminder_reads'), 3);
      await t.as(U.admin);
      assert.equal(await t.count('select * from public.reminder_reads'), 3);
      await t.as(U.student);
      assert.deepEqual((await t.rows('select user_id from public.reminder_reads')).map((r) => r.user_id), [U.student]);
      assert.equal(await t.affected(`update public.reminder_reads set read_at = now() where user_id = $1`, [U.student]), 0);
      assert.equal(await t.affected(`delete from public.reminder_reads where user_id = $1`, [U.student]), 0);
    }));
});

// ---------------------------------------------------------------------------
describe('交文件和批改（0002 / 0008）', () => {
  const submit = (t, uid, status = 'submitted') =>
    t.q(`insert into public.submissions (reminder_id, occurrence_at, uploaded_by, file_path, file_name, status, created_at) values ($1, $2, $3, $4, 'a.pdf', $5, '2000-01-01') returning id`, [
      R.homework,
      OCC,
      uid,
      `${R.homework}/x/${uid}.pdf`,
      status,
    ]);

  test('交的时候状态一律是「已交」，时间用服务器时间；看不到的提醒不能交', () =>
    tx(async (t) => {
      await t.as(U.student2);
      const { rows } = await submit(t, U.student2, 'accepted');
      await t.su();
      const s = await t.one('select status, created_at, reviewed_by from public.submissions where id = $1', [rows[0].id]);
      assert.equal(s.status, 'submitted');
      assert.equal(s.reviewed_by, null);
      assert.ok(new Date(s.created_at).getFullYear() >= 2026);
      await t.as(U.student); // B 班，看不到 A 班的作业
      await t.rejects(`insert into public.submissions (reminder_id, occurrence_at, uploaded_by, file_path, file_name) values ($1, $2, $3, 'x', 'x')`, [R.homework, OCC, U.student], /row-level security/);
      await t.as(U.student2);
      await t.rejects(`insert into public.submissions (reminder_id, occurrence_at, uploaded_by, file_path, file_name) values ($1, $2, $3, 'x', 'x')`, [R.homework, OCC, U.teacher], /row-level security/);
    }));

  test('老师（创建人）能通过 / 退回并写批语，系统记下是谁什么时候批的', () =>
    tx(async (t) => {
      await t.as(U.student2);
      const id = (await submit(t, U.student2)).rows[0].id;
      await t.as(U.teacher);
      assert.equal(await t.affected(`update public.submissions set status = 'returned', review_note = $2 where id = $1`, [id, '第三题再算一遍'.padEnd(600, '。')]), 1);
      await t.su();
      const s = await t.one('select status, review_note, reviewed_by, reviewed_at from public.submissions where id = $1', [id]);
      assert.equal(s.status, 'returned');
      assert.equal(s.review_note.length, 500);
      assert.equal(s.reviewed_by, U.teacher);
      assert.ok(s.reviewed_at);
    }));

  test('学生不能给自己的作业改状态；别的成员也不能批', () =>
    tx(async (t) => {
      await t.as(U.student2);
      const id = (await submit(t, U.student2)).rows[0].id;
      assert.equal(await t.affected(`update public.submissions set status = 'accepted' where id = $1`, [id]), 0);
      await t.as(U.outsider);
      assert.equal(await t.affected(`update public.submissions set status = 'accepted' where id = $1`, [id]), 0);
      await t.su();
      assert.equal(await t.val('select status from public.submissions where id = $1', [id]), 'submitted');
    }));

  test('批改时不能顺手改文件、提交人、时间（老师和管理员都不行）', () =>
    tx(async (t) => {
      await t.as(U.student2);
      const id = (await submit(t, U.student2)).rows[0].id;
      await t.as(U.teacher);
      for (const set of [`file_path = 'evil'`, `uploaded_by = '${U.teacher}'`, `created_at = '2026-01-01'`, `file_name = 'b.pdf'`]) {
        await t.rejects(`update public.submissions set ${set} where id = $1`, [id], /only status and review_note/);
      }
      await t.as(U.admin);
      await t.rejects(`update public.submissions set occurrence_at = now() where id = $1`, [id], /only status and review_note/);
    }));

  test('退回重交：老师能撤掉学生这一次的「已完成」，别人不能', () =>
    tx(async (t) => {
      await t.su();
      await t.q(`insert into public.completions (reminder_id, occurrence_at, completed_by) values ($1, $2, $3)`, [R.homework, OCC, U.student2]);
      await t.as(U.outsider);
      assert.equal(await t.affected(`delete from public.completions where completed_by = $1`, [U.student2]), 0);
      await t.as(U.teacher);
      assert.equal(await t.affected(`delete from public.completions where completed_by = $1`, [U.student2]), 1);
    }));
});

// ---------------------------------------------------------------------------
describe('附件和文件存储（0002 / 0004 / 0005）', () => {
  test('提醒附件：只有创建人 / 管理员能加，看得到提醒的人都能看', () =>
    tx(async (t) => {
      await t.as(U.student2);
      await t.rejects(`insert into public.reminder_attachments (reminder_id, uploaded_by, file_path, file_name) values ($1, $2, 'p', 'a.jpg')`, [R.teamA, U.student2], /row-level security/);
      await t.as(U.teacher);
      await t.q(`insert into public.reminder_attachments (reminder_id, uploaded_by, file_path, file_name) values ($1, $2, 'p', 'a.jpg')`, [R.teamA, U.teacher]);
      await t.as(U.student2);
      assert.equal(await t.count('select * from public.reminder_attachments'), 1);
      await t.as(U.student);
      assert.equal(await t.count('select * from public.reminder_attachments'), 0);
    }));

  test('文件桶：看不到的提醒不能上传，也读不到别人的文件', () =>
    tx(async (t) => {
      await t.as(U.student2);
      await t.q(`insert into storage.objects (bucket_id, name, owner_id) values ('submissions', $1, $2)`, [`${R.homework}/x/1.pdf`, U.student2]);
      await t.as(U.student);
      await t.rejects(`insert into storage.objects (bucket_id, name, owner_id) values ('submissions', $1, $2)`, [`${R.homework}/x/2.pdf`, U.student], /row-level security/);
      await t.rejects(`insert into storage.objects (bucket_id, name, owner_id) values ('attachments', $1, $2)`, [`${R.toStudent}/a.jpg`, U.student], /row-level security/);
      assert.equal(await t.count(`select * from storage.objects where bucket_id = 'submissions'`), 0);
      await t.as(U.pending);
      await t.rejects(`insert into storage.objects (bucket_id, name, owner_id) values ('submissions', $1, $2)`, [`${R.company}/x/3.pdf`, U.pending], /row-level security/);
    }));
});

// ---------------------------------------------------------------------------
describe('讨论（继承 DZF，0005）', () => {
  test('范围：全体的都看得到，指定小组的只有组里的人和发起人、管理员', () =>
    tx(async (t) => {
      for (const [uid, n] of [[U.student, 2], [U.student2, 1], [U.teacher, 2], [U.admin, 2], [U.outsider, 1], [U.pending, 0]]) {
        await t.as(uid);
        assert.equal(await t.count('select * from public.discussions'), n, uid);
      }
    }));

  test('看得到才能留言；结束后谁都不能留言；只有发起人能结束', () =>
    tx(async (t) => {
      await t.as(U.student);
      await t.q(`insert into public.discussion_comments (discussion_id, author_id, body) values ($1, $2, '我报名')`, [D.teamB, U.student]);
      await t.as(U.student2);
      await t.rejects(`insert into public.discussion_comments (discussion_id, author_id, body) values ($1, $2, 'x')`, [D.teamB, U.student2], /row-level security/);
      await t.as(U.admin);
      assert.equal(await t.affected(`update public.discussions set closed_at = now() where id = $1`, [D.teamB]), 0);
      await t.as(U.teacher);
      assert.equal(await t.affected(`update public.discussions set closed_at = now(), conclusion = '定了' where id = $1`, [D.teamB]), 1);
      await t.as(U.student);
      await t.rejects(`insert into public.discussion_comments (discussion_id, author_id, body) values ($1, $2, '还想说')`, [D.teamB, U.student], /row-level security/);
    }));

  test('别人不能改讨论的内容和范围；发起人和管理员能删', () =>
    tx(async (t) => {
      await t.as(U.student);
      assert.equal(await t.affected(`update public.discussions set title = '改标题' where id = $1`, [D.company]), 0);
      await t.rejects(`insert into public.discussion_members (discussion_id, user_id) values ($1, $2)`, [D.teamB, U.student2], /row-level security/);
      assert.equal(await t.affected(`delete from public.discussions where id = $1`, [D.company]), 0);
      await t.rejects(`insert into public.discussion_files (discussion_id, uploaded_by, file_path, file_name) values ($1, $2, 'p', 'x.pdf')`, [D.company, U.student], /row-level security/);
      await t.as(U.admin);
      assert.equal(await t.affected(`delete from public.discussions where id = $1`, [D.company]), 1);
      await t.as(U.teacher);
      assert.equal(await t.affected(`delete from public.discussions where id = $1`, [D.teamB]), 1);
    }));

  test('提醒的指派名单跟着提醒的可见范围走', () =>
    tx(async (t) => {
      await t.as(U.outsider);
      assert.equal(await t.count('select * from public.reminder_assignees'), 0);
      await t.as(U.student2);
      assert.equal(await t.count('select * from public.reminder_assignees'), 1); // 只看得到 A 班作业的指派
    }));
});

// ---------------------------------------------------------------------------
describe('登录（0009）', () => {
  test('登录身份：本人和管理员看得到，客户端谁都不能写；登录请求谁都碰不到', () =>
    tx(async (t) => {
      await t.su();
      await t.q(`insert into public.login_identities (provider, subject, user_id, nickname) values ('wechat_open', 'o_student', $1, '微信昵称')`, [U.student]);
      await t.q(`insert into public.login_requests (secret_hash, provider) values ('h', 'qq')`);
      await t.as(U.student);
      assert.equal(await t.count('select * from public.login_identities'), 1);
      await t.rejects(`insert into public.login_identities (provider, subject, user_id) values ('qq', 'o_x', $1)`, [U.student], /row-level security/);
      assert.equal(await t.affected(`delete from public.login_identities`), 0);
      assert.equal(await t.count('select * from public.login_requests'), 0);
      await t.rejects(`insert into public.login_requests (secret_hash, provider) values ('h', 'qq')`, [], /row-level security/);
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.login_identities'), 0);
      await t.as(U.admin);
      assert.equal(await t.count('select * from public.login_identities'), 1);
    }));
});

// ---------------------------------------------------------------------------
describe('推送（0010）', () => {
  test('通知设置：只能看、改自己的；管理员能看全部', () =>
    tx(async (t) => {
      await t.as(U.student);
      await t.q(`insert into public.notify_prefs (user_id, wechat, dnd_from) values ($1, false, '22:00')`, [U.student]);
      await t.rejects(`insert into public.notify_prefs (user_id) values ($1)`, [U.student2], /row-level security/);
      await t.rejects(`update public.notify_prefs set dnd_from = '25:99' where user_id = $1`, [U.student], /check/);
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.notify_prefs'), 0);
      assert.equal(await t.affected(`update public.notify_prefs set wechat = true`), 0);
      await t.as(U.admin);
      assert.equal(await t.count('select * from public.notify_prefs'), 1);
    }));

  test('服务号绑定：客户端不能自己写（只能扫码由服务器绑），本人能解绑', () =>
    tx(async (t) => {
      await t.su();
      await t.q(`insert into public.wechat_bindings (user_id, openid) values ($1, 'o_mp_student'), ($2, 'o_mp_s2')`, [U.student, U.student2]);
      await t.as(U.student);
      assert.equal(await t.count('select * from public.wechat_bindings'), 1);
      await t.rejects(`insert into public.wechat_bindings (user_id, openid) values ($1, 'o_fake')`, [U.outsider], /row-level security/);
      assert.equal(await t.affected(`update public.wechat_bindings set openid = 'o_hijack' where user_id = $1`, [U.student2]), 0);
      assert.equal(await t.affected(`delete from public.wechat_bindings where user_id = $1`, [U.student2]), 0);
      assert.equal(await t.affected(`delete from public.wechat_bindings where user_id = $1`, [U.student]), 1);
      await t.as(U.admin);
      assert.equal(await t.affected(`delete from public.wechat_bindings where user_id = $1`, [U.student2]), 1);
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.wechat_bind_tickets'), 0);
      await t.rejects(`insert into public.wechat_bind_tickets (scene, user_id, expires_at) values ('bind_x', $1, now())`, [U.teacher], /row-level security/);
    }));

  test('群机器人：只有管理员看得到、改得了；地址必须 https，阶段只能是 pre / due / overdue', () =>
    tx(async (t) => {
      await t.su();
      await t.q(`insert into public.team_webhooks (team_id, kind, url) values ($1, 'wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret')`, [T.A]);
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.team_webhooks'), 0);
      await t.rejects(`insert into public.team_webhooks (kind, url) values ('dingtalk', 'https://oapi.dingtalk.com/robot/send')`, [], /row-level security/);
      await t.as(U.admin);
      assert.equal(await t.count('select * from public.team_webhooks'), 1);
      await t.q(`insert into public.team_webhooks (kind, url, stages) values ('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/x', '{pre,overdue}')`);
      await t.rejects(`insert into public.team_webhooks (kind, url) values ('wecom', 'http://insecure.example.cn')`, [], /check/);
      await t.rejects(`insert into public.team_webhooks (kind, url, stages) values ('wecom', 'https://x.cn', '{later}')`, [], /check/);
      await t.rejects(`insert into public.team_webhooks (kind, url, stages) values ('wecom', 'https://x.cn', '{}')`, [], /check/);
      await t.rejects(`insert into public.team_webhooks (kind, url) values ('slack', 'https://x.cn')`, [], /check/);
    }));

  test('发送记录和缓存：只有管理员能看记录，缓存谁都碰不到', () =>
    tx(async (t) => {
      await t.su();
      await t.q(`insert into public.notification_log (dedupe_key, channel, status) values ('k1', 'wechat', 'sent')`);
      await t.q(`insert into public.kv_cache (key, value, expires_at) values ('wechat_mp_access_token:x', 'TOKEN', now() + interval '1 hour')`);
      await t.as(U.teacher);
      assert.equal(await t.count('select * from public.notification_log'), 0);
      await t.rejects(`insert into public.notification_log (dedupe_key, channel, status) values ('k2', 'wechat', 'sent')`, [], /row-level security/);
      assert.equal(await t.count('select * from public.kv_cache'), 0);
      await t.as(U.admin);
      assert.equal(await t.count('select * from public.notification_log'), 1);
      assert.equal(await t.count('select * from public.kv_cache'), 0);
    }));
});
