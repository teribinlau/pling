# 来自 Supabase 官方自托管的文件

这个目录里的文件原样复制自 Supabase 官方仓库的 `docker/` 目录（Apache-2.0 许可）：

- 仓库：https://github.com/supabase/supabase
- 提交：`7353782724d837be316f0f6f87471ed176ab4bfd`（2026-10-03）
- `db/*.sql` ← `docker/volumes/db/`：数据库第一次初始化时执行（设各服务角色的密码、JWT 过期时间、Realtime / Webhooks 需要的 schema）
- `envoy/*` ← `docker/volumes/api/envoy/`：API 网关（Envoy）的配置

**不要改这些文件。** 升级 Supabase 组件时，从官方仓库同一个提交里一起复制新版本，并同步更新 `deploy/docker-compose.yml` 里的镜像版本（官方的 `docker/docker-compose.yml` 里有）。
