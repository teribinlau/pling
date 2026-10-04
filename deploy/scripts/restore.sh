#!/usr/bin/env bash
# 叮一下 · 从 backup.sh 的备份恢复（会覆盖当前的全部数据：账号、提醒、讨论、上传的文件……）
#
#   scripts/restore.sh /opt/pling/data/backups/pling-backup-20261004-033000.tar
#   scripts/restore.sh 备份文件 --yes        不再确认
#
# 换服务器恢复：先把备份里的 env 复制成新服务器的 deploy/.env（同样的密钥），再运行 install.sh 装好，最后运行本脚本。
# 只恢复数据（public / auth / storage / pling_private 四个 schema 的表数据 + 上传的文件）：
# 表结构由当前版本的迁移负责，所以可以把旧版本的备份恢复到同版本或更新的版本上，反过来不行。
source "$(dirname "$0")/lib.sh"

file=${1:-}
YES=
[[ "${2:-}" == "--yes" || "${2:-}" == "-y" ]] && YES=1
[[ -f "$file" ]] || die "用法：scripts/restore.sh 备份文件.tar [--yes]"
need_docker

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
  compose exec -T db rm -f /tmp/pling-restore.dump /tmp/pling-restore.list >/dev/null 2>&1 || true
}
trap cleanup EXIT

tar -xf "$file" -C "$tmp"
[[ -s "$tmp/db.dump" && -f "$tmp/storage.tar.gz" ]] || die "备份文件不完整（没有 db.dump / storage.tar.gz）"
bver=$(cat "$tmp/VERSION" 2>/dev/null || echo "?")
cver=$(cat "$ROOT_DIR/VERSION" 2>/dev/null || echo "?")
info "备份的版本：$bver；当前版本：$cver"
if [[ -f "$tmp/env" ]]; then
  old=$(grep -E '^JWT_SECRET=' "$tmp/env" | head -n1 | cut -d= -f2- | tr -d "'\"")
  [[ "$old" == "$(env_get JWT_SECRET)" ]] || warn "备份的 JWT_SECRET 和现在的不一样：恢复以后所有人需要重新登录（数据不受影响）"
fi

if [[ -z "$YES" ]]; then
  [[ -t 0 ]] || die "非交互运行请加 --yes"
  read -r -p "会用备份覆盖当前的全部数据，输入「恢复」继续：" ans
  [[ "$ans" == 恢复 ]] || die "已取消"
fi

step "停止服务（数据库除外）"
compose stop web functions auth rest realtime storage api-gw >/dev/null
compose up -d db >/dev/null
wait_healthy db 120 || die "数据库没有起来"

step "准备恢复清单"
compose cp "$tmp/db.dump" db:/tmp/pling-restore.dump >/dev/null
compose exec -T db pg_restore -l /tmp/pling-restore.dump > "$tmp/full.list"
# 只要这四个 schema 的「表数据」和「序列值」；各服务自己的迁移记录不恢复
awk '
  /^;/ { next }
  {
    kind = ""; schema = ""; name = ""
    if ($4 == "TABLE" && $5 == "DATA") { kind = "data"; schema = $6; name = $7 }
    else if ($4 == "SEQUENCE" && $5 == "SET") { kind = "seq"; schema = $6; name = $7 }
    else next
    if (schema != "public" && schema != "auth" && schema != "storage" && schema != "pling_private") next
    if (schema == "auth" && name == "schema_migrations") next
    if (schema == "storage" && name == "migrations") next
    if (schema == "pling_private" && name == "migrations") next
    print
  }' "$tmp/full.list" > "$tmp/restore.list"
n=$(grep -c "TABLE DATA" "$tmp/restore.list" || true)
(( n > 0 )) || die "备份里没有找到可以恢复的表"
info "要恢复 $n 张表的数据"
compose cp "$tmp/restore.list" db:/tmp/pling-restore.list >/dev/null

step "清空现有数据并导入"
# 只清空备份里有、当前库里也存在的表（表名来自 pg_restore 的清单，都是普通的小写名字）
names=$(awk '$4 == "TABLE" && $5 == "DATA" && $6 ~ /^[a-z_][a-z0-9_]*$/ && $7 ~ /^[a-z_][a-z0-9_]*$/ { printf "%s'"'"'%s.%s'"'"'", (n++ ? ", " : ""), $6, $7 }' "$tmp/restore.list")
PSQL_USER=supabase_admin psql_db <<SQL
do \$\$
declare
  t text;
begin
  foreach t in array array[$names]::text[] loop
    if to_regclass(t) is not null then
      execute 'truncate table ' || t || ' cascade';
    end if;
  end loop;
end \$\$;
SQL
compose exec -T db pg_restore -U supabase_admin -d postgres --data-only --disable-triggers --no-owner \
  -L /tmp/pling-restore.list /tmp/pling-restore.dump 2> "$tmp/restore.err" || true
if grep -q "ERROR" "$tmp/restore.err"; then
  warn "导入时有错误（多半是备份里有、新版本已经去掉的表或列）："
  grep -E "ERROR|Command was" "$tmp/restore.err" | head -n 20 >&2
fi

step "恢复上传的文件"
DATA=$(data_dir)
rm -rf "$DATA/storage.restoring"
mkdir -p "$DATA/storage.restoring"
tar -xzf "$tmp/storage.tar.gz" -C "$DATA/storage.restoring"
[[ -d "$DATA/storage.restoring/storage" ]] || die "备份里的文件目录不对"
rm -rf "$DATA/storage.old"
[[ -d "$DATA/storage" ]] && mv "$DATA/storage" "$DATA/storage.old"
mv "$DATA/storage.restoring/storage" "$DATA/storage"
rm -rf "$DATA/storage.restoring" "$DATA/storage.old"

step "启动"
compose up -d
"$DEPLOY_DIR/scripts/migrate.sh"
ok "已从 $(basename "$file") 恢复。所有人需要重新登录。"
