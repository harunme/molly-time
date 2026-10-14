# 旧上海服务器部署（历史）

当前生产部署和 GitHub Actions 发布目标已迁至首尔，见 [首尔部署说明](seoul-deployment.md)。本页保留旧上海服务器的回退与维护记录；以下旧版自动部署流程不再是当前流水线。

旧服务器：`118.89.122.66`。部署目录 `/opt/mollytime`，使用 Docker Compose。

- 管理网页：`https://118.89.122.66:8096/manage/`
- TV 网页：`https://118.89.122.66:8096/tv/`
- 健康检查：`https://118.89.122.66:8096/healthz`
- SQLite：`/opt/mollytime/data/server.db`
- 视频与处理文件：`/opt/mollytime/data/media/`
- 环境配置：`/opt/mollytime/.env`（权限 600）
- 公网端口：TCP `8096`（业务）和 TCP `443`（签发及续期验证），云防火墙需持续放行
- TLS 证书：`/opt/mollytime/tls/`；ACME 账户与签发状态：`/opt/mollytime/acme/`
- 初始管理员凭据：`/opt/mollytime/admin-credentials.txt`（权限 600）
- 自动部署状态：`/opt/mollytime/deployment-state.json`（记录当前发布目录和镜像标签）

原始部署创建了独立数据库和随机密码的 `admin` 超管账号。账号版本升级后，该账号仍可用原密码过渡登录，首次进入后台绑定实际邮箱；后续使用邮箱或生成的数字 ID 登录。新部署初始化须配置 `MOLLYTIME_INITIAL_ADMIN_EMAIL` 和独立密码。本地数据库、视频和 OSS 凭据不自动迁移。当前使用 Let’s Encrypt 公网 IP 证书，业务入口为 HTTPS 8096；旧 HTTP 链接在同端口跳转至 HTTPS。

服务器使用 `MOLLYTIME_HTTP_BIND=0.0.0.0:8096`，并配置腾讯云依赖镜像源：`MOLLYTIME_APT_MIRROR=mirrors.cloud.tencent.com`、`MOLLYTIME_PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple`。

## 原自动部署流程（历史）

日常更新使用 GitHub Actions：推送到 `main` 会自动运行 [deploy.yml](../.github/workflows/deploy.yml)。也可在仓库 Actions 的 **Deploy MollyTime** 中选择 main 手动运行。工作流先构建两个网页，运行 API、TV、上传及部署回退测试，成功后上传发布包。部署任务串行执行，不会中途取消正在进行的服务更新。

### 自动判断与发布 TV APK

流水线通过受限 SSH 命令 `apk-state` 读取服务器当前正式包的原生输入指纹与历史最高构建号。对本次 checkout 的原生构建输入计算 SHA-256：只改网页、API、文档或测试时跳过 APK；活跃 Gradle 模块的源码/资源、Gradle 配置和 wrapper、依赖版本、构建辅助代码或 APK 打包脚本变化时构建新包。首次自动发布或当前包没有指纹时保守地出新包。定制 `projectDir` 等无法识别的模块映射会报错，需同步修改指纹规则。

比较基线是当前成功发布的 APK，失败的构建和 API-only 部署不推进原生基线。CI 构建号为 `max(仓库默认构建号, 服务器历史最高构建号) + 1`；显示版本为 `主版本.月份序号.当月发布序号`，不再拼接构建号。`apps/tv/client/version.properties` 的 `versionName` 第一段控制主版本，`versionEpoch=2026-10` 固定月份起点：北京时间 2026 年 10 月为第 1 个月，11 月为第 2 个月，2027 年 1 月为第 4 个月，跨年不重置。CI 使用全部发布历史中同主版本、同月份的最高序号加 1；换月或升级主版本从 1 开始。失败未发布不消耗序号，同月重试沿用序号；跨月重新规划按新月份分配。仅网页/API 更新沿用当前 APK 的完整版本名。旧版 `0.4.0+11` 不计入新规则的发布序号，回滚后的历史新版本仍计入，防止重复。CI 不需要为了每次出包写回 Git；本地直接 Gradle 构建使用配置中的完整默认版本名。SDK/JDK 构建版本维护在 `tools/tv-apk-build.json`。

