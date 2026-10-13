# MollyTime 家长管理后台

基础版已实现，入口 `/manage/`。与 TV 共用 `apps/server/`、家庭权限和媒体目录。

## 使用

```bash
# 在仓库根目录运行；本机须安装 FFmpeg（含 FFprobe）。
bash tools/build-server.sh
MOLLYTIME_INITIAL_ADMIN_EMAIL=you@example.com bash tools/init-server.sh # 新数据库创建超管
bash tools/build-tv-web.sh
bash tools/build-web.sh
bash tools/run-server.sh                   # 加载新版 API 和两个静态网页
```

打开 `http://127.0.0.1:8096/manage/`。如果旧服务已经运行，先停止旧实例再启动，网页构建不会给正在运行的 Python 进程增加新路由。新账号使用邮箱或数字 ID 登录，初始密码由 `MOLLYTIME_INITIAL_ADMIN_PASSWORD` 配置（开发默认 `molly`）。已有 `admin / molly` 账号仍可过渡登录，首次进入后台绑定邮箱后改用邮箱或数字 ID，密码和家庭数据保留。

前端开发：`cd apps/web && pnpm dev`，打开 `http://127.0.0.1:5174/manage/`。Vite 默认代理本机 8096；可用 `MOLLYTIME_API_PROXY` 指向另一端口。代理保留原 Host，使来源校验生效。正式部署采用同源 HTTPS；远程 HTTP 页面无法使用浏览器的安全文件校验接口。

## 已接通的能力

- 账号：邮箱和十位数字 ID 登录、旧账号绑定邮箱；账号菜单可查看数字 ID。新用户注册必须先验证邀请码。
- 用户邀请：仅超管通过“运营设置 → 用户邀请”生成十二位邀请码，无需预先填写邮箱和家庭名称。一码一人，默认七天有效，可查看记录或撤销；邀请码加密保存，在邀请记录中持续显示和复制，刷新后保留。旧版本仅保存哈希的码无法恢复明文，需生成新码。受邀者在登录页选择“使用邀请码”，验证后自行填写邮箱、家庭名称和密码，注册后建立独立家庭并成为管理员。注册失败不消费邀请码，已发出的旧邀请链接继续有效。暂未接入邮件发送或邮箱验证码，不支持修改已绑定邮箱。
- 资源库：系列 → 季 → 剧集；新建和修改名称、介绍与序号；搜索、状态筛选、家长视频预览；发布、批量发布/下架、归档。
- 上传：多个 MP4、追加 SRT/VTT 字幕、替换封面或视频；8 MiB 上传块、最多 2 个并发文件；偏移续传、重复块校验、暂停、继续、取消。离开页面继续上传，关闭浏览器后需重新选择原文件。
- 处理：持久化任务、执行租约与失败重试；检查 MP4 容器、视频轨与有效时长，生成剧集封面，检查图片和 UTF-8 字幕。视频不限制为 H.264/AAC，原文件保留且不默认转码；能否播放取决于浏览器或电视的解码能力。自动封面提取失败时使用默认封面，不阻止视频就绪。上传完整、检查就绪、内容发布分别显示。
- 概览：登录后的默认首页；视频总量与发布状态、进行中和失败上传、已绑定电视、近 7 天观看次数、媒体用量；最近上传和设备每页 5 条，可跳转对应管理页。观看次数按家庭时区计算开始且有有效播放的会话，多个播放区间计为一次观看。
- 观看记录：儿童/日期筛选、实际播放时长、每日趋势、系列分布和会话明细。按家庭时区拆分跨日区间；家长预览和旧进度事件不计入。
- 家庭设置：儿童新增/改名、TV 设备改名/撤销、时区、磁盘余量和管理员密码修改。成员可查看，写操作需要管理员；退出自己的会话不需要管理员。

新增上传剧集保持草稿；系列和季是目录容器，默认可见，但 TV 只显示有已发布且可播放剧集的内容。下架整个系列/季会一并阻止其子内容的新播放。

视频统一通过管理后台上传，不提供服务器目录扫描导入。上传检查不替代 TV 实机编码验收，发布前须预览确认。没有视频文件的旧目录条目不会进入 TV 可播放列表。

视频替换保留剧集 ID，旧文件与媒体记录保留，已启动的播放器使用固定文件 ID；续播位置超过新视频长度时从头开始。新封面使用版本化 URL 刷新。归档只改变可见性，不删除历史和实体文件。

## 播放统计需要新版 APK

重新构建并安装 `artifacts/mollytime-tv-debug.apk`。TV 扫码绑定后自动登记一个设备，签发可撤销的设备凭证；升级前保存的管理员 TV 会话会要求重新登录。家长管理凭证使用独立 HttpOnly Cookie 和 CSRF 校验，不进入 TV Bridge。

原生播放器用单调时钟结算 `isPlaying` 区间，在状态变化/退出时提交，并每 15 秒上报。服务端以会话和序号去重，拒绝重叠区间，乱序补传不会倒退新会话的续播。暂停、缓冲和拖动不计时；倍速不改变真实经过时间。统计反映设备播放，并不证明孩子一直在看屏幕。

