# MollyTime 动态 Logo

保留已确认的 M 轮廓、五片大花瓣与茉莉黄，透明背景；动效从倾斜姿态转为正立。

- `preview.html`：单次预览，可重播、暂停、拖动进度和切换背景。
- `mollytime-animated.svg`：播放一次，1.8 秒后静止。
- `mollytime-animated-loop.svg`：保留旧文件名以兼容引用，内容与单次版相同，不再循环。
- `preview.gif`：历史飞旋动画，仅供旧版参考，不代表当前设计。

完整 Logo 在前 300 毫秒淡入，然后所有运动共用第 300–1800 毫秒的同一条 smoothstep 进度：整个图形从 −25° 转到 0°；M 围绕底部 (126, 213) 从 88% 等比展开到完整大小；小花围绕花心 (211, 188) 从 12% 长到完整大小，同时从 −24° 转正，五片花瓣由收拢到舒展。M 和小花同时开始、同时减速、同时结束，不再有先后停顿。结束后保持正立静态姿态，加载或启动音效仍在进行时也不重复播放。SVG 共用动画时序声明，Android 和 iOS 共用单一进度值；减少动态效果模式直接显示完整正立静态 Logo。

重新生成：`node assets/brand/mollytime-flower/motion/build-motion.mjs`。统一发布运行 `node tools/generate-brand-assets.mjs`，各端资源路径为 `brand/mollytime-animated.svg`。原生启动页分别由 Android 的 `StartupLogoView.kt` 和 iOS 的 `StartupView.swift` 绘制。
