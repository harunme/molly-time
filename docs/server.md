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

配对成功后会持久缓存绑定：原生客户端使用私有存储并按后台地址保存，开发网页使用当前站点的本地存储。设备凭证不会因三十天未使用而过期，短期访问令牌自动刷新，网络故障不清除绑定。绑定默认持续保留；TV 设置中的“重新配对”经确认后只解除自身绑定，再生成新二维码。家长网页的“我的电视 → 更多操作 → 取消配对”仍可远程解除。后台取消后接口立即拒绝访问，TV 在下一次请求、恢复页面或三十秒授权检查时清除本地绑定。家长账号会话仍遵循原有期限。

### 平台使用概览与 APK 激活采集

超管进入「运营设置」默认打开「使用概览」。`GET /api/manage/operations/analytics/{overview,daily,families,devices,versions}` 分别返回核心指标、每日趋势、分页家庭、分页设备和近 30 天版本分布。`daily` 支持 `days=7|30|90`；家庭支持 `q` 名称搜索；设备必须提供 `familyId`；分页使用 `page` / `pageSize`（默认 20、最多 100）。普通家长和设备凭证无权读取平台统计。

全部自然日使用 `Asia/Shanghai`。在线设备沿用未撤销且 90 秒内有效通信的定义。访问设备按每日已认证设备去重；观看家庭按实际播放区间去重，包含直播，点播与直播时长分列，排除家长预览。原有家庭观看报表仍排除直播。跨日播放按实际区间拆分，离线事件补传可能更新历史观看数。

服务端启动时以新增表方式登记安装、安装每日访问、设备每日访问，并写入 `operations-analytics-v1` 采集起点。已有播放记录可用于历史统计，已有 `last_seen` 不能恢复历史每日访问。采集起点以前的新激活和访问设备返回 `null`，页面显示「未采集」，起点当天为部分日数据。

正式版原生 APK 使用 `POST /api/client/telemetry` 上报 `installationId`、`installationToken`、`version`、`channel=release`。首次请求前，本地持久保存 UUID 和每服务端独立的 256 位随机安装秘密；服务端保存其 SHA-256，并返回确认的安装凭证。此设计保证首次响应丢失后可安全重试，不允许仅凭 UUID 重新领取凭证。匿名请求只登记安装；有设备 Bearer 凭证时，服务端校验账号与设备后确定家庭归属，不接受客户端传入家庭或设备 ID。登记按来源限流，后续上报按安装限流。浏览器不发送，调试版不计入。

上报在应用前台每 60 秒进行，后台停止；失败退避为 10、20、40、80、160 秒（上限 300 秒），不阻塞启动或播放。升级、解绑和重新配对保留安装 ID；清除数据或重装可能产生新 ID。安装量指服务端首次观测到的安装，已有安装升级后也会首次计入，不等同于下载量、真实新增设备或人数。匿名激活是客户端自报指标，并非硬件证明；不采集设备指纹，不推断卸载。

部署顺序：先更新 API 和管理端，再发布包含采集的新 APK。旧 APK 的认证心跳继续贡献设备访问与在线统计，未采集版本显示「未知」。无需补造历史安装。发布前仍需完成 Android WebView、Bridge、配对和原生点播／直播验证。

## 观看统计汇总与历史回填

`/api/manage/overview` 从按家庭、日期、内容和会话维护的汇总表读取观看统计，
不再逐次加载全部 `watch_intervals`。播放区间与汇总在同一事务提交；贡献表按
`(generation, interval_id)` 去重，重复上报、乱序上报和事务回滚不会重复计数。
当天和每周按家庭时区切分，仍保留暂停、家长预览和直播的排除规则。

首次升级会为有历史记录的家庭排队回填，每批默认 200 条，断点可恢复。
后台任务默认开启（`MOLLYTIME_WATCH_ROLLUP_WORKER_ENABLED=true`），独立于媒体转码任务，
逐家庭轮转处理。首次没有可用汇总时，概览返回 HTTP 503 和 `Retry-After: 2`，
不会用零值代替未准备好的统计，也不会在读请求里重算历史。
iOS 设备列表独立加载，统计准备期间静默重试，保留最后成功的统计。

上线时建议先在同一数据库、同一服务端配置下运行：

```sh
apps/server/.venv/bin/python tools/rebuild-watch-statistics.py
```

完成后再让新版服务接流量。回填结束会核对贡献数量、总观看时长和会话次数，
校验失败不切换版本。修改家庭时区时，在新版本准备好之前继续返回旧版本及其
实际 `timezone`，并标记 `summaryUpdating: true`；iOS 会在后台等待新版本。
期间新增上报会同时写入当前版本和正在回填的版本。

若通过 SQL 或批量导入绕过 ORM 修改原始观看记录，必须显式排队重建：

```sh
apps/server/.venv/bin/python tools/rebuild-watch-statistics.py --rebuild-family FAMILY_ID
```

原始观看记录始终是事实来源。此版本保留退役汇总代际以便核查，不会自动删除历史
汇总；频繁变更时区或手动重建会额外占用存储，后续清理不得删除任何仍处于
`active_generation` 或 `building_generation` 的数据。

资源统计改为数据库内条件聚合，视频时长仍逐条向下取整后求和；字幕文件数与
包含字幕的视频数分开计算。启动迁移会补充 `(family_id, parent_id)` 和
`(family_id, kind, item_id)` 索引，供目录递归和文件聚合使用。


### 家庭空间额度与超管用户管理

新建家庭的 `families.storage_limit_bytes` 默认是 5 × 1024³ 字节（界面 5 GiB）。额度按家庭共享，不按设备或成员重复累计，也不预分配实际存储。启动时兼容升级 SQLite/MySQL 旧表：已有家庭该字段为 NULL，继续沿用原 `MOLLYTIME_FAMILY_STORAGE_LIMIT_BYTES`（默认 0，即不限额）；不批量降低旧用户额度。超管明确保存后写入该家庭的独立额度，0 为不限额，之后不受全局兼容配置影响。

- `GET /api/manage/operations/users?q=&page=1&pageSize=20`：仅超管可用，搜索邮箱、账号 ID、用户名、家庭名称；返回用户角色、所属家庭、已用空间、上传预留和额度，不返回凭据。
- `PUT /api/manage/operations/users/{user_id}/storage`：提交整数字节数 `limitBytes` 与读取时的 `expectedLimitBytes`。使用现有来源、会话、CSRF 与超管校验，拒绝负数、小数、布尔、字符串及超过 JavaScript 精确整数范围的数值；额度已变化返回 409，不覆盖其他超管的更新。
- 配额修改与上传预留、分享领取使用同一家庭锁。新上传及领取校验已用空间＋上传预留＋新增字节；额度调低后不删除已有媒体或取消在途上传。`GET /api/manage/settings` 返回该家庭的有效额度，网页、iOS、Android 沿用现有读取和刷新方式展示。

验证：家庭默认值、旧表迁移和幂等性、权限/CSRF、输入边界、同家庭共享与跨家庭隔离、配置冲突、上传预留、分享领取、降低及不限额等相关服务端测试共 148 项通过；网页构建及用户管理桌面/手机浏览器流程通过。验证使用隔离测试数据库，未修改生产额度。
