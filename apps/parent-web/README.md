# Molly 家长管理后台

基础版已实现，入口 `/manage/`。与 TV 共用 `apps/server/`、家庭权限和媒体目录。

## 使用

```bash
# 在仓库根目录运行；本机须安装 FFmpeg（含 FFprobe）。
bash tools/build-server.sh
bash tools/init-server.sh                  # 新数据库初始化；已有库不需重新初始化
bash tools/build-tv-web.sh
bash tools/build-parent-web.sh
bash tools/run-server.sh                   # 加载新版 API 和两个静态网页
```

打开 `http://127.0.0.1:8096/manage/`。如果旧服务已经运行，先停止旧实例再启动，网页构建不会给正在运行的 Python 进程增加新路由。开发默认账号为 `admin / molly`，也可用自己的家庭账号。

前端开发：`cd apps/parent-web && pnpm dev`，打开 `http://127.0.0.1:5174/manage/`。Vite 默认代理本机 8096；可用 `MOLLY_API_PROXY` 指向另一端口。代理保留原 Host，使来源校验生效。正式部署采用同源 HTTPS；远程 HTTP 页面无法使用浏览器的安全文件校验接口。

## 已接通的能力

- 资源库：系列 → 季 → 剧集；新建和修改名称、介绍与序号；搜索、状态筛选、家长视频预览；发布、批量发布/下架、归档。
- 上传：多个 MP4、追加 SRT/VTT 字幕、替换封面或视频；8 MiB 上传块、最多 2 个并发文件；偏移续传、重复块校验、暂停、继续、取消。离开页面继续上传，关闭浏览器后需重新选择原文件。
- 处理：持久化任务、执行租约与失败重试；检查 H.264/AAC MP4、读取时长、生成剧集封面、检查图片和 UTF-8 字幕。上传完整、检查就绪、内容发布分别显示。
- 首页：手选系列、最近发布、继续观看；栏目与系列排序、开关、条数；TV 比例预览、草稿、发布与历史版本恢复；儿童跟随家庭或独立发布。草稿不改变 TV，TV 进入/返回首页时更新。
- 观看记录：儿童/日期筛选、实际播放时长、每日趋势、系列分布和会话明细。按家庭时区拆分跨日区间；家长预览和旧进度事件不计入。
- 家庭设置：儿童新增/改名、TV 设备改名/撤销、时区、磁盘余量和管理员密码修改。成员可查看，写操作需要管理员；退出自己的会话不需要管理员。

新增上传剧集保持草稿；系列和季是目录容器，默认可见，但 TV 只显示有已发布且可播放剧集的内容。下架整个系列/季会一并阻止其子内容的新播放。

视频统一通过管理后台上传，不提供服务器目录扫描导入。上传检查不替代 TV 实机编码验收，发布前须预览确认。没有视频文件的旧目录条目不会进入 TV 可播放列表。

视频替换保留剧集 ID，旧文件与媒体记录保留，已启动的播放器使用固定文件 ID；续播位置超过新视频长度时从头开始。新封面使用版本化 URL 刷新。归档只改变可见性，不删除历史和实体文件。

## 播放统计需要新版 APK

重新构建并安装 `artifacts/molly-tv-webview-debug.apk`。TV 登录后自动登记一个设备，签发可撤销的设备凭证；升级前保存的管理员 TV 会话会要求重新登录。家长管理凭证使用独立 HttpOnly Cookie 和 CSRF 校验，不进入 TV Bridge。

原生播放器用单调时钟结算 `isPlaying` 区间，在状态变化/退出时提交，并每 15 秒上报。服务端以会话和序号去重，拒绝重叠区间，乱序补传不会倒退新会话的续播。暂停、缓冲和拖动不计时；倍速不改变真实经过时间。统计反映设备播放，并不证明孩子一直在看屏幕。

失败事件保存在原生私有文件中，每分钟重试；队列上限 5000 条。崩溃前未保存的尾段、队列已满之后的新记录无法补算；切换服务或设备身份后的旧身份记录不会发送给新身份。异常结束的会话明确显示“播放中或未正常结束”。旧客户端仅上报续播位置，无法还原历史时长；旧客户端也不会收到“继续观看”的新剧集卡片。

## 部署与数据

Docker 镜像同时构建两个网页，运行时只有 Python 服务与媒体任务线程，不运行 Node。镜像安装 FFmpeg；compose 的上传目录 `.local/molly-server/media` 单独可写。`admin-tools` 复用同一服务镜像，具备数据库依赖与相同的数据路径。

首次升级使用附加表保存资源状态、上传任务、首页版本、设备与统计，不删除或改写旧事件；已有 SQLite 自动备份到同目录 `server.pre-management-v1.sqlite`，并记录 `management-v1` 修订。生产引擎启用外键、WAL 和写锁等待；读后校验再写的关键操作在 SQLite 中串行化。

默认在服务内运行一个媒体任务线程。需要独立进程时，API 设置 `MOLLY_MEDIA_WORKER_ENABLED=false`，同环境启动 `python -m molly_server.media_worker`；不需要 Redis 或消息队列。管理静态目录可通过 `MOLLY_PARENT_WEB_DIR` 覆盖，单个视频上限可通过 `MOLLY_MAX_UPLOAD_BYTES` 覆盖（默认 10 GiB）。

当前范围：本地存储、管理员和成员两种角色。永久删除、自动清理旧版本/过期上传、自动转码、儿童内容限制、观看限额、OSS/CDN 和离线网页包尚未实现。预览展示栏目比例和可见内容，完整遥控器交互仍在 TV 页面验收。

## 验证

```bash
apps/server/.venv/bin/python -m pytest apps/server/tests -q
pnpm --dir apps/parent-web build
pnpm --dir apps/parent-web test
pnpm --dir apps/tv-web build
pnpm --dir apps/tv-web test
# Android：:client:assembleDebug :client:testDebugUnitTest :client:lintDebug
```

网页测试运行真实临时 API/SQLite，生成并上传真实 MP4；所有夹具与截图数据属于隔离测试库。截图位于忽略目录 `artifacts/parent-*.png`。

TV 实际播放验证另见 [验证记录](../../docs/parent-admin-validation.md)。设计基线见 [后台设计](../../docs/parent-admin-design.md)。