失败事件保存在原生私有文件中，每分钟重试；队列上限 5000 条。崩溃前未保存的尾段、队列已满之后的新记录无法补算；切换服务或设备身份后的旧身份记录不会发送给新身份。异常结束的会话明确显示“播放中或未正常结束”。旧客户端仅上报续播位置，无法还原历史时长；旧客户端也不会收到“继续观看”的新剧集卡片。

## 部署与数据

Docker 镜像同时构建两个网页，运行时只有 Python 服务与媒体任务线程，不运行 Node。镜像安装 FFmpeg；compose 的上传目录 `.local/molly-server/media` 单独可写。`admin-tools` 复用同一服务镜像，具备数据库依赖与相同的数据路径。

首次升级使用附加表保存资源状态、上传任务、首页版本、设备与统计，不删除或改写旧事件；已有 SQLite 自动备份到同目录 `server.pre-management-v1.sqlite`，并记录 `management-v1` 修订。生产引擎启用外键、WAL 和写锁等待；读后校验再写的关键操作在 SQLite 中串行化。

默认在服务内运行一个媒体任务线程。需要独立进程时，API 设置 `MOLLYTIME_MEDIA_WORKER_ENABLED=false`，同环境启动 `python -m mollytime_server.media_worker`；不需要 Redis 或消息队列。管理静态目录可通过 `MOLLYTIME_PARENT_WEB_DIR` 覆盖。单个视频默认上限 500 MiB（界面显示 500 MB），普通上传和家长提醒视频共用限制；前端选择时检查，后端在创建上传会话前拒绝超限文件。`MOLLYTIME_MAX_UPLOAD_BYTES` 和 `MOLLYTIME_MEDIA_PROCESSING_MAX_BYTES` 可覆盖上限，有效上限取两者较小值。

当前支持本地/OSS 存储、平台超管、家庭管理员和成员三种角色、过期未完成上传清理、字幕设置及保存到电视任务。永久删除已入库素材、旧版本自动清理、自动转码、儿童内容限制、观看限额、CDN、支付和离线网页包尚未实现。OSS 配置与下载限制见 [部署说明](../../docs/oss-storage.md)。预览展示栏目比例和可见内容，完整遥控器交互仍在 TV 页面验收。

## 验证

```bash
apps/server/.venv/bin/python -m pytest apps/server/tests -q
pnpm --dir apps/web build
pnpm --dir apps/web test
pnpm --dir apps/tv/web build
pnpm --dir apps/tv/web test
# Android：:client:assembleDebug :client:testDebugUnitTest :client:lintDebug
```

网页测试运行真实临时 API/SQLite，生成并上传真实 MP4；所有夹具与截图数据属于隔离测试库。截图位于忽略目录 `artifacts/parent-*.png`。

TV 实际播放验证另见 [验证记录](../../docs/parent-admin-validation.md)。设计基线见 [后台设计](../../docs/parent-admin-design.md)。

## 绑定电视

电视首页选择“绑定家庭媒体库”，手机扫码打开 `/manage/?pair=配对码`。未登录时先登录家长后台，链接中的配对码会保留；管理员核对电视、目标家庭和配对码后，点击“确认绑定这台电视”。电视自动获得设备凭证并进入片单。也可从“家庭设置 → TV 设备 → 绑定电视”手动输入短码。家庭成员无权确认绑定。

配对码十分钟有效，已确认的短码不可再次绑定；关闭电视配对弹层会取消未完成的请求。设备可在家庭设置中改名、撤销；撤销同时阻止既有访问和凭证刷新。

已配对电视会一直缓存绑定，刷新、重启和断网不要求重新配对。家长在“家庭设置 → TV 设备 → 取消配对”后，接口立即拒绝访问，TV 在下次访问或三十秒授权检查时清除缓存。

## 管理后台界面

管理后台使用 React + TypeScript、Tailwind CSS v4（Vite 插件）和 shadcn/ui（Radix 基础组件）。基础组件迁移自 `smart-afs-platform/frontend/smartafs/src/components/ui`，组件源码统一在 `src/components/ui`。Tailwind v4 的 CSS-first 全局配置在 `src/styles/theme.css`，集中维护颜色、字号、圆角、控件尺寸、阴影、层级及动效变量；`src/styles/ui-motion.css` 提供配套动画，`src/style.css` 只保留应用基础规则和页面布局。组件不再各自写固定颜色或重复定义变量。Geist 字体随应用自托管，图标使用 Lucide。

页面使用 React Router 的 hash 路由：概览 `/manage/#/overview`、资源库 `/manage/#/library`、文件夹 `/manage/#/library/:folderId`、上传任务 `/manage/#/upload`、观看记录 `/manage/#/watch`、家庭设置 `/manage/#/family`；运营设置页签分别为 `/manage/#/operations/storage`、`/manage/#/operations/client-releases` 和 `/manage/#/operations/invitations`。导航、刷新及浏览器前进后退均保留当前页面。默认入口和未知路径跳转概览，普通账号访问运营设置也跳转概览，接口仍独立校验权限。