启用新版本规则前需更新服务器 `/usr/local/lib/mollytime-deploy.py`（源码 `infra/github-deploy.py`），让受限 `apk-state` 同时返回当前 `versionName` 和全部历史 `versionNames`；首尔接收器共用此模块。旧接收器缺少这些字段时 CI 会明确报错，避免重复分配发布序号。固定入口不由普通部署包自动更新。

需要出包时安装 Android SDK/JDK，运行 Android 单元测试、lint 和 release 签名构建，并在构建前后确认原生输入未变化。Actions 保留 APK 与发布计划 30 天。服务端先通过网页/API 健康检查，再核验 APK 签名、版本及 CI 发布计划并更新安装包历史和当前版本；沿用当前正式包的存储方式，首次按运营设置选择服务器或私有 OSS。OSS 密钥保留在服务器，CI 只持有签名密钥。

发布包包含固定路径的 APK 和计划文件，不包含签名私钥。服务端在发布锁内再次校验当前包是否与 CI 规划时相同；规划期间有人手工发布其他 APK 时拒绝覆盖，重新运行工作流即可重新规划。APK 发布失败会恢复应用部署状态并回退服务；未成功发布的包不会成为下次判断基线。手动触发工作流可选择 `force_apk` 强制生成更大的构建号。

首次启用需要安装新版受限接收入口并配置签名 Secrets。保留现有 `MOLLYTIME_DEPLOY_KEY` / `MOLLYTIME_DEPLOY_KNOWN_HOSTS`，新增：

- `MOLLYTIME_TV_KEYSTORE_BASE64`：原正式签名密钥库的 Base64 内容。
- `MOLLYTIME_TV_STORE_PASSWORD`、`MOLLYTIME_TV_KEY_PASSWORD`：原密钥库/密钥密码。
- `MOLLYTIME_TV_KEY_ALIAS`：原别名（默认 `mollytime`）。

本地已有 `.local/signing/release.properties` 和原正式密钥时，可以运行 `python3 tools/setup_tv_ci.py` 完成一次性配置。该脚本通过 stdin 写入 GitHub Secrets，不输出密码；仅把两个部署入口脚本发送到服务器，保留 `.pre-tv-ci` 备份并使用严格主机校验，不重启业务服务。已有完整签名 Secrets 时不覆盖，配置不完整时拒绝混用凭据。首次安装入口需使用管理 SSH 密钥 `MollyTime_SSH.pem`，后续工作流仍使用受限部署密钥。

CI 签名文件只写入 runner 临时目录，权限 600，任务结束时清理。生产镜像包含 `aapt`、`apksigner` 和 Java，也支持运营后台的 APK 上传校验；Nginx 对 APK 上传接口单独允许 512 MiB，其他接口保持原限制。

GitHub 仓库 Secrets 已配置 `MOLLYTIME_DEPLOY_KEY` 和 `MOLLYTIME_DEPLOY_KNOWN_HOSTS`。部署密钥使用独立 Ed25519 密钥，服务器通过 SSH forced command 限制为 `check`、只读的 `apk-state` 和 `deploy <40位提交SHA>`；不能执行普通 shell 命令、转发端口或开启终端。主机公钥固定，CI 不使用动态 `ssh-keyscan` 或关闭主机验证。

服务器的固定接收入口为 `/usr/local/sbin/mollytime-github-deploy` 和 `/usr/local/lib/mollytime-deploy.py`，源码见 `infra/github-deploy-gate.sh` 和 `infra/github-deploy.py`。这些入口脚本变更需通过现有管理 SSH 连接单独安装，不由上传发布包覆盖。已有签名 Secrets 时，使用 `python3 tools/setup_tv_ci.py --receiver-only` 只更新接收入口；TV 更新说明通过 UTF-8 文件传入发布容器，兼容服务器 Python 3.6 的 ASCII 环境。

