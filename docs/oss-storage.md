# OSS 上传与电视播放缓存

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
MOLLYTIME_MAX_UPLOAD_BYTES=524288000
MOLLYTIME_MEDIA_PROCESSING_MAX_BYTES=524288000
# 0 表示不设置商业配额；非零时按家庭计算已存储文件和未结束上传的预留。
MOLLYTIME_FAMILY_STORAGE_LIMIT_BYTES=0
```

单个视频默认上限 500 MiB（界面显示 500 MB），创建上传任务前即拒绝超限文件，不创建 OSS 分片会话。前端从 `/api/manage/uploads/options` 获取大小限制，普通视频与两段家长提醒共用限制。有效视频上限取上传上限和处理上限的较小值，修改环境配置后需要重启 API/worker；已入库的视频不受影响。

Bucket 使用私有权限。RAM 身份仅授予这个 Bucket 内 `families/*` 对象的上传、读取、分片完成/取消、列举分片及删除权限。不要下发长期密钥给浏览器或 TV。不要改写签名 URL 的主机名；保留的 CDN 配置暂不生效。

Bucket CORS 允许管理网页及浏览器 TV 的实际来源，例如 `https://molly.example`（开发环境可单独允许 `http://127.0.0.1:5174`、`http://127.0.0.1:5173`）。允许 `PUT, GET, HEAD`，允许请求头 `Content-Type, Content-MD5, Range`。不要启用跨域 Cookie。浏览器给每个上传分片计算 MD5，后台签署对应对象、分片和 MD5 的短期 PUT URL，OSS 校验传输内容。大小在完成前由后台核验，分片签名不是上传字节费用的硬上限。

应用 worker 每五分钟扫描一次过期上传，每批最多处理 100 个：未完成上传默认在创建 72 小时后清理；处理失败后重新保留 72 小时供重试。保留时长共用 `MOLLYTIME_UPLOAD_EXPIRY_HOURS`，点击重试和再次失败都会更新期限。上传任务展示实际清理期限。

清理会取消 OSS 分片会话，删除未入库的完整对象、无引用的自动封面和本地临时文件；成功后标记取消并释放预留配额。已经入库或被其他媒体引用的对象、排队中和运行中的任务都跳过。清理与处理 worker 共用文件锁，并与完成、取消、重试共用上传锁，避免并发误删。单个对象清理失败会记录提示，下次扫描重试，不阻塞本批其他对象。

建议另配 OSS“清理未完成分片”生命周期规则，期限大于应用上传期限，作为应用长期停机的兜底；本次代码不会修改 Bucket 生命周期，也不会对正常已入库素材设置自动过期。应用重启后会继续扫描到期的未完成和失败上传。

## 家庭间内容分享

管理端支持单视频或合集的七天链接／口令分享。接收时仅创建独立家庭内容记录，共用同一份存储文件；来源删除不影响已接收内容。未过期分享保留原版本，过期后由 worker 结合全部引用安全清理。规则和接口见 [家庭间内容分享](content-sharing.md)。

## 数据和处理

新增 `upload_targets`、`media_options` 和 `device_downloads`，启动时自动建表并记录 `storage-v2`。没有删除/修改原表，不迁移既有文件。旧上传会话仍使用本地上传；每个媒体文件按自身 `storage` 选择后端。

OSS 文件路径由服务端生成，完成后不可再用原分片会话覆盖。后台先核验分片大小、完成对象并核验对象大小，再创建幂等处理任务。对象已完成而数据库提交中断时，可重试完成恢复。

视频预处理在管理网页完成。浏览器按 MP4 box 结构读取 `moov/mvhd` 的时长，并确认存在视频轨道；跳过 `mdat` 视频数据，不把整个文件加载到内存，也不依赖浏览器支持视频编码。解析设置 box 数量上限，拒绝越界、截断、无视频轨道或无效时长。浏览器再尝试从本地视频生成最多 640×360 的 JPEG 封面；解码失败、超时（5 秒）或黑帧时使用默认封面，不阻止上传。视频准备工作也受上传队列并发上限 2 限制。

完成接口接收浏览器提供的 `runtimeMs` 和可选 JPEG data URL；校验整数范围、封面格式、尺寸及大小后，将少量信息原子保存到临时文件，与现有任务队列配合。OSS 视频仍由服务端核验分片、合并和最终对象大小；worker 再核验一次对象大小，然后采用浏览器提供的时长和封面入库，不下载原视频、不计算整文件 SHA-256、不运行 FFprobe/FFmpeg，也不调用 IMM 或 OSS 付费处理服务。元数据随成功处理、取消、过期或彻底删除清理；处理失败时保留，供手动重试使用。

新视频的 `sha256` 留空，播放接口按既有 `sha256 or id` 规则使用文件 ID 作为版本；历史视频的哈希和版本不改。每次上传使用新的 OSS 对象路径，完成后不覆盖。旧版“保存到电视”接口不允许为新建、无哈希的 OSS 视频创建完整下载任务，普通在线播放和新版播放缓存正常使用。

这里信任本家庭上传端提供的时长，只校验输入范围和上传传输完整性，不承诺发现伪装文件或视频中所有损坏，也不保证设备支持所有编码。时长无法解析时请检查原 MP4；截图不成功时可单独上传自定义封面。旧版管理网页或历史未完成 OSS 上传缺少时长时，不会回退到服务器下载处理，需要刷新管理网页并重新选择原视频继续上传，或删除失败任务后重新上传。

OSS 图片和字幕仍下载为小型临时文件，验证格式并计算 SHA-256。新版网页向本地存储上传视频时也提供时长与封面，跳过视频扫描；不带这些信息的历史本地上传接口继续沿用原来的本地检查，以保持兼容。处理 worker 沿用同数据目录跨进程文件锁，同时处理一个任务，不新增队列服务或云端配置。

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

Android 仅在播放时按读取片段写入磁盘缓存，缓存键为文件 ID＋版本，不随 OSS 签名地址变化。再次播放命中缓存的片段直接读取本地，缺失片段才请求 OSS；跳过的片段不保证已缓存，不额外预下载整部视频。缓存跨应用重启保留，上限 5 GB，至少保留 1 GB 可用空间；满额时按最近使用时间清理，空间不足时仍可在线播放。

管理后台不再提供“保存到电视”和“清理电视副本”，新版客户端不再轮询或执行下载任务。历史下载接口和数据暂留以兼容旧客户端；升级后的已有缓存统一参与自动清理，不再固定保留。历史已验证副本的离线读取仍沿用原授权检查，普通播放缓存不承诺断网播放。

换家庭或解除绑定时清理本地缓存。正常播放仍需访问 API 检查权限并记录观看时长；视频字节命中缓存时不重复从 OSS 获取。浏览器 TV 继续使用浏览器自身缓存策略。

**本期正常入库的云端素材长期保留，不启用“下载后七天删除”、支付、下载流量套餐或自动扣费。** 保留策略字段为 `backup`，待后续有完整提示和恢复设计再扩展。

## 上线前验证

后端测试使用伪 OSS 验证接口策略，不能证明真实 Bucket 的权限、CORS 或 TV 的磁盘行为。上线前使用测试家庭、真实 Bucket 和实体 TV 完成上传/续传、长时间播放、签名过期恢复、完整下载、进程重启复用、空间不足、清理和取消配对验证。通过 OSS 日志及网络抓包确认重播命中缓存，不再次下载完整视频。