登录入口为 `/manage/#/login`，未登录访问管理页时，登录后回到原 URL。邀请码入口为 `/manage/#/invite`，旧 `#invite=…` 链接仍有效，旧邀请令牌转换为 fragment 内的 `#/invite?token=…`。电视配对入口为 `/manage/#/pair?code=…`，兼容原 `/manage/?pair=…`。路由部分不发送给服务器，因此刷新仍只请求 `/manage/`，无需服务器配置 SPA 路径回退或重启 API；更新前端构建后刷新浏览器即可。

2026-10-13 起，后台参考 Smart AFS 的视觉语言：石墨色顶栏、白色导航和内容区、浅灰画布、黄色主按钮与导航标记。管理页和弹窗共用主题 token。顶栏提供 TV 入口和账号菜单，内容区不展示面包屑栏。

管理列表默认每页 20 条，概览的小列表每页 5 条。使用 `page`、`pageSize` 请求，服务端返回 `{ items, total, page, pageSize }`；`pageSize` 上限为 100。包括资源、文件夹视频、上传任务、儿童、设备和电视保存任务；客户端安装包列表沿用其已有分页。资源搜索和状态筛选先在数据库执行，再统计总数和取当前页。资源列表省略文件和介绍，打开编辑弹窗时通过 `/resources/{id}` 读取详情；文件夹选择器请求 `summary=true` 的轻量候选。

`/api/manage/overview` 用数据库聚合返回固定大小的统计对象，不拉取所有资源或观看区间。概览进入时加载，翻页仅请求相应列表。后台移除首页编排入口和前端编辑器。

观看报表使用 `sessionPage`、`contentPage` 分别翻页，返回 `sessionTotal`、`contentTotal`，总时长与每日统计覆盖完整日期范围。区间按批流式读取，设备和儿童等明细信息只为当前页批量查询。搜索输入防抖 300 毫秒，切换页面与筛选取消旧请求。所有管理页均无刷新按钮、定时轮询或切回窗口时的自动刷新；进入页面、翻页、筛选和写操作完成后按需加载。正在上传的本地文件进度由实际传输事件更新。旧的无页码列表调用暂时保持数组形状，但限制最多 100 条。

新增组件可在本目录执行 `pnpm dlx shadcn@latest add <组件名>`，新增页面复用现有按钮、表单、弹窗和状态组件。视频行的更多操作菜单支持直接上传字幕；手机导航可横向滚动，账号菜单支持退出登录。


### 基础组件使用

页面表单使用 `Input`、`Textarea`、`Label` 和 `SelectField`，不再使用原生下拉框。`SelectField` 由迁入的 `Select` 组合，保留业务空字符串、禁用项与动态候选；`MonthPicker` 由迁入的 Button / Select / Popover 组合，并保持 YYYY-MM 接口。日期选择保留中文、键盘操作和本地日期语义。

弹窗使用 Dialog / ConfirmDialog，表格使用 Table 系列，分页使用公共 Pagination 控件，复制等短暂通知使用 `message` / Sonner；业务层只负责路由、接口、候选数据和校验。Radix 继续由已有 `radix-ui` 包提供，新增依赖仅为组件库所需的 cmdk、react-hook-form 和 sonner。黑色 tab 下划线及全局 pointer 光标保留。

调整所有表单尺寸使用 `--spacing-control` / `--spacing-control-sm` / `--spacing-control-lg`；调整基础组件圆角使用 `--radius-ui` / `--radius-control-mark` / `--radius-dialog`；配色使用 `--color-*`。不要在页面重新覆盖基础控件的颜色、圆角或焦点样式。


卡片与浮层层次借鉴 [YourDynamicDashboard](https://github.com/xtditom/YourDynamicDashboard)：卡片采用 `--radius-card` 的 1.5rem 大圆角、淡边线和轻阴影；弹窗及菜单采用 1rem 圆角与扩散阴影。面板、控件和弹窗分别使用 `--radius-card`、`--radius-ui`、`--radius-dialog` / `--radius-popover`，阴影统一由 `--shadow-card` / `--shadow-dialog` / `--shadow-popover` 控制。首页卡片间距、内边距由 `--spacing-card-gap` / `--spacing-card-padding` 控制。

管理页内容区使用右侧全部可用宽度，运营卡片不再单独限制宽度。字号统一为：页面标题 24px，卡片及弹窗标题 18px，表单输入与日期字段 16px，正文、按钮、导航及表格 14px，说明、状态及分页 12px；同一角色使用相同 Tailwind 字号，避免业务页面随意缩小基础组件。操作按钮、日期、邮箱和状态保持完整，长资源标题截断并保留完整 title，详细数据表在自身容器横向滚动。

热力图使用 `--spacing-heatmap-cell` / `--spacing-heatmap-gap` / `--radius-heatmap`，日期格保持正方形，全年格子不随屏幕宽度拉伸。桌面摘要与日期图分栏，手机显示最近日期并允许横向滚动，原有点击和键盘选择保留。`FileUploadField` 提供紧凑的中文文件选择入口，与其他控件共用高度和字号。`manage-layout.spec.ts` 覆盖 390、1280、1920px 下的所有管理主页面和运营页签，以及长时长、热力图比例和表单一致性。
