# 家庭存储与流量用量

账号已有必填的 `users.family_id` 外键，一个账号归属一个家庭。此功能沿用现有归属与隔离，同一家庭全部账号、设备的用量合并统计。

## 页面与权限

- 家长后台 **家庭设置 → 家庭用量**：查看本家庭当前文件占用与指定月份流量。
- 超管后台 **运营设置 → 家庭用量**：按家庭、邮箱或账号 ID 搜索、分页查看所有家庭，导出指定月份的 CSV，导入 OSS 访问日志。
- 普通家庭账号不能查看其他家庭的报表、导出平台用量或写入流量记录。导入需要超管家长会话、同源请求与 CSRF 校验；设备令牌不能使用运营接口。

## 统计口径

所有原始数量使用整数 **字节**，CSV 不做 GB 舍入。流量月份固定为 `Asia/Shanghai` 自然月，与可修改的观看报表时区分开。查询范围是月初零点（包含）至下月月初零点（不包含）。

`storage.usedBytes` 为当前已入库文件占用，包含视频、字幕、封面、归档资源和被替换后仍保留的版本；同家庭、同后端、同路径只统计一次。服务器本地文件使用实际文件大小，旧文件未填写 `size_bytes` 也能统计；OSS 使用完成上传时服务端核验的大小。大小未知的 OSS 文件通过 `unknownSizeCount` 明确显示，不把它伪装成完整统计。

`pendingBytes` 是未入库上传的已知占用：本地临时文件实际大小，以及已完成 OSS 对象、正在处理或处理失败的大小。上传预留 `reservedBytes` 另列，不能作为实际消费计费。未完成的 OSS 分片、派生缓存、处理临时副本、数据库、共享客户端安装包不计入家庭文件占用；这些平台成本需要另外核算。

存储是**查询时的当前占用**，选择历史月份不会生成历史存储或 GB·月账单。此功能提供用量依据，不设置价格、自动扣款或存储时间积分。计费若按月平均占用，需要后续补充存储历史采样/变更台账与结算规则。

流量包括：

- `traffic.localBytes`：家庭媒体响应体成功交给 ASGI 发送接口的字节，包括 Range 视频、下载、家长提醒视频、字幕和实际返回的缩放封面。断开时只累计发送成功的块；HEAD、416、拒绝访问、302 跳转及播放解析不计。它不是客户端确认收讫或运营商网络账单；代理缓存/重传应在部署层核对。
- `traffic.ossBytes`：导入 OSS Bucket 访问日志中，已配置 Bucket 公网域名的成功 `GetObject`、200/206、普通请求的 `SentBytes`。上传、HEAD、错误、内网请求与 CDN 回源不计。若 worker 未配置内网 Endpoint，处理读取会产生真实公网下行费用，也会进入对应家庭统计。
- `traffic.totalBytes`：以上两项之和。TV 本地缓存重复播放不发起媒体请求，因此不重复计网络流量。

新表 `family_traffic_events` 为追加式台账，保留家庭、来源、字节数、请求时间和入账时间。OSS 请求 ID 与 Bucket 的 SHA-256 为唯一键，同文件重复行、重叠文件和重复导入都不会重计；同 ID 内容冲突会原子拒绝整批。签名 URL、访问密钥、Cookie、IP、客户端信息不入库。

服务启动自动建表并记录 `family-usage-v1`。本地流量从启用后开始统计；原先未记录的流量不能追溯。OSS 旧日志可以按原请求时间补录。

## OSS 日志导入

在 OSS 控制台为媒体 Bucket 启用访问日志，下载日志后在运营页面上传 UTF-8 文本。支持官方 Bucket 日志格式，单文件最多 10 MiB / 20000 行，大文件先拆分。

解析按阿里云 [日志转存格式](https://www.alibabacloud.com/help/zh/oss/user-guide/logging) 的 `SentBytes` 和 `RequestID` 统计，按服务端生成的 `families/{family_id}/...` 对象前缀归属。旧路径仅在数据库存在唯一家庭归属时计入；未知或共享归属记录返回 `unresolved`，运营人员应检查后处理。

也可在服务器用相同数据库、数据目录和存储配置定期执行：

```bash
apps/server/.venv/bin/python -m mollytime_server.scripts.import_usage_logs /path/to/access.log
```

每个文件返回 `imported`、`duplicates`、`ignored`、`unresolved`；格式错误或同请求 ID 冲突会拒绝该文件全部新增记录。CLI 和网页采用相同去重和归属策略。

日志需要持续收集与导入，本功能不自动启用云端日志或拉取日志。界面显示的是已导入流量，`lastOssImportAt` 是该月份记录最近入库时间，不是日志完整性凭证。阿里云文档说明 Bucket 日志不记录中断请求，因此结算前仍应与云端计量核对；漏日志或未识别记录不能按零消费结算。CDN 终端流量需未来接入 CDN 日志。

## API

- `GET /api/manage/usage?month=YYYY-MM`：当前会话所属家庭。
- `GET /api/manage/operations/usage?month=YYYY-MM&q=...&page=1&pageSize=20`：超管分页报表。
- `GET /api/manage/operations/usage/export?month=YYYY-MM&q=...`：导出所有匹配家庭，CSV 中存储列明确为当前占用。
- `POST /api/manage/operations/usage/oss-logs`：超管上传原始 UTF-8 日志内容，`application/octet-stream`。

默认月份为北京时间当前月。查询错误月份返回 422；过大的日志返回 413；冲突记录返回 409。历史月份的存储列仍为当前占用，流量列按所选月份取台账。
