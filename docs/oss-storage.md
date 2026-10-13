# OSS 上传与电视本地保存

家长在 `/manage/` 上传 MP4、SRT/VTT 和封面，预览后发布给本家庭。OSS 模式下视频上传和播放不经过业务 API 的数据通道。支付和套餐不在本期实现中。

## 管理后台配置与超管

管理后台的 **运营设置 → 文件存储** 仅平台超管（`superadmin`）可访问；家庭管理员（`admin`）和成员（`member`）没有运营权限。超管保留自己家庭的管理能力，不会因此获得其他家庭的媒体访问权。

初始化 `bash tools/init-server.sh` 创建或提升初始账号为超管。已有部署可从仓库根目录执行：

```bash
apps/server/.venv/bin/python -m mollytime_server.scripts.create_admin --superadmin
```

命令使用 `MOLLYTIME_INITIAL_ADMIN_USERNAME` 等初始账号配置；创建新账号必须提供 `MOLLYTIME_INITIAL_ADMIN_EMAIL`，脚本输出数字登录 ID。已有账号保留密码，已绑定邮箱不会被替换；旧账号可在首次进入后台时绑定邮箱。邮箱与数字 ID 全系统唯一；若初始化标识或邮箱已属于其他家庭，命令拒绝创建或提升。数据目录必须与 API 一致（默认 `.local/molly-server`）。已有其他超管时拒绝再创建第二个；普通执行 `create_admin` 不会自动提升权限。

在运营设置中选择本地或 OSS，填写公共 Endpoint、私有 Bucket、AccessKey ID/Secret，可选同地域内网 Endpoint，设置上传与播放签名有效期。测试连接会在 `families/.operations-check/` 创建、读取并删除临时对象；启用 OSS 保存时也必须通过测试。此测试不验证浏览器 CORS 或全部分片权限，需要按下文配置并实际上传验收。

后台保存的配置优先于环境变量，保存后 API 和 worker 读取新配置，无需重启。配置存于数据库 `operations_storage`，访问密钥加密保存且不回显；编辑时密钥留空保留原值。备份数据库时必须同时备份数据目录的 `operations-storage.key`（文件权限 0600），丢失密钥会导致已保存凭据无法解密。

已有 OSS 文件或未结束的 OSS 上传时不能直接更换 Bucket/公共 Endpoint；需先迁移资源。切回本地只影响新上传，旧 OSS 文件仍使用保留的云端配置。运营配置保存采用版本校验，拒绝覆盖其他会话已更新的配置。

## 服务端环境配置（后台未保存时生效）

安装 `apps/server/pyproject.toml` 的依赖，并安装 FFmpeg/FFprobe。默认 `MOLLYTIME_STORAGE_BACKEND=local`，现有本地文件继续可用。启用 OSS 时在服务端环境配置：

```dotenv
MOLLYTIME_STORAGE_BACKEND=oss
MOLLYTIME_OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
MOLLYTIME_OSS_BUCKET=your-private-bucket
MOLLYTIME_OSS_ACCESS_KEY_ID=your-server-access-key
MOLLYTIME_OSS_ACCESS_KEY_SECRET=your-server-access-key-secret
# 仅同地域阿里云服务内配置内网域名；本机开发不要配置内网地址。
MOLLYTIME_OSS_INTERNAL_ENDPOINT=https://oss-cn-hangzhou-internal.aliyuncs.com
MOLLYTIME_OSS_UPLOAD_TTL=900
MOLLYTIME_OSS_SIGNED_URL_TTL=3600
MOLLYTIME_UPLOAD_EXPIRY_HOURS=72
MOLLYTIME_MAX_UPLOAD_BYTES=10737418240
MOLLYTIME_MEDIA_PROCESSING_MAX_BYTES=10737418240
# 0 表示不设置商业配额；非零时按家庭计算已存储文件和未结束上传的预留。
MOLLYTIME_FAMILY_STORAGE_LIMIT_BYTES=0
```

Bucket 使用私有权限。RAM 身份仅授予这个 Bucket 内 `families/*` 对象的上传、读取、分片完成/取消、列举分片及删除权限。不要下发长期密钥给浏览器或 TV。不要改写签名 URL 的主机名；保留的 CDN 配置暂不生效。

Bucket CORS 允许管理网页及浏览器 TV 的实际来源，例如 `https://molly.example`（开发环境可单独允许 `http://127.0.0.1:5174`、`http://127.0.0.1:5173`）。允许 `PUT, GET, HEAD`，允许请求头 `Content-Type, Content-MD5, Range`。不要启用跨域 Cookie。浏览器给每个上传分片计算 MD5，后台签署对应对象、分片和 MD5 的短期 PUT URL，OSS 校验传输内容。大小在完成前由后台核验，分片签名不是上传字节费用的硬上限。

