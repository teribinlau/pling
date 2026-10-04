# 叮一下 · 网页和 API 的公共配置（http.conf / https.conf 都 include 这个文件）

root /var/run/pling/html;
index index.html;
charset utf-8;

# 上传文件最大 20 MB（Storage 桶的限制），留一点余量
client_max_body_size 25m;

include /etc/pling/nginx/headers.inc;

proxy_read_timeout 180s;
proxy_send_timeout 180s;

gzip on;
gzip_types text/css application/javascript application/json image/svg+xml application/manifest+json;
gzip_min_length 1024;

# ---------------------------------------------------------------------------
# Supabase 接口：只转发应用用到的五个服务，其余（数据库元数据、Studio……）不对外
# 去掉 /api 前缀交给网关；X-Real-IP 给登录服务按真实 IP 限流（覆盖客户端自己带的值）
# ---------------------------------------------------------------------------
location /api/auth/v1/      { proxy_pass http://supabase_gw/auth/v1/;      include /etc/pling/nginx/proxy.inc; }
location /api/rest/v1/      { proxy_pass http://supabase_gw/rest/v1/;      include /etc/pling/nginx/proxy.inc; }
location /api/storage/v1/   { proxy_pass http://supabase_gw/storage/v1/;   include /etc/pling/nginx/proxy.inc; }
location /api/functions/v1/ { proxy_pass http://supabase_gw/functions/v1/; include /etc/pling/nginx/proxy.inc; }
location /api/realtime/v1/ {
  proxy_pass http://supabase_gw/realtime/v1/;
  include /etc/pling/nginx/proxy.inc;
  # 实时同步是长连接
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
}
location /api/ { return 404; }

# 运行时配置：每次都取最新的
location = /config.json {
  include /etc/pling/nginx/headers.inc;
  add_header Cache-Control "no-store" always;
  add_header Access-Control-Allow-Origin "*" always;
  default_type application/json;
  try_files /config.json =404;
}

# 桌面版安装包和自动更新清单
location /downloads/ {
  alias /usr/share/nginx/downloads/;
  autoindex off;
  include /etc/pling/nginx/headers.inc;
  add_header Cache-Control "no-cache" always;
  add_header Access-Control-Allow-Origin "*" always;
}

# PWA：入口和 service worker 不能缓存，不然手机上一直是旧版本
location = /index.html { include /etc/pling/nginx/headers.inc; add_header Cache-Control "no-cache" always; }
location = /sw.js { include /etc/pling/nginx/headers.inc; add_header Cache-Control "no-cache" always; }
location ~ ^/workbox-[^/]+\.js$ { include /etc/pling/nginx/headers.inc; add_header Cache-Control "no-cache" always; }
location = /manifest.webmanifest { include /etc/pling/nginx/headers.inc; default_type application/manifest+json; add_header Cache-Control "no-cache" always; }

# 构建产物带哈希，可以长期缓存
location /assets/ {
  include /etc/pling/nginx/headers.inc;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  try_files $uri =404;
}

# 单页应用：找不到的路径都回到 index.html
location / {
  try_files $uri $uri/ /index.html;
}
