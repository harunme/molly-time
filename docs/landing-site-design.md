# MollyTime 官网设计

当前交付为本地预览。首页收为两屏：

1. Logo 与主题切换、标题、一句说明、Android 和电视端下载、黏土故事花园。
2. iPhone 与电视双设备展示，设备下各一句说明，保留版权和说明链接。

已删除首屏网页版入口、导航、胶囊边框、手机菜单、重复标语、三步引导、FAQ 和底部宣传区。首页文案只描述已有能力，没有编造资源、用户数或价格。

深色背景沿用 TV、iOS、Android 的 `#211F1B` 暖黑色，卡片使用手机端的 `#2D2A24`，辅助色复用共享品牌深色变量。启动时的深色遮罩与 Logo 共用同一条时间轴，从深色逐渐淡至透明，首页内容全程保留在其后方；Logo 在最后一段淡去，启动结束时遮罩和 Logo 均完全透明，无额外切屏。网页本身不增加背景渐变。

## 真实设备演示

使用用户授权的实际账号录制。iOS 模拟器运行原生应用，手机只在资料库与电视 Tab 之间缓慢切换，每页停留约 6 秒；浅色与深色分别录制。采集用的定时切换只存在于 `/tmp` 中的临时工程，未改动项目 iOS 源码，录制后已恢复正常应用。电视端连接真实媒体库，用遥控方向键浏览；录制后撤销专用临时设备绑定。

官网使用无音轨的循环演示，同时提供 MP4 与 WebM，全部录屏合计约 1.4 MB。手机 MP4 约 183 KB 每份，电视 MP4 约 428 KB。进入视口后加载播放，离屏和隐藏时暂停；系统减少动态效果时只显示匹配主题的封面。可以手动暂停。手机录屏和封面随网页深浅色切换，切换时保留播放进度。电视端保持产品实际的深色界面。

素材：

- `apps/site/public/site/demos/parent-light.mp4`
- `apps/site/public/site/demos/parent-dark.mp4`
- `apps/site/public/site/demos/tv.mp4`
- `apps/site/src/assets/images/parent-ios.png`
- `apps/site/src/assets/images/parent-ios-dark.png`
- `apps/site/src/assets/images/tv-home.png`

公开素材只展示内容和应用页面，不含账号登录画面、密码或令牌。影片封面和展示内容来自实际媒体库，不代表应用预置影片。

## 插画

首屏原创黏土插画通过内置 ImageGen 生成，保留透明背景，未使用 CLI 或第三方 API 凭证。分类：illustration-story。项目路径为 `apps/site/src/assets/images/story-garden.png`。

最终生成提示词：

> Create an original premium playful clay illustration asset for MollyTime, a family video app landing page. Asset type: landscape website hero illustration with real transparent background, no text or UI mockup. A small warm butter-yellow friendly bean-shaped character holding a little white five-petal jasmine flower sits beside a beautifully rounded miniature television, the TV showing an ORIGINAL simple storybook landscape of green rolling hills, a blue river and a tiny red paper sailboat. Beside it, one small sage green rounded creature peeks from behind two colorful upright storybooks. A couple of small white clay clouds and one coral blossom float lightly around the composition. The whole arrangement feels like an art-directed little story garden, warm tactile matte clay / stop-motion miniature sculpture, soft studio light, vivid and clean yellow #F8DE7E, sage green, sky blue and coral accents, clean off-white TV frame. The characters are abstract rounded clay creatures, no existing franchise or recognizable cartoon characters. Charming for parents with young children, refined rather than babyish. Wide horizontal compact unified composition, all objects clearly within the frame, transparent negative space around the edges. Natural soft contact shadows only under the objects, no background, no gradient backdrop, no floor plane, no letters, no watermarks, no brand logo, no fake app interface, no separate floating cards or labels. Preserve vivid material colors and rich depth, do not wash out the artwork.

## 验证

以 Astro 检查、静态构建、桌面和 320px / 390px 手机截图及浏览器检查为准。浏览器检查覆盖正式 APK 频道和下载重试、首屏入口、主题、键盘入口、录屏播放与暂停、录屏主题切换和减少动态效果。截图位于 `artifacts/landing-v2/`。

最终验证：Astro 检查及静态构建通过，10 项浏览器检查通过。另用已安装的 Chrome 验证真实 MP4 的播放与深浅色切换；测试 Chromium 验证 WebM 兼容播放。浅色与深色第二屏截图为 `artifacts/landing-v2/devices-light-final.png` 与 `devices-dark-final.png`。

## 使用说明与隐私页面

使用说明按手机安装、账号登录、添加视频、安装并绑定电视、观看安排、更新六步组织，提供具体按钮名称、完成后的判断和常见问题处理。补充圈出资料库加号的真实浅色／深色截图，以及四位绑定码从电视输入手机的示意。隐私页面按资料用途、访问权限、存储位置、手机权限、删除与解绑、联系管理员说明，不虚构运营联系方式或数据删除期限。两页共用桌面侧栏目录和手机折叠目录。Astro 构建及 11 项浏览器检查通过，桌面、390px 与 320px 布局无横向溢出。截图位于 `artifacts/help-pages/`。

## 统一启动体验

复用原生客户端认可的品牌 SVG，使用相同的转正、绽花、左右摆动顺序及深色启动底色。约 1.8 秒的音效快照与当前手机端校验值一致；播放时使用音频位置驱动动画。每次进入、返回或刷新首页都展示，不使用会话次数限制；启动画面仅保留 Logo，无跳过或开启声音按钮。内页直接展示内容。支持系统减少动态效果及无 JavaScript 直接进入。浏览器拦截自动有声播放时静音完成动画；离开启动画面后不补播音效。音频和脚本加载失败均有有界退出。发布构建复用原生音效打包工具更新静态快照。

Astro 检查与构建通过，18 项浏览器检查通过，包含启动生命周期、播放限制、失效音频、缺失模块、无 JavaScript 和音效校验值。另用已安装的 Chrome 验证真实 MP3 播放和动画同步。手机与桌面启动截图位于 `artifacts/startup-mobile.png`、`artifacts/startup-desktop.png`。
