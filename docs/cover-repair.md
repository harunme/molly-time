# 修复自动生成的黑色封面

新上传的视频会从 3 秒、10%、25%、50%、75% 处依次取样，跳过接近纯黑的帧。
短视频的采样点会限制在时长内。所有样本都接近纯黑时，不创建封面，前端显示占位背景。
检测只拒绝接近纯黑的画面，并不评判画面内容是否适合当海报。

存量修复命令默认只检测，不修改数据。只处理能通过上传记录和确定性 ID 确认来源的自动封面；
手动上传的封面不会被修复。运行前应更新生产镜像，确保镜像包含 `repair_covers` 模块。

在生产仓库根目录执行（短暂停服，避免上传或封面编辑与修复并发）：

```bash
docker compose -f infra/compose.production.yaml stop mollytime-server
docker compose -f infra/compose.production.yaml run --rm --no-deps mollytime-server python -m mollytime_server.repair_covers
```

检查输出中的 `would-repair` 条目，再执行：

```bash
docker compose -f infra/compose.production.yaml run --rm --no-deps mollytime-server python -m mollytime_server.repair_covers --apply
docker compose -f infra/compose.production.yaml up -d mollytime-server
```

如只修复一个视频，在命令末尾加 `--item-id 视频ID`（不是文件夹 ID）。
执行模式会先在数据目录生成 `covers-backup-*.sqlite` 数据库备份，并保留原图片文件。
本地视频直接读取，OSS 视频临时下载后截帧；命令检查容量并在结束时清理临时文件。
修复使用新的图片版本及内容哈希，原有缩略图缓存不会被复用。刷新电视页面即可重新请求封面。
命令返回非零表示有失败条目，应查看输出；无论修复是否成功，都应重新启动服务。

本地非 Docker 环境可使用同一个 Python 模块，配置必须指向实际数据目录：

```bash
bash tools/repair-covers.sh
```

在仓库根目录执行；如需执行修改，加 `--apply`。也可以通过 `MOLLYTIME_DATA_DIR` 指定数据目录。
