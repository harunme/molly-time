# Molly Server (`apps/server/`)

Molly TV 的唯一业务与媒体后台；家庭、儿童、上传、首页与统计在同一应用内按模块实现，不另建业务服务。目标架构见 [architecture.md](architecture.md)。**自研 REST API 在 `/api/*`**，不复用 Jellyfin 协议。
之前的 Jellyfin 兼容层（`ProductName="Jellyfin Server"`、UserDto、SessionInfoDto、Shows/NextUp 等）已全部拆除。

## 设计原则

- **自研协议**：API 字段命名用 camelCase，匹配 Kotlin data class；客户端无需协议映射层
- **自研认证**：HMAC-SHA256 短期 access token（默认 1 小时）+ opaque refresh token（默认 30 天，存哈希）
- **薄媒体能力**：仅 Range 直流 + HTTP Range 解析；不支持转码、不实现 DASH/HLS 主线（当前轻量客户端使用 Media3 直读 MP4/SRT）
- **OSS 尚未接通**：已有存储适配与签名 URL 代码，播放路由尚未实现签名地址跳转；无真实凭证与 CDN 验收

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | – | 账号密码登录，返回 access + refresh token |
| POST | `/api/auth/refresh` | – | 旋转 refresh，颁发新 access + refresh |
| POST | `/api/auth/logout` | – | 撤销传入的 refresh token |
| GET  | `/api/me` | ✓ | 当前 user + family 信息 |
| GET  | `/api/families/me/children` | ✓ | 家庭下儿童列表（P0：可能为空） |
| POST | `/api/children/{id}/select` | ✓ | 校验子档案归属家庭 |
| GET  | `/api/home` | ✓ | 已发布首页；儿童独立配置或跟随家庭配置 |
| GET  | `/api/series/{id}` | ✓ | series 详情 + seasons 列表 |
| GET  | `/api/seasons/{id}` | ✓ | season 详情 + episodes 列表 |
| GET  | `/api/episodes/{id}` | ✓ | episode 详情 + sources（带字幕轨） |
| GET  | `/api/episodes/{id}/play` | ✓ | 本地 MP4 Range 响应；OSS 跳转待实现 |
| GET | `/api/episodes/{id}/progress?childId=` | ✓ | 读取儿童或当前账号的续播位置 |
| POST | `/api/episodes/{id}/progress` | ✓ | 记录播放进度，支持校验后的 childId |
| GET  | `/api/episodes/{id}/subtitles/{i}` | ✓ | SRT/VTT 直发 |
| GET  | `/api/items/{id}/image?w=&h=` | ✓ | 缩略图（默认找父项封面） |

token 通过 `Authorization: Bearer <token>` 或 `?token=` 查询串传入。新版壳子使用设备身份和 Authorization 请求头；管理网页采用同源 HttpOnly Cookie，修改操作校验 CSRF。`tv-shell/2` 登录会返回独立 `deviceId`；`user.id` 仍是账号 ID，设备撤销同时阻止访问和 refresh。

管理接口位于 `/api/manage/*`，包含资源、上传、处理任务、首页配置与历史、观看报表、儿童、设备和设置。播放统计由 `/api/playback/sessions` 和其 `/events` 接收实际播放区间；旧 `/progress` 只用于兼容续播。具体使用、部署及限制见 [管理后台说明](../apps/parent-web/README.md)。

## 当前实现限制

- 本地视频已改为 256 KiB 分块读取，支持 GET/HEAD、开放与后缀区间，拒绝多段/无效 Range。
- 字幕归属、儿童续播、设备撤销、实际播放区间统计、会话去重与补传已接通；自动测试覆盖家庭隔离，华为 TV 实机仍须验收。
- 网页使用同源 `/tv/`，CORS 不开放跨域来源；Vite 开发通过代理访问 API。

## 协议示例

### 登录

```http
POST /api/auth/login
Content-Type: application/json

{"username": "admin", "password": "molly"}
```

```json
{
  "accessToken": "eyJhbGciOi...snZQLiye6Hub0Iro",
  "refreshToken": "stUzUdMF611CykU1RYKRuOdYsKATtP2Pg4c8B-OKqvw",
  "expiresAt": "2026-10-11T11:20:15.876301+00:00",
  "user": {"id": "b23e00c4-...", "name": "admin", "role": "admin", "familyId": "13176a75-..."},
  "family": {"id": "13176a75-...", "name": "Default Family"}
}
```

### 首页

```http
GET /api/home
Authorization: Bearer <accessToken>
```

```json
{
  "rows": [
    {
      "title": "宝宝课堂",
      "items": [
        {"id": "e6122730-...", "name": "L1开口动画", "year": null, "episodeCount": 319, "image": {"url": "/api/items/.../image"}, "sortName": "L1开口动画"},
        ...
      ]
    }
  ]
}
```

### Episode 详情

