# TV 客户端更新发布

客户端 0.4.0（versionCode 3）开始支持启动检查和设置页“检查更新”。旧 APK 需先手动安装这一版。网页更新仍通过部署 `/tv/` 静态资源完成；原生播放器和 Bridge 更新走 APK 安装。

## 发布到本地服务器

在仓库根目录运行：

```bash
bash tools/build-tv-client.sh release
bash tools/publish-tv-release.sh --notes "新增客户端更新功能"
```

发布工具先验证 APK 签名，再读取包名、versionCode、versionName 和 minSdk，计算 SHA-256；复制到不可变路径，最后原子更新版本清单。默认数据目录与 `tools/run-server.sh` 一致，为 `.local/molly-server`；可用 `MOLLYTIME_DATA_DIR` 指定 API 实际使用的目录。

```text
<data_dir>/client-releases/com.molly.tv.json
<data_dir>/client-releases/releases/tv/com.molly.tv/3/<sha256>.apk
```

首次上线需要部署新的 Python API 代码和 TV 网页构建产物，重启 API，再手动安装 `artifacts/mollytime-tv-release.apk`。远程服务器部署时，将上述 `client-releases` 目录完整复制到服务端实际数据目录；先传 APK，再替换清单。发布清单无需重启即可生效。正式客户端必须连接 HTTPS 后台。

## 发布到私有 OSS

沿用服务端运营设置或环境变量中的 OSS 凭据，在能访问对应配置和数据库的环境执行：

```bash
bash tools/publish-tv-release.sh --storage oss --notes "修复播放器问题"
```

APK 对象路径为 `releases/tv/<packageName>/<versionCode>/<sha256>.apk`。将 RAM 身份权限增加到 `releases/tv/*` 的上传和读取（包括 HEAD），保留 Bucket 私有权限。API 每次检查签署短期 HTTPS 下载地址，不给电视下发长期 OSS 密钥，电视下载不携带 Molly 登录令牌。发布工具上传及核验大小成功后才更新清单；上传失败保留上一版。

OSS 发布的版本清单也存于 API 的 `client-releases` 数据目录。若在本机发布到云端 OSS，还需将 `com.molly.tv.json` 原子部署到远程 API 的数据目录；API 必须使用同一 Bucket/Endpoint。

直接运行 Python 发布模块可指定 APK 和 Android build-tools 路径，也可发布独立 debug 通道。在 Bash 中执行：

```bash
source tools/android-env.sh
export PYTHONPATH="$PWD/apps/server"
export MOLLYTIME_DATA_DIR="$PWD/.local/molly-server"
apps/server/.venv/bin/python -m mollytime_server.scripts.publish_tv_release \
  artifacts/mollytime-tv-debug.apk --storage local \
  --build-tools "$ANDROID_HOME/build-tools/36.0.0" --notes "测试更新"
```

长更新说明可用 `--notes-file` 指定 UTF-8 文件。手动出包时递增 `apps/tv/client/version.properties` 中的 versionCode，持续使用原有正式签名密钥；重复发布相同版本、相同文件和说明是幂等操作，同一 versionCode 换包会被拒绝。签名密钥生成及备份见 [客户端说明](../apps/tv/client/README.md)。

