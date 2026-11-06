# MollyTime 官网

官网由 Astro 静态生成，面向家长介绍家庭视频整理与电视观看。首页使用原创黏土故事花园、茉莉黄、鼠尾草绿与真实 iOS、电视端录屏，兼顾手机与桌面。页面文案只介绍已有能力，保留内容需由家长自行添加的说明。

顶部仅保留 Logo 和主题切换，无胶囊边框和手机菜单。首屏仅保留标题、一句说明和下载入口，功能文案采用简短表达。

首页仅保留两屏内容：首屏介绍与 Android、电视端下载，第二屏展示 iPhone 与电视的真实应用录屏。另保留隐私与数据、使用说明和品牌 404 页面。

每次进入或刷新首页时，播放与 TV、手机端一致的 Logo 转正、绽花与摆动动画（约 1.8 秒）和启动音效，不再按标签页限制次数。深色遮罩随 Logo 的同一时间轴逐渐透明，首页从后方自然显露；Logo 在末段淡去，结束时直接释放页面，不另起一段切屏。启动画面仅保留动画 Logo，无跳过或开启声音按钮；使用说明与隐私等内页直接展示内容。浏览器允许时自动有声播放，拦截声音时静音完成动画并正常进入。声音只在启动画面内播放，音频失败、网络缓慢或后台切换均不会卡住页面或延后响起。系统减少动态效果时展示静态 Logo，保留透明度过渡。

```bash
pnpm --dir apps/site install --frozen-lockfile
make site       # http://127.0.0.1:4321
make build-site # apps/site/dist，并复制至 apps/web/dist/site
MOLLYTIME_SITE_TEST_PORT=4327 pnpm --dir apps/site test
```

浏览器测试使用已构建的静态页面，覆盖手机布局、精简页头、主题、键盘入口、动效偏好和下载频道校验。若 4321 已有开发服务，测试时使用上面的独立端口。

`make dev` 会同时启动官网、家长端、TV 和 API，并开启源码热更新。单独 `make site` 时，`/api`、`/manage` 和 `/tv` 代理给 `http://127.0.0.1:8096`，可通过 `MOLLYTIME_API_PROXY` 覆盖。没有 API 也可预览官网，登录和下载需要后台。

生产环境通过 FastAPI 挂载到 `/`，其余路由优先于官网。官网目录默认位于 `MOLLYTIME_PARENT_WEB_DIR/site`，可用 `MOLLYTIME_SITE_WEB_DIR` 单独指定。`tools/build-web.sh`、Docker 构建和 GitHub 发布流程均包含官网。

## 实现与素材

- `src/pages/index.astro`：文案、页面结构、WebSite 结构化数据、悬浮和滚动交互。
- `src/layouts/HelpLayout.astro` 与 `src/assets/styles/help.css`：使用说明、隐私与数据的共享阅读布局；电脑侧栏目录、手机折叠目录、编号操作、真实入口配图与问题处理。
- `src/components/landing/`：页头、下载、双设备演示与页脚；`src/assets/styles/landing.css`：字体、间距、主题与响应式样式。
- `StartupIntro.astro` 与 `src/scripts/startup-intro.ts`：复用 `assets/brand/mollytime-animated.svg`，由音频时钟同步动画；无 JavaScript 时直接展示页面，模块未加载时也有独立退出兜底。`src/assets/startup/` 保存已校验的音效快照，静态构建输出带内容哈希的资源，无需运行时请求启动配置。`tools/build-site.sh` 在发布时沿用原生客户端的打包工具更新快照，支持 `MOLLYTIME_STARTUP_SOURCE` / `MOLLYTIME_STARTUP_CONFIG`；单独 `pnpm build` 使用本地快照。
- 字体使用自托管 Manrope，中文使用系统字形；图标使用 Phosphor。底层保留 AstroWind 工具组件与 MIT 许可，首页不再使用原版模板布局。
- `src/assets/images/story-garden.png`：通过内置 ImageGen 生成的透明原创黏土插画，提示词与设计说明见 `docs/landing-site-design.md`。
- `src/assets/images/parent-ios.png` 与 `parent-ios-dark.png`：真实 iOS 录屏的浅色、深色首帧。`tv-home.png`：真实电视端首帧。
- `public/site/demos/parent-light.mp4`、`parent-dark.mp4`：每个页面停留约 6 秒，只切换资料库和电视 Tab。`tv.mp4`：真实电视端浏览录屏。录制使用经授权的账号，公开文件不含账号登录信息；录制使用的临时电视绑定已撤销。
- 录屏同时提供 MP4 与 WebM，按浏览器编解码支持选择。设备演示进入视口后才加载并静音播放，离屏、隐藏或系统减少动态效果时暂停；可以手动暂停。切换网页主题时，手机的封面和录屏同步切换，保留播放位置。电视端沿用应用实际的深色界面，机身和周边样式适配网页主题。
- 图片由 Astro 输出响应式 WebP，首屏插画优先加载，其余图片延迟加载。没有外部图片请求或动效库。悬浮在离屏或标签页隐藏时暂停，减少动态效果时展示静态完整内容。

## 下载与分享

点击下载时读取 `/api/client/releases/latest?packageName=…`，Android 家长端使用 `com.molly.parent`，电视端使用 `com.molly.tv`。按钮有获取中、未发布、失败和重试提示，只接受同源且符合所选正式频道路径的安装包地址。后续发版不需要修改官网链接。

分享图保存在 `src/assets/images/share.png` 与 `public/site/share.png`。本地官网启动后运行 `node apps/site/scripts/share.mjs`，再重新构建。脚本使用首页的相同内容，将首屏排成 1200×630 分享画布。
