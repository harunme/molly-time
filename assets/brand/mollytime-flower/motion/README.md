# MollyTime 动态 Logo

保留已确认的倾斜 M、五片大花瓣与茉莉黄，透明背景。

- `preview.html`：循环预览，可重播、暂停、拖动进度和切换背景。
- `mollytime-animated.svg`：播放一次，2.8 秒后停回原位。
- `mollytime-animated-loop.svg`：循环版，含结尾停顿。
- `preview.gif`：旧版动画参考，尚未包含弧口跟随与伸缩幅度优化；深色背景。

小花沿 M 右侧的弧线自转上扬，再沿弧线回落，上升和下降各转一圈，飞行距离扩大至原版的 115%；M 配合最大 5% 的纵向压缩、拉伸和衰减回弹。右下弧口始终保留凹弧轮廓：起飞后轻抬 3–4 个设计单位，随后归位；花落下后轻压 2 个单位，再缓缓回弹。花在起飞前随 M 轻沉蓄力；72% 落回原位后才开始承重，76% 轻压、88% 回弹、94% 稳定。花瓣只平移，不随 M 挤压变形。SVG 动画使用 CSS，不依赖 JS 或外部资源，支持 `prefers-reduced-motion`，该模式直接显示静态 Logo。

重新生成：`node assets/brand/mollytime-flower/motion/build-motion.mjs`。统一发布运行 `node tools/generate-brand-assets.mjs`，各端资源路径为 `brand/mollytime-animated.svg`。本次仅交付动画资源与预览，未将现有页面自动切换为动画。
