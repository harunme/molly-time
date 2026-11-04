# MollyTime Server

MollyTime 的唯一业务与媒体后台，采用 FastAPI + SQLAlchemy + SQLite，自有 REST API 位于 `/api/*`，不依赖 Jellyfin 服务端或协议。

当前包含认证、家庭与儿童管理、可撤销 TV 设备、目录与发布状态、本地视频 Range 响应、字幕、封面、分块上传与媒体处理、首页草稿/发布和实际观看时长统计。管理网页入口 `/manage/`，TV 网页入口 `/tv/`。支持 OSS 分片直传、签名直播放，以及电视持久保存任务。配置和部署见 [OSS 与电视缓存](../../docs/oss-storage.md)。

家庭、儿童、上传、首页与统计在本应用内按模块实现，不另建 `services/business-api/`。两个网页与原生壳子共用同一后台。上传处理需要 FFmpeg/FFprobe；观看统计需要新版 APK。使用与限制见 [管理后台说明](../web/README.md)。

## 本地运行

```bash
bash tools/build-server.sh
bash tools/init-server.sh
bash tools/build-tv-web.sh
bash tools/build-web.sh
bash tools/run-server.sh
```

默认监听 `127.0.0.1:8096`。Docker 启动：

```bash
docker compose -f infra/compose.yaml up -d mollytime-server
```

## 目录

- `mollytime_server/api/`：认证、用户、儿童、目录、播放接口。
- `models.py` / `db.py`：SQLAlchemy 模型与数据库。
- `auth.py` / `deps.py`：认证与请求依赖。
- `storage/`：本地与 OSS 存储适配。
- `utils/`：封面处理与 ffprobe。
- `scripts/`：建库与管理员创建。

接口、配置与限制见 [服务端文档](../../docs/server.md)，目标职责见 [架构文档](../../docs/architecture.md)。本目录源码采用 MIT License，不含 Jellyfin 服务端代码。

播放正常结束后，网页 TV 和 Android TV 会按当前文件夹列表顺序自动播放下一部已发布且就绪的视频；最后一部结束返回列表。手动退出不会连播。`GET /api/episodes/{id}/next` 与文件夹列表使用相同排序及家庭/发布校验；每部视频独立创建观看会话。

## Stable TV identity and rebinding

TV installations now maintain a private, random identity credential scoped to the server origin. This is not a hardware serial number. The native client stores it in `noBackupFilesDir`, independently of session credentials, never sends it to WebView, and preserves it on logout/unbind. The server stores only its SHA-256 secret hash. TLS is required by the release client.

New additive tables are created by the existing `init_db()` startup path: `device_identities`, `device_identity_bindings`, `device_authorization_versions`, and `pairing_identities`. Existing `devices` and watch/history/control rows are not rewritten. A family-scoped identity mapping reuses the original device ID after parent-approved pairing. Switching families creates/reuses that family's separate binding and revokes the installation's other active bindings; historical rows remain in their original family.

- `POST /api/auth/device-identity`: authenticated TV adoption of its current device with `{id, secret}`. Idempotent; cannot adopt another device or replace an existing different identity.
- `POST /api/auth/pairing/start`: optional nested `identity: {id, secret}`. Older clients without this field remain supported, but cannot recover their historical identity on a new pairing.
- Pairing preview adds `returningDevice` and prefills the previous device name only within the authenticated parent's family.
- Unbind and rebind invalidate refresh credentials and increment authorization version. Access tokens with the old version remain invalid even when the same device ID becomes active again. Pre-upgrade access tokens lacking the version are version zero.
- Quota rounds and consumed amounts remain attached to the original device ID. Rebinding does not reset the daily allowance.

Rollout: deploy server first, then TV client, then optional parent UI update. Active upgraded TVs adopt their current identity at startup/periodic sync and before TV-initiated reset. Do not revoke an old, not-yet-upgraded TV expecting automatic recovery: it has not proved an installation identity yet. Removing app data, uninstalling, or factory reset can remove the credential; manual association of such devices is intentionally deferred. Never merge devices based on their display names. Downgrading the server removes version enforcement and is not a safe rollback after rebindings; retain the new authorization checks.

Validation: SQLite migration/idempotency, same-family restore, settings/history/used-quota preservation, wrong-secret rejection, old-token rejection, family switching and legacy pairing are covered in `tests/test_device_identity.py`; Android tests verify identity persistence and per-origin isolation. MySQL locking paths use row locks and unique constraints but still need deployment-environment concurrency validation. Offline signed playback leases retain their existing expiry semantics; online credential revocation is not a remote deletion of downloaded files.
