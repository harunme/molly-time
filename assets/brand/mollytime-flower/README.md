# MollyTime · 茉莉 m Logo 套件

2026-10-30 定稿。采用用户确认的圆润小写 m 图形与五片大花瓣，不含花心和细碎瓣缝；字标采用 Nunito ExtraBold（800 字重），按字母对调整间距，保留圆润端点与柔和转折，已全部转为 SVG 路径，使用时无需安装字体。字体来源为 Google Fonts（https://github.com/google/fonts/tree/main/ofl/nunito），使用 SIL Open Font License 1.1；交付套件不分发字体文件。产品界面正文使用项目既有字体。

## 网页使用

将 `web/` 内文件一同放至网站的 `/brand/` 路径，参考 `web/head-snippet.html`。manifest 图标使用相对路径。`start_url` 为 `/`，用于 TV `/tv/` 或家长端 `/manage/` 时应按实际入口设置。

普通图标已有圆角，采用茉莉白背景、茉莉黄 m 与花。maskable 图标提供整块背景和额外安全留白，供平台裁切。平台使用方式取决于各端入口和资源配置。

## 源文件和再生成

- `source/symbol.svg`：用户确认的图形母版。
- `source/wordmark.svg`：已转路径的字标母版。
- `build-kit.mjs`：由以上两个母版生成套件。

从仓库根目录运行：

```sh
node assets/brand/mollytime-flower/build-kit.mjs
```

脚本使用项目 `apps/site` 已安装的 sharp，不额外下载依赖。展示图中的电视、官网、家长后台等为排版示意，并非产品页面截图。

## 验证

图形路径与用户确认稿一致。所有正式 SVG 不含实时文字、字体引用、位图、描边、蒙版或滤镜。已渲染查看横版、竖版、反白、图标与使用规范，检查网页图标尺寸、manifest 和 ICO 目录。

Jev usage: Not used。定稿与排版由 Codex 完成，路径复制、尺寸生成和文件验证使用确定性代码。
