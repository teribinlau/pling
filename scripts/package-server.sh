#!/usr/bin/env bash
# 打服务器安装包：pling-server-<版本>.tar.gz（网页 + 云函数 + 数据库迁移 + 部署脚本）
#   scripts/package-server.sh            用 package.json 的版本号，先 npm run build
#   scripts/package-server.sh --no-build 直接用现有的 dist/
# 输出到 release/：pling-server-<版本>.tar.gz 和 .sha256
# 客户解压后运行 pling-<版本>/deploy/scripts/install.sh（见 docs/部署指南.md）
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=

ver=$(node -p "require('./package.json').version")
node scripts/sync-core.mjs --check
if [[ -n "$BUILD" ]]; then
  # 网页版不内置任何服务器地址：连接信息由服务器的 /config.json 提供
  VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build
fi
[[ -f dist/index.html ]] || { echo "没有 dist/：先 npm run build" >&2; exit 1; }

out=release
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/pling-$ver"
mkdir -p "$root/supabase" "$root/deploy"

printf '%s\n' "$ver" > "$root/VERSION"
cp -a dist "$root/web"
cp -a supabase/migrations "$root/supabase/migrations"
cp -a supabase/functions "$root/supabase/functions"
# 部署目录：不带 .env 和本机生成的东西
tar -C deploy --exclude='.env' --exclude='.env.*.tmp' -cf - . | tar -C "$root/deploy" -xf -
cp README.md "$root/README.md"
mkdir -p "$root/docs"
cp docs/部署指南.md docs/申请指南.md "$root/docs/" 2>/dev/null || true

chmod +x "$root"/deploy/scripts/*.sh "$root"/deploy/web/entrypoint/*.sh

mkdir -p "$out"
pkg="$out/pling-server-$ver.tar.gz"
tar -C "$stage" --owner=0 --group=0 -czf "$pkg" "pling-$ver"
(cd "$out" && sha256sum "pling-server-$ver.tar.gz" > "pling-server-$ver.tar.gz.sha256")
echo "已生成 $pkg（$(du -h "$pkg" | cut -f1)）"
