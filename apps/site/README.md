# MollyTime 官网

直接使用 [AstroWind](https://github.com/arthelokyo/astrowind) 原版组件、布局、字号、圆角按钮、配图和深浅色主题。替换品牌文案、导航链接与产品功能内容。主题主色与家长后台、Logo 一致，为 #22864B 茉莉清绿，按钮和图标配 #FFFFFF 纯白前景；悬停使用 #1D7541 深绿以保持文字对比度。MIT 许可保留于 `LICENSE`。

原版组件位于 `src/components/`，样式位于 `src/assets/styles/`，配置加载器位于 `vendor/integration/`。为兼容现有 Node 22.22.1，运行在 Astro 5.18.2，Inter 改为本地字体包；页面保持原版呈现。

```bash
pnpm --dir apps/site install --frozen-lockfile
make site       # http://127.0.0.1:4321
make build-site # apps/site/dist，并复制至 apps/web/dist/site
pnpm --dir apps/site test # 在构建后验证静态页面及下载逻辑
```

`make dev` 会同时启动官网、家长端、TV 和 API，并开启源码热更新；官网的 `/manage`、`/tv`（含 WebSocket）连接对应 Vite 开发服务。

单独运行 `make site` 时，开发服务把 `/api`、`/manage` 和 `/tv` 代理给 `http://127.0.0.1:8096`，可通过 `MOLLYTIME_API_PROXY` 覆盖。未启动 API 时，页面仍可预览，登录和下载需要后台。

生产环境通过 FastAPI 挂载到 `/`，其余路由优先于官网。官网文件默认位于 `MOLLYTIME_PARENT_WEB_DIR/site`，可用 `MOLLYTIME_SITE_WEB_DIR` 单独指定。未构建官网时保留原有根路径 JSON 响应。`tools/build-web.sh`、标准 Docker 构建和 GitHub 发布流程均包含官网；现有预构建镜像和受限发布接收器无需新增目录白名单。

下载按钮按点击读取 `/api/client/releases/latest` 的正式频道。未发布、超时和失败都有提示，重试无需刷新页面。只接受同源、符合现有 API 路径的安装包地址。

配图沿用 AstroWind 模板，原版 Unsplash 照片下载到本地，避免加载外部图片。文案围绕已有功能，不承诺预置内容或所有品牌电视兼容。首页精简为首屏、核心功能、开始使用和 FAQ。安装包下载由首屏按钮直接触发，没有底部下载卡片和页脚。

`src/assets/images/share.png` 是社交分享预览图，`public/site/share.png` 保留一份直链副本。页面设计变化后，启动 `make site`，运行 `node apps/site/scripts/share.mjs` 重新导出，再构建。

安装步骤旁的动画拼图 `src/assets/images/children-cartoons.jpg` 来自 [Espinof 儿童动画专题](https://www.espinof.com/listas/mejores-series-infantiles-netflix-hbo-disney-movistar-amazon-prime)，包含小猪佩奇、米奇、汪汪队等角色；这是第三方配图，不属于 AstroWind 的 MIT 源码许可。图片生成工具未成功产出角色合照，因此使用现有拼图素材。