配置 OSS 未完成分片生命周期清理，清理期限应大于上传会话期限。应用 worker 每五分钟取消过期上传；不会删除已发布视频。若没有运行 worker，过期上传无法继续使用，但清理需依靠 worker 或 Bucket 生命周期。

## 数据和处理

新增 `upload_targets`、`media_options` 和 `device_downloads`，启动时自动建表并记录 `storage-v2`。没有删除/修改原表，不迁移既有文件。旧上传会话仍使用本地上传；每个媒体文件按自身 `storage` 选择后端。

OSS 文件路径由服务端生成，完成后不可再用原分片会话覆盖。后台先核验分片大小、完成对象并核验对象大小，再创建幂等处理任务。对象已完成而数据库提交中断时，可重试完成恢复。

处理 worker 同时只处理一个任务（同数据目录跨进程文件锁），下载到临时文件，核验大小、计算 SHA-256、校验 MP4 的 H.264/AAC、检测时长并生成封面。磁盘不足或格式不支持会明确失败；远程临时文件在成功或失败后都清理，云端原文件保留供重试。建议 API/worker 在同地域部署，通过内网访问 OSS；处理过程中确实会读取一次视频，不代表视频播放经过服务器。

上传的字幕独立关联到剧集。管理后台支持名称、语言、默认字幕及时间偏移；WebVTT 转换按媒体版本和偏移缓存。封面生成及请求缩放结果保存在服务端。

## 播放和下载接口

- `POST /api/manage/uploads`：返回 `transport` 和 `partSize`；本地保留原 `/chunks`。
- `GET /api/manage/uploads/{id}/parts`：返回已确认分片。
- `POST /api/manage/uploads/{id}/part-url`：接收 `number`、Base64 `md5`，返回限对象和分片的 PUT 地址及请求头。
- 原完成、取消和重试处理接口继续使用。
- `GET /api/episodes/{id}/playback`：返回文件 ID、版本、大小、SHA-256、媒体类型、地址、有效期及字幕。可传 `mediaId`、`sessionId`。
- 原 `/play` 对本地文件返回 Range 数据，对 OSS 返回鉴权后的 302；新版客户端优先使用解析接口。
- `POST /api/manage/resources/{id}/downloads`：家长选择 `deviceId`，`desired=saved` 或 `removed`。
- `GET /api/manage/resources/{id}/downloads`：显示设备状态、进度、最后确认及设备最后连接时间。
- `GET /api/device/downloads`：仅已配对设备可查询自己的任务。
- `GET /api/device/downloads/{id}/playback`：下载过程中刷新地址。
- `POST /api/device/downloads/{id}/status`：报告版本、大小和状态。它是设备报告，不是可信的云端删除依据。

所有接口验证家庭/设备归属；签名地址响应不缓存。外部媒体请求不发送 Molly 登录令牌。已有签名 URL 在有效期内不能精确撤销，客户端仍需进行观看身份检查。

## 电视行为

Android 使用一个磁盘缓存，同时供播放和完整下载使用；缓存键为文件 ID＋版本。普通缓存上限 5 GB，至少保留 1 GB 可用空间。后台“保存到电视”触发完整下载，SHA-256 校验后标记保存成功，固定文件不参与普通缓存清理；空间不足提示家长清理。手动“清理电视副本”只移除本地文件，云端仍保留。

任务每分钟在客户端运行时同步；不是系统常驻后台下载服务。客户端被关闭时下载可能中断，下次运行续传。状态显示的是最后一次设备报告，设备离线时不保证文件当前仍在。

换家庭、退出或失效授权清理本地缓存；旧媒体版本的持久下载收到清理指令。播放开始仍需联网检查权限，重复本地播放继续记录观看时长。浏览器 TV 支持在线播放及字幕，不提供永久下载。

**本期全部云端素材长期保留，不启用“下载后七天删除”、支付、下载流量套餐或自动扣费。** 保留策略字段为 `backup`，待后续有完整提示和恢复设计再扩展。

## 上线前验证

后端测试使用伪 OSS 验证接口策略，不能证明真实 Bucket 的权限、CORS 或 TV 的磁盘行为。上线前使用测试家庭、真实 Bucket 和实体 TV 完成上传/续传、长时间播放、签名过期恢复、完整下载、进程重启复用、空间不足、清理和取消配对验证。通过 OSS 日志及网络抓包确认重播命中缓存，不再次下载完整视频。