GitHub Actions 已接入原生输入指纹判断、自动构建号、签名和发布，见 [流水线说明](deployment.md#自动判断与发布-tv-apk)。网页/API-only 变更跳过 APK；正式包的 `sourceFingerprint` 和 `sourceCommit` 仅在 CI 发布验证通过后记录。后台重复上传同一 APK 会保留原有 CI 来源信息。

## 接口与安装行为

- `GET /api/client/releases/latest?packageName=com.molly.tv`：返回 `{ "release": null }` 或版本、大小、SHA-256、更新说明和下载 URL；debug 使用 `com.molly.tv.debug`。
- `GET /api/client/releases/<packageName>/<versionCode>/<sha256>.apk`：本地发布的 APK 下载入口，限制为当前已发布版本。
- 发布接口公开可读，以便尚未配对的电视升级；无在线写入接口。API 响应禁止缓存。
- 启动检查只提示新版本，播放期间延后到返回媒体库；“稍后”可跳过本次提示。关闭应用期间不检查。
- 遥控器确认下载后显示进度，限制 APK 最大 512 MiB，预留下载和安装空间；失败可重新检查重试，返回取消下载。下载不支持断点续传。
- 安装前核验大小、SHA-256、包名、versionCode 和当前签名证书集合，拒绝跨 debug/release 包、降级和换签名。第一版不支持签名密钥轮换。
- Android 8+ 首次引导允许“安装未知应用”；确认后调用 PackageInstaller，由系统提供安装确认及结果。取消安装或失败可以重新检查。系统可能在覆盖更新时结束当前进程，之后从桌面重新打开应用。
- 没有发布版本、旧服务端返回 404、检查网络失败都不会阻止启动和播放；手动检查会显示网络或配置错误。

上线前必须在真实电视验证更新提示、遥控器操作、安装授权、取消/失败、覆盖安装后配对及缓存保留。构建、单元测试和浏览器测试不能替代系统安装器实测。

## 运营后台安装包列表

超管登录 `/manage/` 后进入 **运营设置 → 客户端版本**，可查看版本、构建号、正式版/debug 渠道、发布时间、更新说明、文件大小、服务器/私有 OSS 存储位置、SHA-256 与当前发布状态。支持渠道筛选、分页、刷新及历史包下载。家庭管理员、成员和 TV 设备凭证不能访问列表或历史包下载接口。

发布工具现在将每个版本的记录保存在：

```text
<data_dir>/client-releases/history/<packageName>/<versionCode>/<sha256>.json
```

远程部署和备份时保留整个 `client-releases` 目录，包括历史记录；旧的当前版本清单可直接显示，缺少的发布时间显示“未记录”。本次接入前未保存记录的旧 APK 不能仅凭文件路径恢复完整版本信息，不会被自动列为已发布版本。相同安装包迁移到 OSS 或重复发布保留首次记录的发布时间，不增加重复行。

历史包下载通过超管会话授权；OSS 地址在点击下载时签署。当前版本的公开 TV 更新接口不开放历史包。缺失的本地文件会标记“文件缺失”并禁用下载；损坏的版本记录显示警告，其他有效记录仍可查看。保存 OSS 配置时会检查历史安装包引用，仍有云端安装包时禁止直接切换 Bucket 或地域。

新增管理接口：

- `GET /api/manage/operations/client-releases`：支持 `packageName`、`page`、`pageSize`，返回安装包列表、总数、当前发布标记和损坏记录数量。
- `GET /api/manage/operations/client-releases/<package>/<version>/<sha256>/download-url`：返回经授权的本地下载入口或短期 OSS 地址。
- `GET /api/manage/operations/client-releases/<package>/<version>/<sha256>/file`：下载本地安装包，需超管登录会话。

也可以在本页展开 **上传 APK**，选择已签名安装包、服务器或私有 OSS，填写更新说明，点击 **上传并发布**。服务端自动读取包名、版本、构建号及签名证书，计算 SHA-256；通过验证后保存到目标存储，加入历史并设为当前发布版本。支持上传进度、传输阶段取消和失败重试。包名只能是 `com.molly.tv` 或 `com.molly.tv.debug`，最大 512 MiB，不需要手工填写版本或哈希。

同一渠道已记录签名证书后，新包必须使用相同证书；首次上传会建立证书记录，旧清单没有证书时从该次成功发布开始记录。电视安装前仍会验证与实际已安装包的签名一致。相同构建号可以重复上传同一 APK 或迁移存储位置，不能替换成另一个文件。上传或 OSS 保存失败保留当前发布版本；命令行发布继续可用。

### 服务端上传依赖

服务端需要运行平台兼容的 Android build-tools（`apksigner`、`aapt`）和 Java。本机默认使用仓库 `.local/android-sdk/build-tools/36.0.0`；远程部署通过环境变量配置并重启 API：

```dotenv
MOLLYTIME_ANDROID_BUILD_TOOLS_DIR=/opt/android-sdk/build-tools/36.0.0
MOLLYTIME_ANDROID_JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
```

Java 路径按实际安装位置填写，也可以使用服务端已有的 `JAVA_HOME`/`PATH`。只需要校验工具和运行环境，不需要模拟器、Android 客户端或签名私钥；上传的是已签名 APK。工具不可运行时，上传入口会提示配置问题。

反向代理需允许 512 MiB 请求体，并给上传与校验留出时间。例如 Nginx 的对应 API location 可配置 `client_max_body_size 512m`、`proxy_read_timeout 1200s` 和 `proxy_send_timeout 1200s`。选择 OSS 时先在“文件存储”配置访问凭据与 `releases/tv/*` 的读写权限。

上传接口：`GET .../upload-options` 查询能力，`POST .../uploads` 创建超管所属任务，`PUT .../uploads/<id>` 流式上传并发布，`DELETE .../uploads/<id>` 取消尚未开始的任务。所有写入接口校验登录会话、超管权限、请求来源和 CSRF；任务有效期一小时。APK 临时文件在正常结束、失败或传输取消后清理。发布和存储配置修改共享文件锁，防止上传过程中切换 Bucket。
