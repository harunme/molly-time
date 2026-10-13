# MollyTime Server (`apps/server/`)

MollyTime 的唯一业务与媒体后台；家庭、儿童、上传、首页与统计在同一应用内按模块实现，不另建业务服务。目标架构见 [architecture.md](architecture.md)。**自研 REST API 在 `/api/*`**，不复用 Jellyfin 协议。
之前的 Jellyfin 兼容层（`ProductName="Jellyfin Server"`、UserDto、SessionInfoDto、Shows/NextUp 等）已全部拆除。

## 设计原则

- **自研协议**：API 字段命名用 camelCase，匹配 Kotlin data class；客户端无需协议映射层
- **自研认证**：HMAC-SHA256 短期 access token（默认 1 小时）+ opaque refresh token（默认 30 天，存哈希）
- **薄媒体能力**：仅 Range 直流 + HTTP Range 解析；不支持转码、不实现 DASH/HLS 主线（当前轻量客户端使用 Media3 直读 MP4/SRT）
- **OSS 直传与直播放**：已接入官方 SDK、分片签名上传、播放解析与兼容 302；真实 Bucket 与 TV 验收见 [部署说明](oss-storage.md)

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
| GET  | `/api/episodes/{id}/play` | ✓ | 本地 MP4 Range 响应；OSS 鉴权后 302 跳转 |
| GET | `/api/episodes/{id}/progress?childId=` | ✓ | 读取儿童或当前账号的续播位置 |
| POST | `/api/episodes/{id}/progress` | ✓ | 记录播放进度，支持校验后的 childId |
| GET  | `/api/episodes/{id}/subtitles/{i}` | ✓ | SRT/VTT 直发 |
| GET  | `/api/items/{id}/image?w=&h=` | ✓ | 缩略图（默认找父项封面） |

token 通过 `Authorization: Bearer <token>` 或 `?token=` 查询串传入。新版壳子使用设备身份和 Authorization 请求头；管理网页采用同源 HttpOnly Cookie，修改操作校验 CSRF。`tv-shell/2` 登录会返回独立 `deviceId`；`user.id` 仍是账号 ID，设备撤销同时阻止访问和 refresh。

管理接口位于 `/api/manage/*`，包含资源、上传、处理任务、首页配置与历史、观看报表、儿童、设备和设置。播放统计由 `/api/playback/sessions` 和其 `/events` 接收实际播放区间；旧 `/progress` 只用于兼容续播。具体使用、部署及限制见 [管理后台说明](../apps/web/README.md)。

## 当前实现限制

- 本地视频已改为 256 KiB 分块读取，支持 GET/HEAD、开放与后缀区间，拒绝多段/无效 Range。
- 字幕归属、儿童续播、设备撤销、实际播放区间统计、会话去重与补传已接通；自动测试覆盖家庭隔离，华为 TV 实机仍须验收。
- 网页使用同源 `/tv/`，CORS 不开放跨域来源；Vite 开发通过代理访问 API。

## 协议示例

### 登录

后台和 TV 支持邮箱或十位数字账号 ID 加密码登录，JSON 字段仍为 `username`，兼容客户端协议。邮箱去除首尾空格并统一小写，全系统唯一；数字 ID 由服务端分配并由数据库保证唯一，创建后保持不变。`user.id` 保留内部 UUID，`user.accountId` 是用户可见的数字登录 ID。家庭归属由服务端账号记录决定；旧客户端提交的 `familyId` 会被忽略，不参与登录查询。

服务启动和初始化时自动为旧数据库补充 `users.name` 的唯一索引。若存在同名账号，初始化会列出重名并停止；需先备份数据库、为冲突账号确定不同用户名后重试。迁移不会自动改名、合并账号或更改家庭归属。

账号升级使用新增 `account_identities` 和 `account_invitations` 表，服务启动自动为旧账号补充数字 ID，保留用户 UUID、密码、家庭和设备关联。旧账号在未绑定邮箱时仍可用旧用户名登录；首次进入网页后台须填写实际邮箱并确认当前密码，绑定后只接受邮箱或数字 ID 登录。已配对电视的访问与刷新凭证继续有效。

