#!/usr/bin/env bash
# 叮一下 · 一键安装（也可以重复运行：已有的配置和密钥不会被换掉）
#
#   sudo deploy/scripts/install.sh
#   sudo deploy/scripts/install.sh --url https://pling.example.cn --org "某某中学" --cert letsencrypt --email it@example.cn
#
# 参数（不给就会问）：
#   --url URL        网页地址，必须是 https://域名（内网试用可以 http://IP）
#   --org NAME       机构名，显示在登录页
#   --cert MODE      证书：letsencrypt（自动申请免费证书）| files（自己放证书文件）| none（先不用 HTTPS）
#   --email EMAIL    申请 Let's Encrypt 证书用的联系邮箱
#   --yes            不再询问，缺的用默认值
source "$(dirname "$0")/lib.sh"

URL= ORG= CERT= EMAIL= YES=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL=$2; shift ;;
    --org) ORG=$2; shift ;;
    --cert) CERT=$2; shift ;;
    --email) EMAIL=$2; shift ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "不认识的参数：$1（--help 看用法）" ;;
  esac
  shift
done

ask() { # ask 变量名 提示 默认值
  local __var=$1 prompt=$2 def=${3:-} ans
  if [[ -n "$YES" || ! -t 0 ]]; then printf -v "$__var" '%s' "$def"; return; fi
  read -r -p "$prompt${def:+ [$def]}: " ans
  printf -v "$__var" '%s' "${ans:-$def}"
}

step "检查环境"
need_docker
command -v openssl >/dev/null || die "没有找到 openssl"
[[ -f "$ROOT_DIR/web/index.html" || -n "$(env_get PLING_WEB_DIR)" ]] \
  || warn "没有找到网页文件（$ROOT_DIR/web/index.html）。用发布的安装包（pling-server-版本.tar.gz）安装，或者在 .env 里设 PLING_WEB_DIR"
ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)，$(docker compose version --short 2>/dev/null)"

step "基本配置（deploy/.env）"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "已从 .env.example 生成 .env"
fi

