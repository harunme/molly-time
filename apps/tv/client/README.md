# MollyTime WebView 客户端

这是重写后的客户端：ShellActivity 提供本地缓存网页与受限 Bridge，PlaybackActivity 提供原生视频播放，不依赖 Jellyfin SDK、Leanback 页面或上游播放模块。Gradle 只构建 `:client`，旧 `apps/tv/app` 留作历史参考。

## 构建与运行

日常界面开发使用 `bash tools/run-tv-web.sh` 在浏览器中完成，不启动 Android 客户端。发版前先构建网页，再启动或连接后台，最后构建 APK 验证：

```bash
bash tools/build-tv-web.sh
bash tools/run-server.sh
bash tools/build-tv-client.sh
.local/android-sdk/platform-tools/adb -e install -r artifacts/mollytime-tv-debug.apk
.local/android-sdk/platform-tools/adb -e shell am start -n com.molly.tv.debug/com.molly.tv.ShellActivity
```

命令在仓库根目录运行。构建客户端会先构建网页并将其打进 APK。首次启动默认连接 `https://mollytime.app`，网页直接显示二维码和四位配对码。用手机扫码登录家长后台并确认绑定，或在家长后台点击「绑定电视」输入配对码；电视端不输入账号密码。升级时，已绑定旧地址 `https://118.89.122.66:8096` 的安装会自动改连新域名并保留设备令牌；其他自定义地址不变。本地模拟器可手动改为 `http://10.0.2.2:8096`，真实电视也可填写同局域网主机地址。默认账号仅供本地原型，见根 README。生产包要求 HTTPS；debug 包允许 HTTP 方便家庭实测。

调试包名为 `com.molly.tv.debug`，发布包名为 `com.molly.tv`。正式包使用独立的本地签名密钥，配置步骤见下文。

## 正式包签名（release signing）

已有 `.local/signing/release.properties` 和密钥时直接执行下方打包命令，保留现有文件。新环境在仓库根目录生成密钥，仅需一次；密码由 keytool 交互询问，不放在命令参数中：

```bash
source tools/android-env.sh
mkdir -p .local/signing
keytool -genkeypair -storetype PKCS12 \
  -keystore .local/signing/mollytime-release.jks \
  -alias mollytime -keyalg RSA -keysize 3072 -validity 10000
cp tools/release-signing.properties.example .local/signing/release.properties
chmod 600 .local/signing/mollytime-release.jks .local/signing/release.properties
```

编辑 `.local/signing/release.properties`，填入 `storePassword` 和 `keyPassword`（上述 PKCS12 密钥使用同一密码），保持 `keyAlias=mollytime`。这是 Java properties 文件，密码中的反斜杠需要写成 `\\`。相对 `storeFile` 路径以 properties 文件所在目录为基准。CI 可通过 `MOLLYTIME_SIGNING_PROPERTIES` 指定外部配置文件；相对的配置文件路径以 `apps/tv` 为基准。

```bash
bash tools/build-tv-client.sh release
```

脚本验证 APK 签名后输出 `artifacts/mollytime-tv-release.apk`。默认 `bash tools/build-tv-client.sh` 仍构建 debug；缺少签名配置不会影响 debug，但 release 会明确失败，不输出未签名正式包。直接执行 Gradle `:client:assembleRelease` 或 `:client:bundleRelease` 同样要求签名配置。

