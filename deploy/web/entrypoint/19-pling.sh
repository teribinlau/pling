#!/bin/sh
# 叮一下 · web 容器启动脚本（nginx 官方镜像会在启动 nginx 之前执行 /docker-entrypoint.d/ 里的脚本）
#   1. 把网页复制到可写目录 /var/run/pling/html，放进 config.json、根目录验证文件、<head> 里额外的内容
#   2. 有证书就开 HTTPS（80 跳 443），没有就先只开 HTTP（申请证书、内网试用）
#   3. HTTPS 模式下每 12 小时 reload 一次，续期后的证书自动生效
set -eu

ME=19-pling
SRC=/usr/share/nginx/html-src
ROOT=/var/run/pling/html
CONF=/etc/nginx/conf.d/default.conf

log() { echo "$ME: $*"; }

PUBLIC_URL=$(printf '%s' "${PLING_PUBLIC_URL:-}" | sed 's:/*$::')
if [ -z "$PUBLIC_URL" ]; then
  log "PLING_PUBLIC_URL 没有设置（deploy/.env），网页拿不到服务器配置"
fi
DOMAIN=$(printf '%s' "$PUBLIC_URL" | sed -E 's#^[a-zA-Z]+://##; s#[/:].*$##')

# ---------------------------------------------------------------------------
# 1. 网页
# ---------------------------------------------------------------------------
rm -rf "$ROOT"
mkdir -p "$ROOT"
if [ -f "$SRC/index.html" ]; then
  cp -a "$SRC/." "$ROOT/"
else
  log "没找到网页文件（$SRC/index.html）：检查 PLING_WEB_DIR / 安装包里的 web 目录"
  printf '<!doctype html><meta charset="utf-8"><title>叮一下</title><p>网页文件缺失，请联系管理员。</p>\n' > "$ROOT/index.html"
fi

# 放在网站根目录的验证文件（服务号的 MP_verify_xxx.txt 等）：只复制第一层的普通文件
if [ -d /usr/share/nginx/web-extra ]; then
  for f in /usr/share/nginx/web-extra/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    case "$name" in
      index.html|config.json|sw.js|*.webmanifest) log "跳过 web-extra/$name（不能覆盖应用自己的文件）" ;;
      *) cp "$f" "$ROOT/$name" ;;
    esac
  done
fi

# JSON 字符串转义：反斜杠、双引号；去掉控制字符
json_str() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
flag() { [ -n "${1:-}" ] && echo true || echo false; }

EMAIL=false
case "${PLING_EMAIL_LOGIN:-auto}" in
  off|false|0) EMAIL=false ;;
  on|true|1) EMAIL=true ;;
  *) EMAIL=$(flag "${PLING_HAS_EMAIL:-}") ;;
esac

cat > "$ROOT/config.json" <<EOF
{
  "supabaseUrl": "$(json_str "$PUBLIC_URL")/api",
  "supabaseAnonKey": "$(json_str "${PLING_ANON_KEY:-}")",
  "publicUrl": "$(json_str "$PUBLIC_URL")",
  "orgName": "$(json_str "${PLING_ORG_NAME:-}")",
  "logins": {
    "email": $EMAIL,
    "wechat": $(flag "${PLING_HAS_WECHAT_OPEN:-}"),
    "wechatMp": $(flag "${PLING_HAS_WECHAT_MP:-}"),
    "qq": $(flag "${PLING_HAS_QQ:-}")
  },
  "notify": { "wechatMp": $(flag "${PLING_HAS_WECHAT_MP_NOTIFY:-}") },
  "updatesUrl": "$(json_str "$PUBLIC_URL")/downloads/latest.json"
}
EOF

# 额外插进 <head> 的内容（比如 QQ 互联验证网站用的 meta），原样插在 </head> 前面
if [ -n "${PLING_HEAD_HTML:-}" ] && [ -f "$ROOT/index.html" ]; then
  # 不用 sub()：替换串里的 & 和 \ 在 awk 里有特殊含义（meta 里常有 &）
  awk 'BEGIN { extra = ENVIRON["PLING_HEAD_HTML"]; done = 0 }
       !done && (i = index($0, "</head>")) > 0 { print substr($0, 1, i - 1) extra; print substr($0, i); done = 1; next }
       { print }' "$ROOT/index.html" > "$ROOT/index.html.tmp" && mv "$ROOT/index.html.tmp" "$ROOT/index.html"
  log "已把 PLING_HEAD_HTML 插进 index.html"
fi

# ---------------------------------------------------------------------------
# 2. HTTP / HTTPS
# ---------------------------------------------------------------------------
CERT=${PLING_SSL_CERT:-/etc/pling/certs/fullchain.pem}
KEY=${PLING_SSL_KEY:-/etc/pling/certs/privkey.pem}
if [ ! -s "$CERT" ] && [ -n "$DOMAIN" ] && [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
  KEY=/etc/letsencrypt/live/$DOMAIN/privkey.pem
fi

MODE=http
case "${PLING_TLS:-auto}" in
  off|false|0) MODE=http ;;
  *)
    if [ -s "$CERT" ] && [ -s "$KEY" ]; then
      MODE=https
    else
      log "没有证书（$CERT），先只开 HTTP。申请证书：在服务器上运行 deploy/scripts/cert.sh；或者把证书放到 data/certs/fullchain.pem 和 privkey.pem 再重启 web"
    fi
    ;;
esac

if [ "$MODE" = https ]; then
  sed -e "s#@CERT@#$CERT#g" -e "s#@KEY@#$KEY#g" /etc/pling/nginx/https.conf > "$CONF"
  log "HTTPS 已开启（证书 $CERT）"
  # 证书续期后要 reload 才生效；nginx 是 1 号进程，这个循环会一直跟着它
  (while :; do sleep 43200; nginx -s reload >/dev/null 2>&1 || true; done) >/dev/null 2>&1 &
else
  cp /etc/pling/nginx/http.conf "$CONF"
fi
