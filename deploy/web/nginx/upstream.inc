# Supabase API 网关。用 Docker 内置 DNS 动态解析（网关容器重建后 IP 变了也能找到），需要 nginx ≥ 1.27.3
resolver 127.0.0.11 valid=10s ipv6=off;

upstream supabase_gw {
  zone supabase_gw 64k;
  server api-gw:8000 resolve;
  keepalive 16;
}

# 实时同步走 WebSocket：有 Upgrade 头就转发 upgrade，没有就不发 Connection 头（保持长连接复用）
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      '';
}
