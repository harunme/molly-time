# Molly TV WebView 客户端

这是重写后的客户端：仅 ShellActivity 与 PlaybackActivity 两个 Activity，不依赖 Jellyfin SDK、Leanback 页面或上游播放模块。Gradle 只构建 `:client`，旧 `apps/tv/app` 留作历史参考。

## 构建与运行

日常界面开发使用 `bash tools/run-tv-web.sh` 在浏览器中完成，不启动 Android 客户端。发版前先构建网页，再启动或连接后台，最后构建 APK 验证：

```bash
bash tools/build-tv-web.sh
bash tools/run-server.sh
bash tools/build-tv-client.sh
.local/android-sdk/platform-tools/adb -e install -r artifacts/molly-tv-webview-debug.apk
.local/android-sdk/platform-tools/adb -e shell am start -n com.molly.tv.debug/com.molly.tv.ShellActivity
```

命令在仓库根目录运行。第一次启动输入媒体库根地址。模拟器使用 `http://10.0.2.2:8096`；真实电视使用同局域网主机地址，后台需另行绑定该局域网地址。默认账号仅供本地原型，见根 README。生产包要求 HTTPS；debug 包允许 HTTP 方便家庭实测。

调试包名为 `com.molly.tv.debug`，发布包名为 `com.molly.tv`。发布包未配置签名，需要实际发布时配置独立密钥；不使用 debug 密钥签正式包。

## 职责

- `ShellActivity`：固定媒体库 `/tv/` 网页、可信来源的 WebMessage Bridge、连接/错误页面、返回键和播放返回事件。
- `PlaybackActivity`：Media3 视频、字幕轨列表、播放器控件、服务端续播、实际播放区间心跳和退出上报、后台暂停及资源释放。
- `PlayingClock` / `WatchQueue`：单调时钟计时、暂停/缓冲不计时、区间序号和持久化重试队列。
- `SessionStore` / `MollyApi`：原生私有凭证存储、401 刷新重试、Authorization 请求头；备份禁用。网页不接收凭证。
- `BridgePolicy`：有限 API 路径和方法白名单；只允许目录读取及儿童选择，播放与进度由原生控制。

Bridge 版本为 1，消息格式 `{id, method, args}`，响应 `{id, result}` 或 `{id, error: {message, status}}`。接口包括 getCapabilities、ready、login、logout、connection、request、playEpisode。仅可信来源的主框架可调用；不支持该安全消息能力的旧 WebView 显示明确错误，不退回不受限的 JavascriptInterface。

网页封面经原生拦截请求附加 Authorization。视频与字幕也通过请求头认证，URL 不包含 token。退出原生播放器时发送 `molly:playbackClosed`，保留网页实例、路由与焦点。

## 验证与限制

```bash
cd apps/tv
./gradlew :client:testDebugUnitTest :client:lintDebug
```

debug 模式可通过 WebView 调试接口运行 `apps/tv/web/tests/smoke-android.mjs`。TV 模拟器已验证网页登录、真实目录、Hello 视频画面、退出进度及焦点恢复。华为 V65 未实测，字幕语言切换和全部编码未完整验收。

新版登录登记可撤销设备；升级前保存的管理员 TV 会话会要求重新登录。播放时每 15 秒及状态变化时结算区间，暂停、缓冲和拖动不计入观看时长；失败事件保存在本地队列，每分钟重试。系统媒体键可能被电视系统拦截，播放器支持空格播放/暂停用于键盘验证。队列限制与真实暂停验证见 [管理后台说明](../../web/README.md) 和 [验证记录](../../../docs/parent-admin-validation.md)。

网页发布后下次启动加载新入口，播放过程中不会自动刷新，返回首页更新已发布栏目。尚未实现离线网页包、自动回滚、设备二维码绑定和连续播放。
