# WebView 客户端验证

日期：2026-10-11。此记录对应重写后的客户端，不沿用历史 Jellyfin fork 的验收结果。

## 已完成

- 删除原 Login/Home/Series/Player 客户端代码，改为 ShellActivity + PlaybackActivity。
- Gradle 只包含 `:client`，运行依赖为 AndroidX WebKit、Media3、OkHttp 与基础 AndroidX，无 Jellyfin SDK/播放模块。
- TV 网页：登录、首页、季列表、剧集列表、儿童选择、遥控器焦点与返回恢复。
- 后台：`/tv/` 静态网页、入口 no-store/哈希资源缓存；视频分块读取与 Range；字幕归属校验；基础儿童/账号续播。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | TypeScript 与生产构建通过；JS gzip 约 83 KiB |
| Playwright 网页回归 | 2 项通过：方向键、路由返回、播放返回焦点、儿童选择、退出、登录失败恢复 |
| Python 后台测试 | 16 项通过：Range/HEAD/错误边界、分块、路径边界、字幕与儿童归属、续播、缓存/CORS |
| Android Bridge 单测 | 3 项通过：凭证端点/跨域路径/路径编码拒绝、限制写操作、目录读取 |
| Android debug APK 与 lint | 构建成功，无 lint 错误；仍有依赖版本提示及一般警告 |
| Android TV API 34 模拟器 | 真实账号登录、目录读取、Hello 视频画面、退出焦点恢复、API 白名单拒绝通过 |
| 退出续播 | 后台记录非零退出位置，再次打开从已存位置继续 |

debug APK 约 8 MiB，输出 `artifacts/molly-tv-webview-debug.apk`。网页与真实播放截图在 `artifacts/`，运行说明见 [客户端 README](../apps/tv/client/README.md)。

## 未完成或未验收

- 华为 V65 安装、WebView 能力、遥控器、硬件解码、休眠/唤醒和长时间运行。
- 全部媒体编码、字幕语言切换、异常断网与长视频令牌到期行为。
- 网页包下载、签名验证、自动回滚；目前为在线网页，下次启动加载新入口。
- 设备二维码绑定、上传与家长管理、连续播放、离线进度补传、正式观看时长统计。
- Docker 镜像构建与生产 TLS/签名发布未实测；Dockerfile 已加入网页构建阶段。

当前原生事件用于续播；不承诺去重后的观看时长或严格儿童访问限制。后台仍需多家庭完整验收。

Jev usage: Not used；实现、测试与排错由 Codex 完成，权限、Bridge 校验、焦点导航和 Range 均采用确定性代码。
