#!/usr/bin/env bash
# 叮一下 · 部署脚本的公共函数（被其他脚本 source，不单独执行）
# 约定：脚本都在 deploy/scripts/ 里，执行时切到 deploy/ 目录；.env 在 deploy/.env

set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT_DIR=$(cd "$DEPLOY_DIR/.." && pwd)
ENV_FILE="$DEPLOY_DIR/.env"
cd "$DEPLOY_DIR"

if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_DIM=$'\e[2m'; C_OFF=$'\e[0m'
else
  C_RED=; C_GRN=; C_YEL=; C_DIM=; C_OFF=
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s! %s%s\n' "$C_YEL" "$*" "$C_OFF" >&2; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }
step() { printf '\n%s== %s ==%s\n' "$C_DIM" "$*" "$C_OFF"; }

# ---------------------------------------------------------------------------
# .env 读写（不 source .env：值里可能有空格、$、中文）
# 写入时一律用单引号包起来（docker compose 对单引号里的内容不做 $ 替换）
# ---------------------------------------------------------------------------
env_get() {
  local key=$1 line val
  [[ -f "$ENV_FILE" ]] || { printf ''; return 0; }
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
  val=${line#*=}
  if [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then
    val=${val:1:${#val}-2}
  elif [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then
    val=${val:1:${#val}-2}
  fi
  printf '%s' "$val"
}

env_set() {
  local key=$1 val=$2 quoted tmp
  [[ "$val" != *"'"* ]] || die "$key 的值里不能有单引号（'）"
  [[ "$val" != *$'\n'* ]] || die "$key 的值不能换行"
  quoted="'$val'"
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    awk -v k="$key" -v v="$quoted" 'BEGIN { done = 0 }
      index($0, k "=") == 1 && !done { print k "=" v; done = 1; next }
      index($0, k "=") == 1 { next }
      { print }' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$quoted" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# 只在还没有值的时候设置（重复运行安装脚本不会换掉已有的密钥）
env_default() {
  local key=$1 val=$2
  [[ -n "$(env_get "$key")" ]] || env_set "$key" "$val"
}

# ---------------------------------------------------------------------------
# 随机数和 JWT（只用 openssl，不依赖 node / python）
# ---------------------------------------------------------------------------
rand_hex() { openssl rand -hex "$1"; }
b64url() { openssl enc -base64 -A | tr '+/' '-_' | tr -d '='; }

# jwt_hs256 <secret> <payload-json>
jwt_hs256() {
  local secret=$1 payload=$2 header='{"alg":"HS256","typ":"JWT"}' signing sig
  signing="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"
  sig=$(printf '%s' "$signing" | openssl dgst -binary -sha256 -hmac "$secret" | b64url)
  printf '%s.%s' "$signing" "$sig"
}

# ---------------------------------------------------------------------------
# docker compose
# ---------------------------------------------------------------------------
compose() { docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$ENV_FILE" "$@"; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "没有找到 docker。先安装 Docker（见 docs/部署指南.md「安装 Docker」）"
  docker compose version >/dev/null 2>&1 || die "没有找到 docker compose（v2）。安装 docker-compose-plugin 后再试"
  docker info >/dev/null 2>&1 || die "连不上 Docker（没启动？用 sudo？）：先 systemctl start docker，或者用 sudo 运行"
}

# 数据库里执行 SQL（从标准输入读）：psql_db [psql 参数…]
# 默认用 postgres 角色（和 Supabase 云上的 SQL Editor 一样）；PSQL_USER=supabase_admin 用超级用户
psql_db() {
  compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U "${PSQL_USER:-postgres}" -d postgres "$@"
}

# 等某个服务变成 healthy（最多 $2 秒）
wait_healthy() {
  local svc=$1 timeout=${2:-180} waited=0 cid status
  while :; do
    cid=$(compose ps -q "$svc" 2>/dev/null || true)
    if [[ -n "$cid" ]]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
      [[ "$status" == healthy || "$status" == running && "$svc" == web ]] && return 0
    fi
    (( waited >= timeout )) && return 1
    sleep 3; waited=$((waited + 3))
  done
}

public_url() { env_get PLING_PUBLIC_URL | sed 's:/*$::'; }
public_domain() { public_url | sed -E 's#^[a-zA-Z]+://##; s#[/:].*$##'; }

data_dir() {
  local d
  d=$(env_get PLING_DATA_DIR)
  d=${d:-../data}
  [[ "$d" == /* ]] || d="$DEPLOY_DIR/$d"
  mkdir -p "$d"
  (cd "$d" && pwd)
}
