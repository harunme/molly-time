# MollyTime 动态 Logo

保留已确认的 M 轮廓、五片大花瓣与茉莉黄，透明背景；动效从倾斜姿态转为正立。

- `preview.html`：单次预览，可重播、暂停、拖动进度和切换背景。
- `mollytime-animated.svg`：播放一次，1.8 秒后静止。
- `mollytime-animated-loop.svg`：保留旧文件名以兼容引用，内容与单次版相同，不再循环。
- `preview.gif`：历史飞旋动画，仅供旧版参考，不代表当前设计。

总时间线保持 1.8 秒，M 随 /t/ 起音形成一股左 → 右 → 左的衰减波浪，拱顶的原始圆弧和水平切线保持不变：

- 前 300 毫秒淡入；240–600 毫秒快速转正；300–1120 毫秒小花重叠展开。
- 左侧在约 890 毫秒的 /t/ 起音处长大，990 毫秒成为第一道波峰。
- 右侧从 970 毫秒接上，在 1100 毫秒抬高，左侧同时轻轻落回。
- 1220 毫秒左侧再抬一次、右侧回落，形成清楚的第三下起伏。
- 1340 毫秒只留一小下右侧余弹；1460 毫秒恢复等高，静止至 1800 毫秒。

三次主波峰的过冲依次减小（展开进度 1.22、1.18、1.14），中央凹口平滑连接左右高度，花心跟随右侧弧口。起始与最终两侧等高，错峰高低差只存在于运动中。SVG 每 10 毫秒采样与 Android、iOS 相同的两条关键帧曲线；减少动态效果模式直接显示最终静态 Logo。预览可重播当前包内音效。

重新生成：`node assets/brand/mollytime-flower/motion/build-motion.mjs`。统一发布运行 `node tools/generate-brand-assets.mjs`，各端资源路径为 `brand/mollytime-animated.svg`。原生启动页分别由 Android 的 `StartupLogoView.kt` 和 iOS 的 `StartupView.swift` 绘制。