cur_url=$(public_url)
if [[ -z "$URL" ]]; then ask URL "网页地址（如 https://pling.example.cn）" "${cur_url}"; fi
URL=${URL%/}
[[ "$URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "网页地址格式不对：$URL（要 https://域名，结尾不要路径）"
[[ "$URL" == https://* ]] || warn "用的是 http：微信 / QQ 登录、手机添加到主屏幕、电脑客户端都要求 https，只适合内网试用"
env_set PLING_PUBLIC_URL "$URL"

cur_org=$(env_get PLING_ORG_NAME)
if [[ -z "$ORG" ]]; then ask ORG "机构名（显示在登录页，如 某某中学）" "${cur_org}"; fi
[[ -n "$ORG" ]] && env_set PLING_ORG_NAME "$ORG"

step "生成密钥（已有的不变）"
env_default POSTGRES_PASSWORD "$(rand_hex 16)"
env_default JWT_SECRET "$(rand_hex 32)"
jwt=$(env_get JWT_SECRET)
iat=$(date +%s); exp=$((iat + 10 * 365 * 24 * 3600))
if [[ -z "$(env_get ANON_KEY)" || -z "$(env_get SERVICE_ROLE_KEY)" ]]; then
  env_set ANON_KEY "$(jwt_hs256 "$jwt" "{\"role\":\"anon\",\"iss\":\"supabase\",\"iat\":$iat,\"exp\":$exp}")"
  env_set SERVICE_ROLE_KEY "$(jwt_hs256 "$jwt" "{\"role\":\"service_role\",\"iss\":\"supabase\",\"iat\":$iat,\"exp\":$exp}")"
fi
env_default SECRET_KEY_BASE "$(rand_hex 32)"
env_default REALTIME_DB_ENC_KEY "$(rand_hex 8)"
env_default PG_META_CRYPTO_KEY "$(rand_hex 16)"
env_default S3_PROTOCOL_ACCESS_KEY_ID "$(rand_hex 16)"
env_default S3_PROTOCOL_ACCESS_KEY_SECRET "$(rand_hex 32)"
env_default DASHBOARD_PASSWORD "$(rand_hex 16)"
env_default PLING_CRON_SECRET "$(rand_hex 24)"
ok "密钥都在 deploy/.env 里（只有 root 能读），请连同数据一起备份"

DATA=$(data_dir)
mkdir -p "$DATA"/{db,storage,certs,downloads,web-extra,backups,studio-snippets}
ok "数据目录：$DATA"

if [[ -z "$(env_get SMTP_HOST)" && -z "$(env_get WECHAT_OPEN_APPID)" && -z "$(env_get WECHAT_MP_APPID)" && -z "$(env_get QQ_APPID)" ]]; then
  warn "还没有配置任何登录方式（邮箱 SMTP / 微信 / QQ）。至少配好邮箱，第一个管理员才能登录：编辑 deploy/.env 的 SMTP_* 后再运行一次本脚本"
fi

step "证书"
if [[ "$URL" == https://* ]]; then
  if [[ -z "$CERT" ]]; then
    if [[ -s "$DATA/certs/fullchain.pem" ]]; then CERT=files
    else ask CERT "证书：letsencrypt（自动申请）/ files（自己放证书文件）/ none（先不用）" letsencrypt
    fi
  fi
  case "$CERT" in
    letsencrypt)
      [[ -n "$EMAIL" ]] || EMAIL=$(env_get CERTBOT_EMAIL)
      [[ -n "$EMAIL" ]] || ask EMAIL "申请证书用的联系邮箱" ""
      [[ -n "$EMAIL" ]] && env_set CERTBOT_EMAIL "$EMAIL"
      profiles=$(env_get COMPOSE_PROFILES)
      [[ ",$profiles," == *,certbot,* ]] || env_set COMPOSE_PROFILES "${profiles:+$profiles,}certbot"
      ;;
    files)
      [[ -s "$DATA/certs/fullchain.pem" && -s "$DATA/certs/privkey.pem" ]] \
        || warn "请把证书放到 $DATA/certs/fullchain.pem（含中间证书）和 privkey.pem，然后 docker compose restart web"
      ;;
    none) env_set PLING_TLS off ;;
    *) die "--cert 只能是 letsencrypt / files / none" ;;
  esac
else
  env_set PLING_TLS off
fi

step "拉取镜像（第一次比较久；国内服务器先按部署指南配好镜像加速）"
if ! compose pull --quiet; then
  die "拉镜像失败。国内服务器请先配置镜像加速（部署指南「拉镜像慢 / 失败」），或在 .env 里设 PLING_REGISTRY"
fi

step "启动"
compose up -d --remove-orphans
"$DEPLOY_DIR/scripts/migrate.sh"
compose up -d
wait_healthy functions 120 || warn "云函数服务还没就绪：docker compose logs functions"

if [[ "$CERT" == letsencrypt ]]; then
  step "申请证书"
  "$DEPLOY_DIR/scripts/cert.sh" || warn "证书申请失败，网站暂时只有 http。确认域名已解析到本机、80 端口能从外网访问后，运行 deploy/scripts/cert.sh"
fi

step "检查"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $(public_domain)" "http://127.0.0.1:$(env_get PLING_HTTP_PORT | sed 's/^$/80/')/config.json" || true)
[[ "$code" == 200 || "$code" == 301 ]] && ok "网页服务正常" || warn "本机访问 /config.json 返回 $code：docker compose logs web"

cat <<EOF

${C_GRN}安装完成。${C_OFF}

  网页地址：$URL
  第一个登录的人自动成为管理员：现在就用浏览器打开上面的地址登录。
  其他人登录后是「待激活」，管理员在「设置 → 成员」里激活，或者发邀请码让他们自己加入。

下一步（详见 docs/部署指南.md）：
  · 微信 / QQ 登录、服务号推送：把申请到的 AppID 等填进 deploy/.env，再运行一次 scripts/install.sh
  · 电脑客户端：scripts/update-desktop.sh 把安装包放到 $URL/downloads/
  · 备份：scripts/backup.sh（建议加到每天的定时任务）
EOF
