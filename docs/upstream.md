# 开源基线

客户端源码位于 `apps/tv`，以源码快照方式纳入本仓库，保留上游 LICENSE、版权说明和 README，不依赖嵌套 Git 仓库。

- 仓库：https://github.com/jellyfin/jellyfin-androidtv
- 标签：v0.19.10
- commit：984181a3d6ab14e9a6d2dcc850c582e1c138bd95
- 许可证：见 `apps/tv/LICENSE`，分发前同时核对依赖和源码提供义务。
- 原始 Git 元数据暂保存在忽略目录 `.local/tv-upstream.git`，仅供本机对照。

本地修改：应用 ID、显示名称、Molly 预览入口与本地样本播放诊断。服务器连接、认证、详情和播放链路保留上游实现。样本播放器使用已有 Media3 依赖，仅用于离线验证，并未声称复用完整服务端播放策略。尚未移植 Just Player 代码。

预览没有真实账号、家庭隔离或后台统计；不得作为多用户服务发布。应用图标及服务器界面暂保留上游样式，品牌替换在后续完成。
