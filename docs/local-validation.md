# 本地基础版验证记录

日期：2026-10-11。范围：本地开发环境和电视预览版，不代表多家庭业务或华为实机验收完成。

## 环境

| 工具 | 实际配置 |
| --- | --- |
| Mac | Apple Silicon arm64，macOS 27.0 |
| Android Studio | 2026.1.4.7，`/Applications/Android Studio.app` |
| JDK | Homebrew OpenJDK 21，构建脚本显式指定 JAVA_HOME |
| Android SDK | API 36，Build Tools 35.0.0 与 36.0.0，platform-tools |
| 模拟器 | Android Emulator 37.2.12，Android TV API 34 ARM64，1920×1080 |
| 工作数据 | `.local/android-sdk`、`.local/avd`、`.local/gradle`，均忽略提交 |
| 媒体服务 | OrbStack 中 Jellyfin 10.10.7，`127.0.0.1:8096` |

## 已通过

- 基于 v0.19.10 源码的 `:app:assembleDebug` 构建成功。
- 最终预览 APK 约 90 MiB；包名 `tv.molly.app.debug`，minSdk 21，targetSdk 36。
- 模拟器安装成功，Molly 首页可启动；方向键与确定键可进入本地视频。
- 正常样本视频已显示画面，播放器控制可显示，暂停与返回可操作。
- 小猪佩奇样本实际显示英文字幕，CC 字幕选择按钮已启用；双轨完整切换场景尚未做正式验收。
- 返回后的进度保存到本地；重新打开字幕样本从已保存的位置续播。
- 修正后的播放检查未发现 MollySamplePlayer 或 AndroidRuntime 错误日志。
- 使用实际生成的 MP4 与截断文件验证导入检查：损坏输入排除，多份字幕保留，源文件不删除。回归测试通过。
- Shell 脚本语法、上游修改的空白检查通过。
- Jellyfin `/System/Info/Public` 正常响应；初始账号向导尚未配置，不声称已通过认证后的联网播放。

截图和 APK 在忽略目录 `artifacts/`；构建日志在 `.local/build-tv-final.log`。

## 输入问题

样本准备时发现以下文件 ffprobe 包扫描报错，已从预览样本排除，原文件未修改：

- 古力小超人 / Yum Yum：约 3 分钟的元数据，但有效包数据只到约 14 秒；实际播放器随后出现读取错误。
- Yakka Dee 第八季 / Talk About Breakfast。
- 小猪佩奇 第一季 / 1、Muddy puddles。

目前预览使用 Hello、Pat、Mr dinosaur is lost。未对全部 203 个 MP4 作完整验收；文件存在不等于下载完整。

## 未完成与下一阶段

- 华为 V65 的安装、系统 API、遥控器及硬件解码实测。
- Jellyfin 初始账号、正式儿童媒体库元数据、认证后的联网播放与客户端扩展验证。
- 多家庭权限原型、账号、上传后台、首页管理和正式观看统计。
- 全部资源的完整性扫描、字幕切换、倍速、连续播放及长时间运行验收。
- 正式签名、独立图标、品牌替换和分发许可检查。

源码已落地；上述事项必须按架构文档阶段验收，不因基础 APK 已运行而标记完成。