本版没有无需邀请的注册入口或 `/api/auth/register`。仅超管可在“运营设置 → 用户邀请”生成十二位邀请码，无需预先填写受邀邮箱或家庭名称。邀请码按四位一组显示，生成后在邀请记录中持续显示并支持复制，刷新和重新进入页面后仍可查看。注册校验使用原有哈希，另在附加表 `invitation_codes` 加密保存可查看的码；仅生成者的超管会话能读取。一码一人，默认七天有效，可主动撤销。受邀者在登录页选择“使用邀请码”，先验证邀请码，再自行填写邮箱、家庭名称和密码注册。提交注册时服务端再次核验邀请码，原子地创建独立家庭、家庭管理员和数字账号 ID 并消费邀请码。注册失败不消费邀请码，邮箱全局唯一，禁止客户端指定角色、现有家庭或数字 ID。邀请人被禁用或失去超管权限时，其未使用邀请码失效。

附加表在服务启动时自动创建，旧邀请码只有哈希，无法恢复明文，页面会提示生成新码；其原有有效性和状态不会被迁移改变。邀请码加密复用数据目录中的 `operations-storage.key`，备份或迁移需同时保留该密钥和数据库。缺失密钥或密文损坏的记录不会伪造邀请码，也不影响已有邀请码的哈希校验。

之前已发出的绑定邮箱邀请链接继续有效，仍限制为原定邮箱和家庭，不能更改收件人；新的超管界面只生成邀请码。邀请码接受大小写、分隔短横线和空格的规范化输入，验证和注册接口限制尝试次数。

本版未接入 SMTP 和邮箱验证码，不声称已验证邮箱所有权。超管手动分发邀请码，持码者可注册自己的邮箱；旧账号绑定也需填写本人实际邮箱。本版暂不提供修改邮箱、找回密码和无需邀请的注册。

```http
POST /api/auth/login
Content-Type: application/json

{"username": "parent@example.com", "password": "your-password"}
```

