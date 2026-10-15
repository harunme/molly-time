# MollyTime

家庭儿童视频项目。目标采用轻量 Kotlin WebView 壳子 + TV 网页 + 原生 Media3 播放器，统一使用 MollyTime FastAPI 后台，不依赖 Jellyfin。先验证华为 V65，再完善家庭业务。

## 已确定方案

- TV 浏览界面采用 React + TypeScript + Vite，Norigin 负责遥控器焦点导航；网页与 WebView 壳子已实现；华为 V65 尚未实测。
- 首阶段加载固定网页地址，通过网页部署热更新；需要断网启动时再加入本地网页包、验签与回滚。
- 原生壳子保留 Media3 播放与凭证管理，网页通过有限 Bridge 调用。播放期间不刷新网页。
- `apps/server/` 是唯一业务与媒体后台，家庭、儿童、上传、首页与统计按模块实现，不拆第二套业务服务。
- 实施顺序与待修正问题见 [架构文档](docs/architecture.md)。

## 目录结构

```text
apps/
├── server/       业务与媒体后台
├── web/          家长管理网页
├── site/         AstroWind 改造的官网静态页面
└── tv/           电视端
    ├── web/      TV 网页界面
    └── client/   Android 壳子与原生播放器
analysis/         爬虫与应用分析资料
tools/            本地构建与运行脚本
infra/            Docker 部署配置
docs/             架构、设计与验证文档
```

电视端入口见 [`apps/tv/README.md`](apps/tv/README.md)。`apps/tv/` 同时保留历史上游代码，当前 Android 构建只包含 `client/`。

## 当前实现

- **服务端**：`apps/server/` Python 自研 REST（FastAPI + SQLAlchemy + SQLite/Pillow）；账号与设备认证、分块上传、文件检查、首页配置、真实播放统计；本地文件通过 HTTP Range 返回，不默认转码。OSS 适配与签名地址跳转尚未接通和验收。
- **家长后台**：`apps/web/` React 网页，入口 `/manage/`；资源库、上传任务、首页编排、观看记录、家庭设置，使用同一个 FastAPI 后台。
- **客户端**：`apps/tv/client/` 新写的轻量 Android TV 客户端；2 个 Activity（Shell/Playback）+ OkHttp + media3 ExoPlayer；不依赖 jellyfin-sdk、不依赖 jellyfin-androidtv UI tree。
- 历史 fork：`apps/tv/app/` 保留上游 fork 仅作参考，已从 Gradle 构建中移除；包含 MollyTime 预览入口的早期版本。
- 新客户端在线播放后台上传并发布的媒体；历史离线样本不进入新版 APK。
- 调试包名 `com.molly.tv.debug`，发布包名 `com.molly.tv`。
- 本地 Android 工具链、构建、模拟器与安装脚本；本地服务端构建、初始化、运行脚本。

离线样本播放器是历史诊断入口；当前轻量客户端联网播放使用 MollyTime 自有 `/api/*`。上传发布、首页编排、设备登记/撤销、儿童续播与原生播放时长统计已接通；历史进度不能还原为观看时长。基础版范围与限制见 [家长后台说明](apps/web/README.md)。

## 日常开发

本地开发入口由根目录 `Makefile` 管理。`make dev` 并行启动 API、TV 网页、家长网页和官网；需要 Node.js、pnpm 和 Python。首次使用时先运行 `make init` 初始化本地数据库和管理员账号。日常不启动 Docker、Android 模拟器或客户端。

```bash
make dev
```

官网位于 `http://127.0.0.1:4321/`，TV 网页位于 `http://127.0.0.1:5173/tv/`，家长网页开发服务位于 `http://127.0.0.1:5174/manage/`，API 位于 `http://127.0.0.1:8096`。`make dev` 启动前会检查这四个端口（API 端口遵循配置），自动终止占用端口的监听进程；先发送 SIGTERM，等待 5 秒后仍未释放则发送 SIGKILL，释放失败时中止启动。TV、家长端和官网修改源码后由 Vite/Astro 热更新，API 修改 Python 源码后自动重启（仅监听 `apps/server/mollytime_server`，不监听媒体和数据库目录）。官网的 `/manage/`、`/tv/` 入口及热更新连接代理到对应开发服务；API 代理地址自动跟随配置端口，也可用 `MOLLYTIME_API_PROXY` 覆盖。请使用这些开发地址查看实时修改，API 端口上的静态页面仍为上次构建产物。方向键、回车和返回交互可在浏览器中验证。按 Ctrl+C 会停止四个服务及其子进程。

如果已有 API，可分别用 `make tv` 和 `make web` 启动网页，避免启动本地 API。登录和真实媒体目录需要可用的 MollyTime API；TV 网页默认代理 `http://127.0.0.1:8096`，可通过 `MOLLYTIME_API_PROXY` 指定已有后台。浏览器可验证登录和目录，原生视频播放及观看统计在发版前用 Android 客户端验证。运行 `make` 查看全部命令。

## 发版前客户端验证

