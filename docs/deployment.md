# 服务器部署

当前服务器：`118.89.122.66`。部署目录 `/opt/mollytime`，使用 Docker Compose。

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

首次部署创建独立数据库和随机密码的 `admin` 超管账号。本地数据库、视频和 OSS 凭据不自动迁移。当前使用 Let’s Encrypt 公网 IP 证书，业务入口为 HTTPS 8096；旧 HTTP 链接在同端口跳转至 HTTPS。

服务器使用 `MOLLYTIME_HTTP_BIND=0.0.0.0:8096`，并配置腾讯云依赖镜像源：`MOLLYTIME_APT_MIRROR=mirrors.cloud.tencent.com`、`MOLLYTIME_PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple`。

## 更新

日常更新使用 GitHub Actions：推送到 `main` 会自动运行 [deploy.yml](../.github/workflows/deploy.yml)。也可在仓库 Actions 的 **Deploy MollyTime** 中选择 main 手动运行。工作流先构建两个网页，运行 API、TV、上传及部署回退测试，成功后上传发布包。部署任务串行执行，不会中途取消正在进行的服务更新。

GitHub 仓库 Secrets 已配置 `MOLLYTIME_DEPLOY_KEY` 和 `MOLLYTIME_DEPLOY_KNOWN_HOSTS`。部署密钥使用独立 Ed25519 密钥，服务器通过 SSH forced command 限制为 `check` 和 `deploy <40位提交SHA>`；不能执行普通 shell 命令、转发端口或开启终端。主机公钥固定，CI 不使用动态 `ssh-keyscan` 或关闭主机验证。

服务器的固定接收入口为 `/usr/local/sbin/mollytime-github-deploy` 和 `/usr/local/lib/mollytime-deploy.py`，源码见 `infra/github-deploy-gate.sh` 和 `infra/github-deploy.py`。这些入口脚本变更需通过现有管理 SSH 连接单独安装，不由上传发布包覆盖。

每次发布解压到 `/opt/mollytime/releases/<SHA>-<随机后缀>/`。接收器拒绝越界路径、链接、未知文件和过大的发布包；共享 `.env`、`data/` 与 `tls/` 保留在服务器根部署目录。镜像使用提交 SHA 标记。启动前将 SQLite 在线备份到 `data/backups/`；启动后检查容器健康、可信 HTTPS、管理端和 TV 页面。失败时恢复上一版本的镜像和代理配置，成功后才更新部署状态。

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
