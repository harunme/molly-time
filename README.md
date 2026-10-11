# Molly TV

基于 Jellyfin Android TV v0.19.10 的电视端基础项目，先验证华为 V65 的遥控器与播放兼容性，再开发多家庭业务。

## 当前实现

- 完整保留上游客户端源码、服务器连接、认证与播放能力。
- Molly TV 预览首页，遥控器可选离线样本或进入 Jellyfin。
- 构建时从 `downloads/bbkt` 生成三集本地视频，支持 Media3 控制、同目录多轨 SRT、退出后续播。
- 独立包名 `tv.molly.app.debug`，不会覆盖官方 Jellyfin APK。
- 本地 Android 工具链、构建、模拟器与安装脚本。
- Jellyfin 本地服务 compose 配置，媒体目录只读挂载。

离线样本播放器是诊断入口，复用已有 Media3 依赖；联网播放保留完整上游链路。当前没有真实家庭账号、上传服务、首页后台或观看统计，不将本地进度当成正式产品统计。

## Mac 构建与运行

工具要求：JDK 21、Android SDK 36、Build Tools 35.0.0/36.0.0、platform-tools、Android Emulator、ARM64 Android TV API 34 镜像、FFmpeg（ffprobe）。此机 SDK 和运行数据位于忽略目录 `.local/`，Android Studio 在 `/Applications/Android Studio.app`。

```bash
bash tools/build-tv.sh
bash tools/start-tv-emulator.sh
# 模拟器启动完成后，在另一个终端：
bash tools/run-tv.sh
```

APK 输出：`artifacts/molly-tv-preview.apk`。用 Android Studio 打开 `apps/tv`，选择上述 SDK 和 JDK 21，也可直接调试。

模拟器启动脚本同时启用鼠标点击与 Mac 键盘输入：方向键选择、回车确认，返回可用模拟器右侧返回按钮或遥控器面板。鼠标用于开发便利，电视实机仍按遥控器验证。

需要更多样本时运行 `python3 tools/prepare_samples.py --limit 5`；标准构建默认重新生成三个。样本、SDK、构建缓存和运行凭证均不提交。优先选择经 ffprobe 包扫描未报告错误的小文件，并尽量包含一个带字幕的样本；同目录所有 SRT 保留为可选字幕轨，按明确文件名默认选英文轨。这是输入完整性检查，不代替所有编码的实机解码验证。

## 本地 Jellyfin

```bash
docker compose -f infra/compose.yaml up -d
```

打开 `http://localhost:8096` 完成初始管理员设置；添加库路径 `/media/bbkt`。原目录仅供初步浏览验证，正式导入的儿童系列元数据与映射尚未实现，不保证影视刮削准确，试验库建议关闭外部元数据获取。

模拟器中通过首页「连接家庭媒体库」添加 `http://10.0.2.2:8096`。Mac 的 localhost 不是模拟器的 localhost。

默认服务仅绑定 Mac 回环地址，真实电视不能直接访问。实机联网测试时，另建本地覆盖配置将端口绑定到 Mac 的局域网地址；完成账号配置后再开放，不修改默认配置暴露管理员初始化页面。

## 华为电视验证

将预览 APK 放入 U 盘根目录，按华为的媒体中心安装流程尝试安装。先验证启动、遥控器、离线视频、字幕、返回与续播。Mac 模拟器通过不表示 HarmonyOS 已通过。APK 当前为 debug 签名，供家庭测试，尚未制作正式签名和品牌图标。

## 文档与许可

- [架构与分阶段验收](docs/architecture.md)
- [上游基线与修改边界](docs/upstream.md)
- [本地验证结果与待完成项](docs/local-validation.md)
- [上游客户端许可](apps/tv/LICENSE)

保留上游声明。分发修改后的客户端前核对适用许可证及对应源码提供义务。不得将未实现的家庭隔离当作已具备功能。
