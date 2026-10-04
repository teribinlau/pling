#!/usr/bin/env bash
# 叮一下 · 备份：数据库（pg_dump 自定义格式）+ 上传的文件 + 配置（.env，含密钥）
#   scripts/backup.sh               备份到 ${PLING_DATA_DIR}/backups/，保留最近 14 份
#   scripts/backup.sh --keep 30     保留最近 30 份
# 建议加到 root 的定时任务（crontab -e）：
#   30 3 * * * /opt/pling/deploy/scripts/backup.sh >> /var/log/pling-backup.log 2>&1
# 备份里有 .env（数据库密码、JWT 密钥），请存到安全的地方；恢复步骤见 docs/部署指南.md「备份和恢复」
source "$(dirname "$0")/lib.sh"

KEEP=14
[[ "${1:-}" == "--keep" ]] && KEEP=${2:?--keep 后面要跟数字}
need_docker

DATA=$(data_dir)
DEST="$DATA/backups"
mkdir -p "$DEST"
stamp=$(date +%Y%m%d-%H%M%S)
work="$DEST/.pling-$stamp"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

info "导出数据库…"
# 用超级用户导出整个库（含登录账号 auth、文件索引 storage、应用数据 public 和 pling_private）
compose exec -T db pg_dump -U supabase_admin -d postgres -Fc --no-owner > "$work/db.dump"
[[ -s "$work/db.dump" ]] || die "数据库导出是空的"

info "打包上传的文件…"
tar -C "$DATA" -czf "$work/storage.tar.gz" storage

cp "$ENV_FILE" "$work/env"
cp "$ROOT_DIR/VERSION" "$work/VERSION" 2>/dev/null || true

out="$DEST/pling-backup-$stamp.tar"
tar -C "$work" -cf "$out" .
chmod 600 "$out"
ok "备份完成：$out（$(du -h "$out" | cut -f1)）"

# 只留最近 KEEP 份
mapfile -t old < <(ls -1t "$DEST"/pling-backup-*.tar 2>/dev/null | tail -n +$((KEEP + 1)))
for f in "${old[@]}"; do rm -f "$f"; done
(( ${#old[@]} )) && info "删掉了 ${#old[@]} 份旧备份" || true
