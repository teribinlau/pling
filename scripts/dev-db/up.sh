#!/usr/bin/env bash
# 起一个本机测试用的 PostgreSQL（模拟 Supabase 的角色和 schema），跑完全部迁移。
#   scripts/dev-db/up.sh            # 默认端口 54329，数据目录 .devdb/（已存在就直接启动）
#   scripts/dev-db/up.sh --fresh    # 删掉重建
# 连接串：postgres://postgres@127.0.0.1:54329/postgres
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
PORT=${PLING_DEVDB_PORT:-54329}
DATA=${PLING_DEVDB_DIR:-$ROOT/.devdb}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres

if [[ "${1:-}" == "--fresh" && -d "$DATA" ]]; then
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

if [[ "${NEW:-}" == 1 ]]; then
  psql -q -v ON_ERROR_STOP=1 -f scripts/dev-db/bootstrap.sql
fi

for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -f "$f" 2>&1 | grep -v -E "NOTICE|^$" || true
  if [[ ${PIPESTATUS[0]} != 0 ]]; then echo "迁移失败：$f" >&2; exit 1; fi
done
echo "测试库就绪：postgres://postgres@127.0.0.1:$PORT/postgres"