每次发布解压到 `/opt/mollytime/releases/<SHA>-<随机后缀>/`。接收器拒绝越界路径、链接、未知文件和过大的发布包；共享 `.env`、`data/` 与 `tls/` 保留在服务器根部署目录。镜像使用提交 SHA 标记。启动前将 SQLite 在线备份到 `data/backups/`；启动后检查容器健康、可信 HTTPS、管理端和 TV 页面。失败时恢复上一版本的镜像和代理配置，成功后才更新部署状态。

邮箱账号与邀请表在 API 启动时自动创建，旧账号数字 ID 自动补齐且不会重复分配。用户 UUID、密码、家庭、配对设备和观看记录不变。邮箱不会编造或从部署配置强制覆盖，旧账号由用户首次登录后绑定。后台和 API 必须一起更新。发布失败只回退应用，数据库备份不自动还原。

回退恢复应用代码，不自动恢复数据库；涉及不兼容数据库迁移时，需要根据发布前备份人工处理。发布目录、旧镜像和备份默认保留，可按磁盘容量定期清理。首次需要把工作流文件推送到 main 才会触发，未提交的本地改动不会自动部署。

### 手动维护

自动部署启用后，运行中的代码位于部署状态文件记录的发布目录。下面的首次部署方式用于手动初始化；日常更新优先使用 Actions，避免覆盖当前发布目录或与自动部署同时运行。

先在本机运行：

```bash
pnpm --dir apps/web build
pnpm --dir apps/tv/web build
```

上传 `apps/server/pyproject.toml`、`apps/server/mollytime_server/`、两个网页的 `dist/` 和 `infra/Dockerfile.prebuilt`、`infra/compose.production.yaml`、`infra/compose.tls.yaml`、`infra/nginx-tls.conf`，保留服务器 `.env`、`data/`、`acme/` 和 `tls/`。不要上传 SSH 私钥、开发数据库或 `node_modules`。

在服务器执行，使用新的发布标签：

```bash
cd /opt/mollytime
MOLLYTIME_RELEASE=<新标签> docker compose --env-file .env -f infra/compose.production.yaml -f infra/compose.tls.yaml build
MOLLYTIME_RELEASE=<新标签> docker compose --env-file .env -f infra/compose.production.yaml -f infra/compose.tls.yaml up -d
```

验证成功后，将 `.env` 内的 `MOLLYTIME_RELEASE` 更新为该标签。镜像包含构建好的网页、Python API 和 FFmpeg；容器自动重启，日志轮转，数据库和上传文件保存在宿主机。

## 检查与维护

```bash
cd /opt/mollytime
docker compose --env-file .env -f infra/compose.production.yaml -f infra/compose.tls.yaml ps
docker compose --env-file .env -f infra/compose.production.yaml -f infra/compose.tls.yaml logs --tail 100
curl -f https://118.89.122.66:8096/healthz
```

数据库备份使用 SQLite 在线备份 API，或停止容器后备份整个 `data/` 目录；运行时不要只复制 `server.db` 而遗漏 WAL。回滚使用保留的旧镜像标签，启动前检查数据库迁移兼容性。

## 证书续期

Let’s Encrypt IP 证书的有效期约 6 天。使用 `shortlived` profile，acme.sh 提前续期，systemd timer 每天检查两次，随机延迟最多 15 分钟；续期完成后验证并平滑重载 Nginx。443 仅在 TLS-ALPN 验证时监听，业务使用 8096，后端只可通过 Docker 内网访问。

```bash
systemctl status mollytime-tls-renew.timer
systemctl list-timers mollytime-tls-renew.timer
journalctl -u mollytime-tls-renew.service --no-pager -n 50
systemctl start mollytime-tls-renew.service
```

续期脚本为 `/opt/mollytime/infra/renew-tls.sh`，单次执行有文件锁，避免重复签发。证书私钥权限 600，证书目录权限 700。证书工具和 Nginx 镜像摘要固定在 `.env`；无需在容器中暴露 Docker socket。保持 TCP 443 可从公网访问，以供后续自动续期。

官方参考：[Let’s Encrypt IP 证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/)、[acme.sh profile 与续期](https://github.com/acmesh-official/acme.sh/wiki/Profile-selection)。
