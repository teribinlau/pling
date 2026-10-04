-- 叮一下 · 讨论可以设截止日期，出现在日历里（继承自 DZF 提醒 v0.6.0）
-- 重复执行无害。
--
-- due_date 是柏林本地的日期（不带时间），可以不设。设了的讨论会出现在日历的那一天；到期不弹提醒。
-- 发起人改截止日期也算一次「动静」（大家的未读会亮）；讨论结束后和别的内容一样不能再改。

alter table public.discussions add column if not exists due_date date;
create index if not exists discussions_due_date_idx on public.discussions (due_date) where due_date is not null;

-- 和 0006 一样，只是把 due_date 加进「内容」的比较里
create or replace function public.discussions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.comment_count := 0;
    new.closed_at := null;
    new.created_at := now();
    new.last_activity_at := now();
    new.last_activity_by := new.created_by;
  elsif pg_trigger_depth() = 1 then
    -- 客户端直接改的（留言计数触发器改的时候 depth = 2，不走这里）
    if old.closed_at is not null and new.closed_at is not null and (
         new.title is distinct from old.title
      or new.body is distinct from old.body
      or new.visibility is distinct from old.visibility
      or new.conclusion is distinct from old.conclusion
      or new.due_date is distinct from old.due_date
    ) then
      raise exception 'discussion is closed';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.comment_count := old.comment_count;
    new.last_activity_at := old.last_activity_at;
    new.last_activity_by := old.last_activity_by;
    if new.closed_at is not null and old.closed_at is null then
      new.closed_at := now();           -- 结束时间用服务器时间
    elsif new.closed_at is not null then
      new.closed_at := old.closed_at;   -- 已经结束的，结束时间不变
    end if;
    if new.title is distinct from old.title
      or new.body is distinct from old.body
      or new.visibility is distinct from old.visibility
      or new.closed_at is distinct from old.closed_at
      or new.conclusion is distinct from old.conclusion
      or new.due_date is distinct from old.due_date then
      new.last_activity_at := now();
      new.last_activity_by := auth.uid();
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
