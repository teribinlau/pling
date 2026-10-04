#!/usr/bin/env bash
# 叮一下 · 升级到新版本（网页、云函数、数据库迁移、部署配置；数据和 .env 不动）
#   scripts/update.sh 0.2.0                        从发布地址下载 pling-server-0.2.0.tar.gz
#   scripts/update.sh /root/pling-server-0.2.0.tar.gz   用已经下载好的安装包（国内服务器下载 GitHub 慢时用这个）
# 发布地址：.env 的 PLING_RELEASE_BASE（默认 GitHub Releases），可以换成自己的镜像
# 升级前会先备份（scripts/backup.sh）。
source "$(dirname "$0")/lib.sh"

arg=${1:-}
[[ -n "$arg" ]] || die "用法：scripts/update.sh 版本号 | 安装包路径"
need_docker

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [[ -f "$arg" ]]; then
  pkg=$arg
else
  ver=${arg#v}
  base=$(env_get PLING_RELEASE_BASE)
  base=${base:-https://github.com/teribinlau/pling/releases/download}
  url="${base%/}/v$ver/pling-server-$ver.tar.gz"
  info "下载 $url"
  curl -fL --retry 3 -o "$tmp/pkg.tar.gz" "$url" || die "下载失败。可以在电脑上下载好再传到服务器：scripts/update.sh /路径/pling-server-$ver.tar.gz"
  if curl -fsL -o "$tmp/pkg.sha256" "$url.sha256"; then
    (cd "$tmp" && echo "$(cut -d' ' -f1 pkg.sha256)  pkg.tar.gz" | sha256sum -c --quiet -) || die "安装包校验失败（sha256 不一致）"
  fi
  pkg="$tmp/pkg.tar.gz"
fi

mkdir -p "$tmp/new"
tar -xzf "$pkg" -C "$tmp/new"
new=$(find "$tmp/new" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[[ -f "$new/deploy/docker-compose.yml" && -d "$new/supabase/migrations" && -f "$new/web/index.html" ]] \
  || die "安装包内容不对（应该有 deploy/、supabase/、web/）"
newver=$(cat "$new/VERSION" 2>/dev/null || echo "?")
curver=$(cat "$ROOT_DIR/VERSION" 2>/dev/null || echo "?")
info "当前版本 $curver → 新版本 $newver"

step "升级前备份"
"$DEPLOY_DIR/scripts/backup.sh"

step "替换程序文件"
# 数据目录（PLING_DATA_DIR，默认 ../data）和 deploy/.env 不动
rm -rf "$ROOT_DIR/supabase" "$ROOT_DIR/web"
cp -a "$new/supabase" "$new/web" "$ROOT_DIR/"
cp -a "$new/VERSION" "$ROOT_DIR/VERSION" 2>/dev/null || true
for item in docker-compose.yml .env.example scripts supabase web functions-main README.md; do
  [[ -e "$new/deploy/$item" ]] || continue
  rm -rf "${DEPLOY_DIR:?}/$item"
  cp -a "$new/deploy/$item" "$DEPLOY_DIR/$item"
done
ok "文件已更新"

# 新版本的 .env.example 里多出来的变量，提示一下
missing=$(comm -23 <(grep -oE '^[A-Z_][A-Z0-9_]*=' "$DEPLOY_DIR/.env.example" | sort -u) <(grep -oE '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" | sort -u) | tr -d '=' | tr '\n' ' ')
[[ -z "$missing" ]] || warn "新版本多了这些配置项（.env 里没有，会用默认值）：$missing"

step "拉取镜像、重启"
compose pull --quiet || die "拉镜像失败（镜像加速？）。程序文件已经换好，网络好了以后再运行：docker compose pull && docker compose up -d && scripts/migrate.sh"
compose up -d --remove-orphans
"$DEPLOY_DIR/scripts/migrate.sh"
compose up -d
compose restart web functions
ok "已升级到 $newver"