```json
{
  "id": "616fe830-64c2-4d1c-a2a4-2a6f6a9af82c",
  "seriesId": "e6122730-2c4b-46ab-958a-cf120f5bd14d",
  "seasonId": "260eb07f-d745-485c-ab7b-ca22e09b5a2e",
  "name": "Apple 苹果",
  "indexNumber": null,
  "overview": "",
  "runtimeMs": 309615,
  "image": {"url": "/api/items/616fe830-.../image"},
  "sources": [
    {
      "protocol": "file",
      "container": "mp4",
      "videoCodec": "",
      "audioCodec": "",
      "durationMs": 309615,
      "url": "/api/episodes/616fe830-.../play",
      "subtitles": [
        {"index": 0, "language": "zh-CN+en", "label": "中英字幕.srt", "isDefault": true, "codec": "srt"},
        {"index": 1, "language": "en", "label": "英文字幕.srt", "isDefault": false, "codec": "srt"}
      ]
    }
  ]
}
```

### 播放（Range）

```http
GET /api/episodes/616fe830-.../play?token=<accessToken>
Range: bytes=0-1023

HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/29474013
Accept-Ranges: bytes
Content-Length: 1024
Content-Type: video/mp4

<binary>
```

## 数据模型

```
families           (id, name, created_at)
users              (id, family_id, name, password_hash, role, is_disabled, ...)
refresh_tokens     (id, user_id, issued_at, expires_at, user_agent, client_name, ...)
child_profiles     (id, family_id, name, avatar_path, created_at)
views              (id, family_id, name, collection_type, sort_index)  -- legacy, 不再 API 暴露
items              (id, family_id, view_id, parent_id, type, name, sort_name, overview,
                    index_number, parent_index_number, premiere_year, runtime_ticks, ...)
media_files        (id, family_id, item_id, kind, storage, path, mime, language, index, ...)
playback_events    (id, family_id, user_id, child_id, item_id, position_ms, duration_ms, event, ...)
```

`family_id` 是隔离边界。目录、媒体、管理和统计接口校验家庭归属，儿童选择校验档案归属。附加管理表保存发布状态、上传/处理任务、首页草稿与版本、设备及播放区间；历史 `playback_events` 不会被转换为观看时长。

## 媒体路径

| 路径 | 行为 |
|---|---|
| `storage_backend=local` | LocalStorage 在 `MOLLY_MEDIA_DIR` 下读取上传文件；默认根目录为 `MOLLY_DATA_DIR/media`，范围外路径拒绝 |
| `storage_backend=oss`   | OssStorage 已有签名 URL 方法；播放路由 302 跳转尚未实现，CDN 配置尚未验证 |

P0 默认 local。OSS 接口已经预留但未实际验证（无凭证）。

## TV 网页部署

先执行 `bash tools/build-tv-web.sh` 和 `bash tools/build-parent-web.sh`，再启动后台。构建目录默认分别为 `apps/tv-web/dist` 和 `apps/parent-web/dist`，可用 `MOLLY_TV_WEB_DIR`、`MOLLY_PARENT_WEB_DIR` 指定；启动时挂载 `/tv/`、`/manage/`。HTML 使用 no-store，哈希资源长期缓存。Docker 镜像包含两个网页构建阶段与 FFmpeg。

## 本地运行

```bash
bash tools/build-server.sh           # 创建 .venv
bash tools/init-server.sh            # 建库 + 建 family + 建 admin
bash tools/run-server.sh             # 监听 127.0.0.1:8096
```

默认账号 `admin` / `molly`，家庭名 `Default Family`。

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOLLY_DATA_DIR` | `.local/molly-server` | SQLite + image cache |
| `MOLLY_MEDIA_DIR` | `MOLLY_DATA_DIR/media` | 上传媒体存储根目录 |
| `MOLLY_LISTEN_HOST` | `127.0.0.1` | |
| `MOLLY_LISTEN_PORT` | `8096` | |
| `MOLLY_AUTH_SECRET` | `dev-secret-do-not-use-in-prod` | HMAC 密钥；生产必改 |
| `MOLLY_ACCESS_TOKEN_TTL_SECONDS` | `3600` | |
| `MOLLY_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | |
| `MOLLY_INITIAL_ADMIN_USERNAME` | `admin` | |
| `MOLLY_INITIAL_ADMIN_PASSWORD` | `molly` | |
| `MOLLY_INITIAL_ADMIN_FAMILY_NAME` | `Default Family` | |
| `MOLLY_STORAGE_BACKEND` | `local` | `local` \| `oss` |
| `MOLLY_OSS_*` | – | OSS endpoint / access_key / _oss_cdn_domain |

### 重置（含旧 Jellyfin 数据）

`tools/reset-server.sh` 会删除 `.local/molly-server/` 与 `.local/jellyfin/`（后者是旧 Jellyfin 兼容层留下的状态），然后重新 init。

## 升级与演替

- 轻量客户端 `apps/tv/client/` 与 TV 网页直接使用 Molly `/api/*`，不绑定 Jellyfin 版本
- 网页、API 与原生 Bridge 分别管理兼容性；新增原生能力需要 APK 更新
- 视频统一通过家长后台上传、检查和发布，不提供本地目录扫描导入
- 旧版本本机运行曾将上传文件存放在 `downloads/bbkt/managed`。已有上传文件需将该 `managed` 目录复制到 `MOLLY_DATA_DIR/media/managed`，或通过 `MOLLY_MEDIA_DIR` 指定原存储根目录；Docker 的上传挂载路径保持兼容。修改配置不会自动移动或删除文件。

## 许可

`apps/server/` 源码采用 MIT License。不含 Jellyfin 服务端代码。