密钥和真实配置禁止提交，需另行加密备份并保存密码。手动出包保持包名和签名密钥，递增 `client/version.properties` 中的 `versionCode` 并更新 `versionName`。CI 会按原生输入指纹自动判断是否出包并分配更大的构建号，见 [流水线说明](../../../docs/deployment.md#自动判断与发布-tv-apk)。debug 与 release 是不同应用，首次安装正式包需要重新配对。正式包仅允许 HTTPS 后台。

## 职责

客户端 APK 更新发布、本地服务器和私有 OSS 的操作见 [TV 自动更新说明](../../../docs/tv-client-updates.md)。

- `ShellActivity`：从 APK 资源或按服务器隔离的本地网页缓存加载 WebView；提供可信来源的 WebMessage Bridge、返回键、网页更新下载及客户端更新安装协调。
- `WebBundleStore`：校验网页更新清单、包大小和 SHA-256，安全解压并在下次启动原子切换；保留旧版本回退。
- `ClientUpdateInstaller`：将已校验 APK 交给 Android PackageInstaller；检查与下载状态由网页呈现。
- `PlaybackActivity`：Media3 视频、字幕轨列表、播放器控件、服务端续播、实际播放区间心跳和退出上报、后台暂停及资源释放。
- `PlayingClock` / `WatchQueue`：单调时钟计时、暂停/缓冲不计时、区间序号和持久化重试队列。
- `SessionStore` / `MollyTimeApi`：原生私有凭证存储、401 刷新重试、Authorization 请求头；备份禁用。网页不接收凭证。
- `BridgePolicy`：有限 API 路径和方法白名单；允许目录读取、儿童选择及 `/api/settings/playback` 的 GET/PUT，播放与进度由原生控制。

Bridge 版本为 1，消息格式 `{id, method, args}`，响应 `{id, result}` 或 `{id, error: {message, status}}`。接口包括 getCapabilities、ready、connect、checkWebUpdate、pairingStart、pairingPoll、pairingCancel、pairingReset、request、playEpisode、checkUpdate、downloadUpdate、installUpdate。网页运行在固定的 `https://appassets.androidplatform.net` 来源；仅该来源的主框架可调用。网页包声明 Bridge 兼容范围，不兼容时保留当前版本并提示更新 APK。不支持安全消息能力的旧 WebView显示明确错误，不退回不受限的 JavascriptInterface。

网页封面经原生拦截请求附加 Authorization。视频与字幕也通过请求头认证，URL 不包含 token。退出原生播放器时发送 `molly:playbackClosed`，保留网页实例、路由与焦点。网页包从当前媒体库服务器 `/tv/web-release.json` 和 `/tv/web-bundle.zip` 获取，按服务器 origin 缓存；下载校验成功后下次启动生效。

默认字幕在 TV 设置和管理后台家庭设置中共享，可选中文、英文、中英文或关闭。新家庭默认为中文；没有匹配类型时关闭字幕，中英文需要双语字幕文件。资源库仅维护字幕文件、类型、名称及时间偏移，旧文件默认标记不再决定播放选择。播放时按遥控器菜单键可选择字幕及 0.5×、0.75×、1×、1.25×、1.5×、2× 速度，临时选择只影响当前视频；刷新播放地址保留选择，下一集重新应用家庭默认字幕并恢复 1×。

## 验证与限制

```bash
cd apps/tv
./gradlew :client:testDebugUnitTest :client:lintDebug
```

debug 模式可通过 WebView 调试接口运行 `apps/tv/web/tests/smoke-android.mjs`。TV 模拟器已验证网页登录、真实目录、Hello 视频画面、退出进度及焦点恢复。华为 V65 未实测，字幕语言切换和全部编码未完整验收。

新版登录登记可撤销设备；升级前保存的管理员 TV 会话会要求重新登录。播放时每 15 秒及状态变化时结算区间，暂停、缓冲和拖动不计入观看时长；失败事件保存在本地队列，每分钟重试。系统媒体键可能被电视系统拦截，播放器支持空格播放/暂停用于键盘验证。队列限制与真实暂停验证见 [管理后台说明](../../web/README.md) 和 [验证记录](../../../docs/parent-admin-validation.md)。

播放器错误会单独保存在电视本地队列，通过已绑定设备的令牌上报至 `/api/device/error-logs`，断网后每分钟重试。仅上传错误码、异常类型、播放位置、HTTP 状态、剩余空间和客户端版本；不上传异常消息、播放 URL 或令牌。管理后台独立的“系统日志”菜单仅平台超管可见，显示所有家庭最近 30 天的记录；每台设备最多接收每小时 60 条。

网页发布后客户端后台下载并校验，本地版本在下次启动生效；启动失败会回退到上一个有效版本或 APK 内置版本。未绑定时直接展示二维码和配对码，过期后可用遥控器重新生成；确认绑定后自动进入内容页。

## 扫码授权

`pairingStart`、`pairingPoll`、`pairingCancel`、`pairingReset` 是原生 Bridge 的独立方法；通用 `request` 不允许访问认证接口。原生保存高熵配对秘密及领取后的访问/刷新凭证，只向网页返回公开短码、二维码和状态。使用旧 Bridge 的 APK 必须更新后才能扫码绑定。

配对时优先使用系统设备名称；名称与型号相同（忽略大小写）或不可用时，使用厂商与型号，例如 `HUAWEI THAL-560`，型号已带厂商前缀时不重复添加。自定义名称原样保留。名称在绑定时保存，已绑定设备可在家长后台改名，不随电视连接自动更新。

发版前实机验证：手机扫描 → 家长登录和确认 → TV 自动进入片单 → 重启仍保持授权 → 家长撤销后 TV 重新配对；同时检查过期码刷新、取消与网络重试。日常验证不启动 Android 客户端。

配对凭证保存在原生私有存储，并按后台地址保留；重启或切回原后台自动恢复。设备凭证无三十天到期限制，短期令牌自动刷新。TV 设置提供“重新配对”，确认后解除自身绑定再显示新码；家长网页仍可远程取消。
