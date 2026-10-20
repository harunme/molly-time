# MollyTime 电视端

电视端由网页界面和轻量 Android 客户端组成，共用 `apps/server/` 后台。家长管理网页位于 `apps/web/`。

| 目录 | 用途 |
| --- | --- |
| [`web/`](web/README.md) | React TV 界面、遥控器焦点导航，构建输出 `web/dist/` |
| [`client/`](client/README.md) | Kotlin WebView 壳子与原生 Media3 播放器，Gradle 模块 `:client` |
| `app/`、`playback/`、`preference/` | 上游历史代码，保留作参考，未纳入当前构建 |
| `gradle/`、`build.gradle.kts`、`settings.gradle.kts` | Android 构建配置与工具 |

日常开发在仓库根目录执行，只启动 TV 网页服务：

```bash
bash tools/run-tv-web.sh
```

打开 `http://127.0.0.1:5173/tv/` 在浏览器中调试。真实登录和目录使用已有 MollyTime API，默认代理本机 `8096`；需要时可单独运行本地 Python 后台。日常不启动 Docker、Android 模拟器或客户端。

发版前构建网页和 APK，使用 Android 客户端验证 WebView 与原生播放。完整步骤见[项目说明](../../README.md)和[客户端说明](client/README.md)。生产环境由后台在 `/tv/` 提供构建后的静态文件。

上游版权与许可证保留于 [LICENSE](LICENSE)，原始项目说明完整保留于 [README.upstream.md](README.upstream.md)，来源及历史修改见[上游说明](../../docs/upstream.md)。

## 电视直播（实验）

平台超管在管理后台「运营设置 → 电视直播」导入公网 M3U/TXT 订阅地址或列表文件。
导入成功会替换平台列表并开启直播，供所有已绑定电视读取；普通家庭账号和 TV Bridge
无权修改订阅。默认不开启。支持手动刷新订阅、关闭直播；导入失败保留旧列表。
列表上限 2 MB / 2000 个频道，重复 URL 和无效条目会跳过。

TV 入口为「设置 → 电视直播（实验）」，支持分组、分页、遥控器选择频道和返回焦点恢复。
Android 使用独立 Media3 HLS 播放器，按返回回到频道列表换台，按确定重试；不写入点播缓存。
直播会话独立标记为 live_tv，播放事件仅用于会话状态和控制；不计入现有观看时长统计、
概览、观看记录或本次开机累计时长，不生成剧集续播记录。早期实验版直播记录也从统计中排除。
单次观看最长 30 分钟；休息提醒非 idle 时禁止进入，播放中每 5 秒检查运营开关、授权和休息状态。
普通网络错误会暂停或显示重试提示。服务端不代理或转码视频，频道由电视直接访问。

浏览器预览支持 HLS.js，但源站仍须允许 CORS；HTTPS 页面不能播放 HTTP 源。
为支持 HTTP 直播源，APK 开启原生明文流量；正式版后台连接继续由 SessionStore 限定为
官方 HTTPS 地址，WebView 仍禁止混合内容。直播不携带后台凭证，即使发生重定向也不附带认证头。
网页可通过已有更新机制发布，原生直播功能需升级 APK；旧 APK 会提示升级。

发布前需在实际电视和家庭网络验证 HTTP/HTTPS HLS、IPv6、编码兼容、换台、断线重试、
后台恢复、家长停止和观看计时。网页测试与 Android 编译不能证明第三方频道实际可播。
第一版不含 EPG、回看、录制、自动订阅刷新和自定义请求头。