发版前构建网页并用 Android 客户端检查 WebView、遥控器、原生播放、字幕、返回、续播与观看统计。Android 工具要求：JDK 21、Android SDK 36、Build Tools 35.0.0/36.0.0、platform-tools；使用模拟器时需要 ARM64 Android TV API 34 镜像。上传处理需要 FFmpeg（ffprobe）。

```bash
make build-tv
make build-web
make server                          # 单独的终端；或使用已部署后台
bash tools/build-tv-client.sh
# 使用模拟器验收时再启动；连接真实电视时跳过
bash tools/start-tv-emulator.sh
.local/android-sdk/platform-tools/adb -e install -r artifacts/mollytime-tv-debug.apk
.local/android-sdk/platform-tools/adb -e shell am start -n com.molly.tv.debug/com.molly.tv.ShellActivity
```

新版 APK 输出：`artifacts/mollytime-tv-debug.apk`。详细客户端验收见 [运行说明](apps/tv/client/README.md)。模拟器通过不代表华为 V65 已通过。

历史离线样本工具 `tools/prepare_samples.py` 仍保留，但新版构建不执行它。视频通过家长后台上传并发布后联网播放。

## 本地 MollyTime Server

官网位于根路径 `/`，开发预览使用 `make site`（`http://127.0.0.1:4321`）。`make build-web` 同时构建家长后台和官网；详情见 [`apps/site/README.md`](apps/site/README.md)。

```bash
bash tools/build-server.sh       # 创建 .venv
bash tools/init-server.sh        # 建库 + 创建 admin
bash tools/build-tv-web.sh       # 构建 /tv/ 网页
bash tools/build-web.sh          # 构建 /manage/ 网页
bash tools/run-server.sh         # 127.0.0.1:8096
```

部署时可用 Docker；日常网页开发不启动它：

```bash
docker compose -f infra/compose.yaml up -d mollytime-server
docker compose -f infra/compose.yaml --profile tools run --rm admin-tools init_db
docker compose -f infra/compose.yaml --profile tools run --rm admin-tools create_admin
```

默认账号 `admin` / `molly`（`MOLLYTIME_INITIAL_ADMIN_*` 覆盖）。服务设计、端点清单、配置项见 [`docs/server.md`](docs/server.md)。

家长后台打开 `http://127.0.0.1:8096/manage/`。已有服务升级后须重启进程加载新 API。观看统计需要安装新版 APK，并在播放前选择儿童。

**重置（含旧 Jellyfin 数据）**：`tools/reset-server.sh`，按提示确认删除 `.local/molly-server/` 与 `.local/jellyfin/` 后重新初始化。

模拟器中在首次启动的连接页面输入 `http://10.0.2.2:8096`。Mac 的 localhost 不是模拟器的 localhost。

默认服务仅绑定 Mac 回环地址，真实电视不能直接访问。实机联网测试时，另建本地覆盖配置将端口绑定到 Mac 的局域网地址；完成账号配置后再开放，不修改默认配置暴露管理员初始化页面。

## 华为电视验证

将新版 debug APK 放入 U 盘根目录，按华为的媒体中心安装流程尝试安装。先验证启动、网页加载、遥控器、联网视频、字幕、返回与续播。Mac 模拟器通过不表示 HarmonyOS 已通过。APK 当前为 debug 签名，供家庭测试，尚未制作正式签名和品牌图标。

## 名称与兼容

产品展示名称统一为 **MollyTime**，代码与构建名称使用 `mollytime`，服务端模块为 `mollytime_server`。旧环境变量 `MOLLY_*` 继续兼容，新配置优先使用 `MOLLYTIME_*`；同时设置时以新变量为准。

为保留现有媒体库与客户端升级，数据目录仍为 `.local/molly-server/`，Android 安装包 ID 仍为 `com.molly.tv`。默认开发密码、既有 Cookie、令牌和 Bridge/API 协议标识保持兼容。历史验证记录与上游参考代码保留当时名称。

旧开发环境更新后运行 `bash tools/build-server.sh`，重新安装更名后的 Python 模块。仓库目录或远程仓库名称可另外调整，不影响上述启动脚本。

## 文档与许可

- [新版 TV 客户端运行说明](apps/tv/client/README.md)
- [TV 网页与热更新](apps/tv/web/README.md)
- [家长管理后台使用说明](apps/web/README.md)
- [家长后台设计与验证](docs/parent-admin-validation.md)
- [架构与分阶段验收](docs/architecture.md)
- [MollyTime Server 设计](docs/server.md)
- [上游基线与修改边界](docs/upstream.md)
- [新版 WebView 客户端验证](docs/tv-webview-validation.md)
- [历史验证记录](docs/local-validation.md)
- [上游客户端许可](apps/tv/LICENSE)

`apps/server/` 源码采用 MIT License（使用自有 API，不依赖 Jellyfin 服务端代码）。`apps/tv/` 沿用上游 Jellyfin Android TV 许可证。保留上游声明；分发修改后的客户端前核对适用许可证及对应源码提供义务。不得将未实现的家庭隔离当作已具备功能。
