#!/usr/bin/env bash
# 起一个本机测试用的 PostgreSQL（模拟 Supabase 的角色和 schema），跑完全部迁移。
#   scripts/dev-db/up.sh            # 默认端口 54329，数据目录 .devdb/（已存在就直接启动）
#   scripts/dev-db/up.sh --fresh    # 删掉整个测试库目录重建
#   scripts/dev-db/up.sh --db NAME  # 在同一个实例里另建一个库（各自跑测试互不干扰），已有就只补跑迁移
# 连接串：postgres://postgres@127.0.0.1:54329/<库名，默认 postgres>
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
PORT=${PLING_DEVDB_PORT:-54329}
DATA=${PLING_DEVDB_DIR:-$ROOT/.devdb}
DB=postgres
FRESH=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --db) DB="$2"; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres

if [[ -n "$FRESH" && -d "$DATA" ]]; then
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
fi

RUN_AS=()
if [[ $(id -u) == 0 ]]; then
  # initdb / postgres 不能用 root 跑
  id pling-pg >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin pling-pg
  RUN_AS=(runuser -u pling-pg --)
  mkdir -p "$DATA" && chown pling-pg "$DATA"
fi

if [[ ! -f "$DATA/PG_VERSION" ]]; then
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  cat >> "$DATA/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$DATA'
wal_level = logical
fsync = off
synchronous_commit = off
full_page_writes = off
timezone = 'UTC'
EOF
  NEW=1
fi

if ! "$PGBIN/pg_isready" -q; then
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null
fi

if [[ "$DB" != postgres ]] && ! psql -Atc "select 1 from pg_database where datname = '$DB'" | grep -q 1; then
  createdb -h 127.0.0.1 -p "$PORT" -U postgres "$DB"
  NEW=1
fi
export PGDATABASE=$DB

if [[ "${NEW:-}" == 1 ]]; then
  psql -q -v ON_ERROR_STOP=1 -f scripts/dev-db/bootstrap.sql 2>&1 | grep -v -E "NOTICE|^$" || true
fi

for f in supabase/migrations/*.sql; do
  out=$(psql -q -v ON_ERROR_STOP=1 -f "$f" 2>&1) || { echo "$out" | grep -v NOTICE >&2; echo "迁移失败：$f" >&2; exit 1; }
done
echo "测试库就绪：postgres://postgres@127.0.0.1:$PORT/$DB"
