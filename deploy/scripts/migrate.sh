#!/usr/bin/env bash
# 叮一下 · 执行数据库迁移（../supabase/migrations/*.sql，按文件名顺序）
#   scripts/migrate.sh          执行新的 / 改过的迁移文件，然后写入推送定时任务的设置
#   scripts/migrate.sh --all    全部重新执行一遍（每个文件都可以重复执行）
# 已执行的文件和它的 sha256 记在 pling_private.migrations。
source "$(dirname "$0")/lib.sh"

ALL=
[[ "${1:-}" == "--all" ]] && ALL=1

MIG_DIR="$ROOT_DIR/supabase/migrations"
[[ -d "$MIG_DIR" ]] || die "没有找到迁移文件目录：$MIG_DIR"
need_docker

step "等数据库、登录服务、文件服务就绪"
for svc in db auth storage; do
  wait_healthy "$svc" 240 || die "$svc 没有就绪：docker compose logs $svc 看原因"
done
# 登录服务和文件服务启动时会建自己的表（auth.users、storage.objects），迁移要用到
for i in $(seq 1 60); do
  ready=$(printf "select (to_regclass('auth.users') is not null and to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null)::int;" | psql_db -At)
  [[ "$ready" == 1 ]] && break
  sleep 2
done
[[ "${ready:-0}" == 1 ]] || die "auth.users / storage.objects 还没建好：docker compose logs auth storage 看原因"
ok "数据库就绪"

printf '%s\n' \
  "create schema if not exists pling_private;" \
  "revoke all on schema pling_private from public;" \
  "create table if not exists pling_private.migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now());" \
  | psql_db

step "执行迁移"
count=0
for f in "$MIG_DIR"/*.sql; do
  name=$(basename "$f")
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  if [[ -z "$ALL" ]]; then
    have=$(printf "select sha256 from pling_private.migrations where name = '%s';" "$name" | psql_db -At)
    if [[ "$have" == "$sum" ]]; then
      printf '%s  %s（已执行）%s\n' "$C_DIM" "$name" "$C_OFF"
      continue
    fi
  fi
  if ! out=$(psql_db -f - < "$f" 2>&1); then
    printf '%s\n' "$out" | grep -v NOTICE >&2
    die "迁移失败：$name"
  fi
  printf "insert into pling_private.migrations (name, sha256) values ('%s', '%s') on conflict (name) do update set sha256 = excluded.sha256, applied_at = now();" "$name" "$sum" | psql_db
  ok "$name"
  count=$((count + 1))
done
info "执行了 $count 个迁移文件"

step "推送定时任务"
secret=$(env_get PLING_CRON_SECRET)
[[ "$secret" =~ ^[A-Za-z0-9]{16,}$ ]] || die ".env 里的 PLING_CRON_SECRET 不对（要 16 位以上字母数字），重新运行 scripts/install.sh 会自动生成"
psql_db <<SQL
insert into pling_private.settings (key, value) values
  ('notify_url', 'http://functions:9000/notify'),
  ('cron_secret', '$secret')
on conflict (key) do update set value = excluded.value;
SQL

# 迁移里用 postgres 角色建 pg_cron 任务；万一权限不够没建上，用超级用户补建
jobs=$(printf "select count(*) from cron.job where jobname = 'pling-notify';" | psql_db -At 2>/dev/null || echo 0)
if [[ "$jobs" != 1 ]]; then
  warn "postgres 角色没能建定时任务，改用 supabase_admin 建"
  PSQL_USER=supabase_admin psql_db <<'SQL' || true
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'pling-notify';
select cron.schedule('pling-notify', '* * * * *', 'select pling_private.call_notify()');
SQL
  jobs=$(printf "select count(*) from cron.job where jobname = 'pling-notify';" | PSQL_USER=supabase_admin psql_db -At 2>/dev/null || echo 0)
fi
[[ "$jobs" == 1 ]] && ok "每分钟一次的推送任务已就绪" || warn "推送定时任务没建上：服务号 / 群机器人不会自动发消息（见部署指南「常见问题」）"

# 机构名：只在数据库里还没设的时候用 .env 的（管理员在应用里改过的不覆盖）
org=$(env_get PLING_ORG_NAME)
if [[ -n "$org" ]]; then
  esc=${org//\'/\'\'}
  printf "update public.app_settings set org_name = '%s' where id = 1 and org_name = '';" "$esc" | psql_db
fi

ok "数据库迁移完成"