```json
{
  "accessToken": "eyJhbGciOi...snZQLiye6Hub0Iro",
  "refreshToken": "stUzUdMF611CykU1RYKRuOdYsKATtP2Pg4c8B-OKqvw",
  "expiresAt": "2026-10-11T11:20:15.876301+00:00",
  "user": {"id": "b23e00c4-...", "name": "parent", "role": "admin", "familyId": "13176a75-...", "email": "parent@example.com", "accountId": "1234567890"},
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

家庭当前存储、按自然月的下行流量与 OSS 日志导入见 [家庭用量统计](family-usage.md)。家长查看本家庭，平台超管可搜索、导出全部家庭；计量沿用账号的家庭归属。

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
| `storage_backend=local` | LocalStorage 在 `MOLLYTIME_MEDIA_DIR` 下读取上传文件；默认根目录为 `MOLLYTIME_DATA_DIR/media`，范围外路径拒绝 |
| `storage_backend=oss`   | 官方 OSS SDK、浏览器分片直传、签名直播放；CDN 暂不接入 |

默认 local，按文件存储类型路由，支持 local/oss 共存。配置与实体设备验收见 [OSS 与电视缓存](oss-storage.md)。

## TV 网页部署

先执行 `bash tools/build-tv-web.sh` 和 `bash tools/build-web.sh`，再启动后台。构建目录默认分别为 `apps/tv/web/dist` 和 `apps/web/dist`，可用 `MOLLYTIME_TV_WEB_DIR`、`MOLLYTIME_PARENT_WEB_DIR` 指定；启动时挂载 `/tv/`、`/manage/`。HTML 使用 no-store，哈希资源长期缓存。Docker 镜像包含两个网页构建阶段与 FFmpeg。

## 本地运行

```bash
bash tools/build-server.sh           # 创建 .venv
MOLLYTIME_INITIAL_ADMIN_EMAIL=you@example.com bash tools/init-server.sh # 首次创建超管
bash tools/run-server.sh             # 监听 127.0.0.1:8096
```

新建初始账号必须配置 `MOLLYTIME_INITIAL_ADMIN_EMAIL`，通过该邮箱或脚本输出的数字 ID 登录。默认初始密码为 `molly`，家庭名 `Default Family`；生产必须设置独立密码。已有未绑定邮箱的 `admin` 账号可过渡登录并绑定邮箱，重复初始化保留密码。

### 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOLLYTIME_DATA_DIR` | `.local/molly-server` | SQLite + image cache |
| `MOLLYTIME_MEDIA_DIR` | `MOLLYTIME_DATA_DIR/media` | 上传媒体存储根目录 |
| `MOLLYTIME_LISTEN_HOST` | `127.0.0.1` | |
| `MOLLYTIME_LISTEN_PORT` | `8096` | |
| `MOLLYTIME_AUTH_SECRET` | `dev-secret-do-not-use-in-prod` | HMAC 密钥；生产必改 |
| `MOLLYTIME_ACCESS_TOKEN_TTL_SECONDS` | `3600` | |
| `MOLLYTIME_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | |
| `MOLLYTIME_INITIAL_ADMIN_USERNAME` | `admin` | 内部初始化标识、旧账号定位；已绑定后不作为登录方式 |
| `MOLLYTIME_INITIAL_ADMIN_EMAIL` | – | 创建新初始账号必填；已有账号邮箱不会被替换 |
| `MOLLYTIME_INITIAL_ADMIN_PASSWORD` | `molly` | |
| `MOLLYTIME_INITIAL_ADMIN_FAMILY_NAME` | `Default Family` | |
| `MOLLYTIME_STORAGE_BACKEND` | `local` | `local` \| `oss` |
| `MOLLYTIME_OSS_*` | – | OSS endpoint / access_key / _oss_cdn_domain |

### 重置（含旧 Jellyfin 数据）

`tools/reset-server.sh` 会删除 `.local/molly-server/` 与 `.local/jellyfin/`（后者是旧 Jellyfin 兼容层留下的状态），然后重新 init。

## 升级与演替

- 轻量客户端 `apps/tv/client/` 与 TV 网页直接使用 MollyTime `/api/*`，不绑定 Jellyfin 版本
- 网页、API 与原生 Bridge 分别管理兼容性；新增原生能力需要 APK 更新
- 视频统一通过家长后台上传、检查和发布，不提供本地目录扫描导入
- 旧版本本机运行曾将上传文件存放在 `downloads/bbkt/managed`。已有上传文件需将该 `managed` 目录复制到 `MOLLYTIME_DATA_DIR/media/managed`，或通过 `MOLLYTIME_MEDIA_DIR` 指定原存储根目录；Docker 的上传挂载路径保持兼容。修改配置不会自动移动或删除文件。

## 许可

`apps/server/` 源码采用 MIT License。不含 Jellyfin 服务端代码。

## MollyTime 配置兼容

新环境变量前缀为 `MOLLYTIME_`，仍接受旧 `MOLLY_` 前缀，新变量优先。数据目录继续使用 `.local/molly-server/`；保留既有认证和 HTTP 协议标识以支持旧客户端。服务端模块改为 `mollytime_server`，升级本机开发环境时须运行 `bash tools/build-server.sh` 重新安装。

## TV 扫码配对

- `POST /api/auth/pairing/start`：生成十分钟配对请求，返回二维码、短码和设备查询秘密。
- `POST /api/auth/pairing/poll`：仅持有设备查询秘密的 TV 可领取设备凭证；每三秒最多查询一次，丢失响应可安全重试。
- `POST /api/auth/pairing/cancel`：取消尚未完成的请求。
- `POST /api/auth/pairing/reset`：凭签名设备令牌解除自身绑定并使旧凭证立即失效；不接受请求体中的目标设备 ID。
- `GET /api/manage/pairing/{code}`：登录的管理员核对待绑定电视。
- `POST /api/manage/pairing/confirm`：家长管理员在同源页面通过 CSRF 校验后确认家庭归属和设备名。

短码不能领取凭证，也不放进电视播放 URL。确认只允许一次，领取只建立一台设备；查询重试不会新建设备。配对请求十分钟过期后不能再次领取，设备绑定本身没有时间期限。生成与短码查询/确认有数据库限流，并发确认和领取由 SQLite 写锁串行化。新增表 `device_pairings`、`pairing_rates` 为附加表，不修改现有家庭、媒体或观看记录。

`MOLLYTIME_PUBLIC_BASE_URL`（默认空）可指定手机能访问的后台根地址，例如 `https://media.example.com`。未配置时使用后台请求地址生成二维码；使用反向代理、局域网实机或不同前端域名时应明确配置。默认本机监听仍为 `127.0.0.1:8096`。

配对成功后会持久缓存绑定：原生客户端使用私有存储并按后台地址保存，开发网页使用当前站点的本地存储。设备凭证不会因三十天未使用而过期，短期访问令牌自动刷新，网络故障不清除绑定。绑定默认持续保留；TV 设置中的“重新配对”经确认后只解除自身绑定，再生成新二维码。家长网页的“家庭设置 → TV 设备 → 取消配对”仍可远程解除。后台取消后接口立即拒绝访问，TV 在下一次请求、恢复页面或三十秒授权检查时清除本地绑定。家长账号会话仍遵循原有期限。
