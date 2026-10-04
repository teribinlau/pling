#!/usr/bin/env bash
# 叮一下 · 申请 Let's Encrypt 免费证书（之后 certbot 容器每 12 小时检查续期，web 每 12 小时重新加载证书）
# 前提：域名已经解析到这台服务器、80 端口能从外网访问（大陆服务器的域名要先完成 ICP 备案，否则会被拦）
source "$(dirname "$0")/lib.sh"
need_docker

domain=$(public_domain)
email=$(env_get CERTBOT_EMAIL)
[[ -n "$domain" ]] || die ".env 里没有 PLING_PUBLIC_URL"
[[ "$(public_url)" == https://* ]] || die "PLING_PUBLIC_URL 不是 https，不需要证书"

profiles=$(env_get COMPOSE_PROFILES)
[[ ",$profiles," == *,certbot,* ]] || env_set COMPOSE_PROFILES "${profiles:+$profiles,}certbot"

compose up -d web
info "向 Let's Encrypt 申请 $domain 的证书…"
args=(certonly --webroot -w /var/www/certbot -d "$domain" --agree-tos --no-eff-email -n --keep-until-expiring)
if [[ -n "$email" ]]; then args+=(--email "$email"); else args+=(--register-unsafely-without-email); fi
compose run --rm --entrypoint certbot certbot "${args[@]}"

compose up -d certbot
compose restart web
ok "证书已就绪：https://$domain"
