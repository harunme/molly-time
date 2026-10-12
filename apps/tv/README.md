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
