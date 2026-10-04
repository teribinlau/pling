# 叮一下 · Pling

给学校、公司小团队用的共享提醒。老师 / 负责人发一条提醒，指派给班级、部门或个人，到点在电脑、手机和微信里「叮」一下；需要交材料的，系统收齐、统计、批改。

**每家机构单独部署一套**，装在机构自己的国内服务器上（Docker），数据不出机构。

## 功能

- **提醒**：一次性 / 每天 / 每个工作日 / 每周 / 每月，跳过法定节假日（调休上班的日子照常）；提前提醒、到点、逾期再催；指派给人、班级 / 部门或全体
- **日历和看板**：按天看、按状态看；讨论的截止日期也在日历上
- **交文件 / 作业统计**：需要回传文件的提醒，自动统计应交 / 已交（按时、迟交）/ 未交，老师可以「通过」或「退回重交」并写批语，导出名单（Excel 能直接打开）
- **已读回执**：发起人看得到谁看过、谁还没看
- **附件和链接**：提醒可以挂照片、PDF、表格和在线表单链接
- **讨论**：发起讨论、带附件留言，发起人结束时可以写结论
- **登录**：微信扫码（电脑）、微信内一键登录、QQ、邮箱验证码；邀请码一键入组
- **推送**：微信服务号消息（扫码绑定）、企业微信 / 钉钉 / 飞书群机器人；免打扰时段
- **客户端**：网页版（手机可「添加到主屏幕」）+ 电脑客户端（Windows 64 / 32 位、macOS，托盘、置顶提醒小窗、开机自启、从机构自己的服务器自动更新）
- **机构设置**：机构名、称呼（班级 / 部门 / 小组，全校 / 全公司……）、时区、节假日维护；共用设备模式（机房、前台的公用电脑，完成时选名字）；四套皮肤

## 结构

```
src/                React + TypeScript 前端（网页和电脑客户端共用）
  lib/              数据层（Supabase / 演示模式）、运行时配置、重复规则展开、节假日、本地提醒、登录、作业统计
  components/ views/ 界面
src-tauri/          电脑客户端外壳（Tauri 2）
supabase/
  migrations/       数据库结构和行级权限（按文件名顺序执行，每个文件都能重复执行）
  functions/        云函数（Deno）：微信 / QQ 登录、服务号、推送；_shared/core 是从 src/lib 同步过来的提醒展开逻辑
deploy/             自托管部署：docker-compose.yml、nginx、一键安装 / 迁移 / 证书 / 升级 / 备份 / 恢复脚本
docs/               架构.md（各部分的约定）、部署指南.md、申请指南.md（微信 / QQ / 群机器人）
scripts/            本机测试库、同步展开逻辑、打服务器安装包
tests/              单元测试（vitest）、界面测试（Playwright）、云函数测试（Deno）
```

前端和云函数怎么对接、数据库有哪些表、云函数的接口，都在 [docs/架构.md](docs/架构.md)。

## 本机开发

需要 Node 22。

```bash
npm install
npm run dev            # http://localhost:1420
```

没有配置服务器时是**演示模式**：内置「示例大学 · 计算机学院」的数据，不连服务器，能看到全部界面（管理员 / 学生 / 共用设备三种身份）。

要连一台已经部署好的服务器：复制 `.env.example` 为 `.env`，填上 `VITE_SUPABASE_URL=https://域名/api` 和 anon key（在服务器的 `/config.json` 里能看到）。

电脑客户端：`npm run tauri dev`（要装 Rust 和 Tauri 的系统依赖）。

### 测试

```bash
npm run test:unit                      # 前端单元测试
npm run test:ui                        # 界面测试（演示模式；需要 Playwright 浏览器）
scripts/dev-db/up.sh --db pling_db_test       # 本机测试库：模拟 Supabase 的角色和 schema，跑完全部迁移
npm run test:db                        # 数据库权限测试（谁能看、谁能改，每张表都测）
scripts/dev-db/up.sh --db pling_auth_test
scripts/dev-db/up.sh --db pling_notify_test
deno test -A --config supabase/functions/deno.json tests/functions/   # 云函数测试（真的数据库 + 假的微信 / QQ / GoTrue）
```

改了 `src/lib/{types,holidays,recurrence,occurrences}.ts` 以后运行 `npm run sync:core`，把展开逻辑同步给云函数（CI 会检查两边一致）。

## 部署

见 [docs/部署指南.md](docs/部署指南.md)。简单说：服务器装好 Docker，解开 `pling-server-<版本>.tar.gz`，运行 `deploy/scripts/install.sh`。
微信 / QQ / 群机器人怎么申请见 [docs/申请指南.md](docs/申请指南.md)。

## 发版

1. 改版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（还有 `src-tauri/Cargo.lock` 里 `pling` 那一项）
2. 提交、推到 `main`，等 CI 绿
3. 打标签并推送：`git tag v0.2.0 && git push origin v0.2.0`。打之前先 `git log -1` 确认标签打在想要的提交上
4. GitHub Actions 会构建：
   - 电脑客户端：Windows 64 / 32 位、macOS 通用包
   - 自动更新清单：`latest.json`（三个平台都齐才算成功）
   - 服务器安装包：`pling-server-<版本>.tar.gz` 和 `.sha256`
5. 通知各机构：服务器运行 `deploy/scripts/update.sh 0.2.0`，客户端运行 `deploy/scripts/update-desktop.sh 0.2.0`

自动更新的签名私钥在仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY`），公钥在 `tauri.conf.json`。**私钥丢了，已经装好的客户端就再也收不到更新**，务必另外备份。

## 来历

从「DZF 提醒」v0.6.2（一个仓库团队内部用的提醒应用）分出来，改成通用版：

- 去掉：Notion 同步、承运商模板、德语界面
- 新增：多种登录方式、服务端推送、已读回执、作业统计、邀请码、机构设置、国内节假日
- 部署：从 Supabase 云 + Vercel 改成每家自托管
