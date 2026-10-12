# MollyTime Server

MollyTime 的唯一业务与媒体后台，采用 FastAPI + SQLAlchemy + SQLite，自有 REST API 位于 `/api/*`，不依赖 Jellyfin 服务端或协议。

当前包含认证、家庭与儿童管理、可撤销 TV 设备、目录与发布状态、本地视频 Range 响应、字幕、封面、分块上传与媒体处理、首页草稿/发布和实际观看时长统计。管理网页入口 `/manage/`，TV 网页入口 `/tv/`。OSS 在线播放尚未接通。

家庭、儿童、上传、首页与统计在本应用内按模块实现，不另建 `services/business-api/`。两个网页与原生壳子共用同一后台。上传处理需要 FFmpeg/FFprobe；观看统计需要新版 APK。使用与限制见 [管理后台说明](../web/README.md)。

## 本地运行

```bash
bash tools/build-server.sh
bash tools/init-server.sh
bash tools/build-tv-web.sh
bash tools/build-web.sh
bash tools/run-server.sh
```

默认监听 `127.0.0.1:8096`。Docker 启动：

```bash
docker compose -f infra/compose.yaml up -d mollytime-server
```

## 目录

- `mollytime_server/api/`：认证、用户、儿童、目录、播放接口。
- `models.py` / `db.py`：SQLAlchemy 模型与数据库。
- `auth.py` / `deps.py`：认证与请求依赖。
- `storage/`：本地与 OSS 存储适配。
- `utils/`：封面处理与 ffprobe。
- `scripts/`：建库与管理员创建。

接口、配置与限制见 [服务端文档](../../docs/server.md)，目标职责见 [架构文档](../../docs/architecture.md)。本目录源码采用 MIT License，不含 Jellyfin 服务端代码。
