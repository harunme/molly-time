# Molly TV

家庭儿童视频项目。目标采用轻量 Kotlin WebView 壳子 + TV 网页 + 原生 Media3 播放器，统一使用 Molly FastAPI 后台，不依赖 Jellyfin。先验证华为 V65，再完善家庭业务。

## 已确定方案

- TV 浏览界面采用 React + TypeScript + Vite，Norigin 负责遥控器焦点导航；网页与 WebView 壳子已实现；华为 V65 尚未实测。
- 首阶段加载固定网页地址，通过网页部署热更新；需要断网启动时再加入本地网页包、验签与回滚。
- 原生壳子保留 Media3 播放与凭证管理，网页通过有限 Bridge 调用。播放期间不刷新网页。
- `apps/server/` 是唯一业务与媒体后台，家庭、儿童、上传、首页与统计按模块实现，不拆第二套业务服务。
- 实施顺序与待修正问题见 [架构文档](docs/architecture.md)。

## 当前实现

- **服务端**：`apps/server/` Python 自研 REST（FastAPI + SQLAlchemy + SQLite/Pillow）；账号与设备认证、分块上传、文件检查、首页配置、真实播放统计；本地文件通过 HTTP Range 返回，不默认转码。OSS 适配与签名地址跳转尚未接通和验收。
- **家长后台**：`apps/parent-web/` React 网页，入口 `/manage/`；资源库、上传任务、首页编排、观看记录、家庭设置，使用同一个 FastAPI 后台。
- **客户端**：`apps/tv/client/` 新写的轻量 Android TV 客户端；2 个 Activity（Shell/Playback）+ OkHttp + media3 ExoPlayer；不依赖 jellyfin-sdk、不依赖 jellyfin-androidtv UI tree。
- 历史 fork：`apps/tv/app/` 保留上游 fork 仅作参考，已从 Gradle 构建中移除；包含 Molly 预览入口的早期版本。
- 新客户端在线播放后台上传并发布的媒体；历史离线样本不进入新版 APK。
- 调试包名 `com.molly.tv.debug`，发布包名 `com.molly.tv`。
- 本地 Android 工具链、构建、模拟器与安装脚本；本地服务端构建、初始化、运行脚本。

离线样本播放器是历史诊断入口；当前轻量客户端联网播放使用 Molly 自有 `/api/*`。上传发布、首页编排、设备登记/撤销、儿童续播与原生播放时长统计已接通；历史进度不能还原为观看时长。基础版范围与限制见 [家长后台说明](apps/parent-web/README.md)。

## Mac 构建与运行

工具要求：JDK 21、Android SDK 36、Build Tools 35.0.0/36.0.0、platform-tools、Android Emulator、ARM64 Android TV API 34 镜像、FFmpeg（ffprobe）。此机 SDK 和运行数据位于忽略目录 `.local/`，Android Studio 在 `/Applications/Android Studio.app`。

```bash
# 服务端
bash tools/build-server.sh           # 创建 .venv + 装依赖
bash tools/init-server.sh            # 建库 + 创建 admin
bash tools/build-tv-web.sh           # 构建 TV 网页
bash tools/build-parent-web.sh       # 构建家长管理网页
bash tools/run-server.sh             # API + /tv/ + /manage/，监听 127.0.0.1:8096

# 客户端（WebView 壳子 + 原生 Media3）
bash tools/start-tv-emulator.sh
bash tools/build-tv-client.sh
.local/android-sdk/platform-tools/adb -e install -r artifacts/molly-tv-webview-debug.apk
.local/android-sdk/platform-tools/adb -e shell am start -n com.molly.tv.debug/com.molly.tv.ShellActivity
```

新版 APK 输出：`artifacts/molly-tv-webview-debug.apk`。用 Android Studio 打开 `apps/tv`，选择上述 SDK 和 JDK 21，也可直接调试。

模拟器启动脚本同时启用鼠标点击与 Mac 键盘输入：方向键选择、回车确认，返回可用模拟器右侧返回按钮或遥控器面板。鼠标用于开发便利，电视实机仍按遥控器验证。

历史离线样本工具 `tools/prepare_samples.py` 仍保留，但新版构建不执行它。视频通过家长后台上传并发布后联网播放；文件存在不代表编码或完整性已通过实机验收。

## 本地 Molly Server

```bash
bash tools/build-server.sh       # 创建 .venv
bash tools/init-server.sh        # 建库 + 创建 admin
bash tools/build-tv-web.sh       # 构建 /tv/ 网页
bash tools/build-parent-web.sh   # 构建 /manage/ 网页
bash tools/run-server.sh         # 127.0.0.1:8096
```

或用 Docker：

```bash
docker compose -f infra/compose.yaml up -d molly-server
docker compose -f infra/compose.yaml --profile tools run --rm admin-tools init_db
docker compose -f infra/compose.yaml --profile tools run --rm admin-tools create_admin
```

默认账号 `admin` / `molly`（`MOLLY_INITIAL_ADMIN_*` 覆盖）。服务设计、端点清单、配置项见 [`docs/server.md`](docs/server.md)。

家长后台打开 `http://127.0.0.1:8096/manage/`。已有服务升级后须重启进程加载新 API。观看统计需要安装新版 APK，并在播放前选择儿童。

**重置（含旧 Jellyfin 数据）**：`tools/reset-server.sh`，按提示确认删除 `.local/molly-server/` 与 `.local/jellyfin/` 后重新初始化。

模拟器中在首次启动的连接页面输入 `http://10.0.2.2:8096`。Mac 的 localhost 不是模拟器的 localhost。

默认服务仅绑定 Mac 回环地址，真实电视不能直接访问。实机联网测试时，另建本地覆盖配置将端口绑定到 Mac 的局域网地址；完成账号配置后再开放，不修改默认配置暴露管理员初始化页面。

## 华为电视验证

将新版 debug APK 放入 U 盘根目录，按华为的媒体中心安装流程尝试安装。先验证启动、网页加载、遥控器、联网视频、字幕、返回与续播。Mac 模拟器通过不表示 HarmonyOS 已通过。APK 当前为 debug 签名，供家庭测试，尚未制作正式签名和品牌图标。

## 文档与许可

- [新版 TV 客户端运行说明](apps/tv/client/README.md)
- [TV 网页与热更新](apps/tv-web/README.md)
- [家长管理后台使用说明](apps/parent-web/README.md)
- [家长后台设计与验证](docs/parent-admin-validation.md)
- [架构与分阶段验收](docs/architecture.md)
- [Molly Server 设计](docs/server.md)
- [上游基线与修改边界](docs/upstream.md)
- [新版 WebView 客户端验证](docs/tv-webview-validation.md)
- [历史验证记录](docs/local-validation.md)
- [上游客户端许可](apps/tv/LICENSE)

`apps/server/` 源码采用 MIT License（使用自有 API，不依赖 Jellyfin 服务端代码）。`apps/tv/` 沿用上游 Jellyfin Android TV 许可证。保留上游声明；分发修改后的客户端前核对适用许可证及对应源码提供义务。不得将未实现的家庭隔离当作已具备功能。
