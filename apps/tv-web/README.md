# Molly TV 网页

React + TypeScript + Vite，Norigin Spatial Navigation 管理方向键焦点。登录、首页、季列表与剧集列表使用 Molly API，网页通过受限原生 Bridge 播放视频。

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm test
```

开发地址 `http://127.0.0.1:5173/tv/`，Vite 将 `/api` 代理到本机 `8096`。浏览器支持真实账号登录与目录预览，凭证仅在内存中；视频播放需 TV 客户端。测试会启动独立 Vite 服务并验证遥控器焦点、返回、播放返回与登录错误恢复。

生产输出 `dist/`，后台启动时在 `/tv/` 挂载；可用 `MOLLY_TV_WEB_DIR` 指定部署目录。入口 HTML 禁止陈旧缓存，带哈希的资源长期缓存。部署时保留旧版资源并原子切换入口，确保旧页面仍能请求它引用的文件。`pnpm build` 只是本地构建，不等于线上原子部署。

## Android 实测

在连接模拟器、安装 debug APK、配置后台地址并打开网页后运行：

```bash
pnpm exec node tests/smoke-android.mjs
```

使用 Playwright Android 接口，默认本地测试账号 `admin` / `molly`，可用 `MOLLY_SMOKE_USERNAME` 和 `MOLLY_SMOKE_PASSWORD` 覆盖。默认使用现有资源中的 `L1开口动画 / 古力小超人 / Hello` 样本。截图写入根目录 `artifacts/`。

遥控器上下左右移动，确定打开，返回回到上一层。播放结束/退出恢复剧集卡片焦点。网页与 Bridge 主版本不兼容时提示更新 APK。
