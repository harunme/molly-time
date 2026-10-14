# Seoul deployment

MollyTime runs on one Tencent Cloud Lighthouse host in Seoul. The public DNS
record for `mollytime.app` points at that host. Caddy serves HTTPS on 80/443,
the Python application runs on the private Compose network, and MySQL 8.4 has
no published port. Media is stored in the existing private Alibaba OSS bucket;
the application issues signed URLs for cloud video playback.

## Files and startup

Copy the repository's `infra`, `tools`, `apps/server`, and built `apps/web/dist`
and `apps/tv/web/dist` into `/opt/mollytime`. Preserve the production `.env`,
`data/operations-storage.key`, and `mysql-data` directories. Local media on the
old Shanghai host is kept temporarily for rollback after its OSS migration.
The untracked `.env.mysql` contains `MYSQL_ROOT_PASSWORD` and `MYSQL_PASSWORD`;
the untracked `.env` contains a matching `MOLLYTIME_DB_URL` using the internal
host `mysql:3306`, plus `MOLLYTIME_PUBLIC_BASE_URL=https://mollytime.app`.
Keep both files mode 600 and never commit them.

```bash
cd /opt/mollytime
sudo docker compose --env-file .env -f infra/compose.seoul.yaml up -d --build
sudo docker compose --env-file .env -f infra/compose.seoul.yaml ps
curl -fsS https://mollytime.app/healthz
```

The source of truth for table definitions is `apps/server/mollytime_server`.
For an initial migration, take a SQLite `Connection.backup()` snapshot on the
old server, then run `tools/migrate_sqlite_to_mysql.py` against an empty MySQL
database. The script validates SQLite integrity, row counts, and foreign keys.
Do not copy a live `server.db` file without using SQLite's backup API.

## Backups and recovery

The host cron entry `/etc/cron.d/mollytime-backup` checks
`/opt/mollytime/infra/backup-seoul.sh` every minute under `flock`. The
superadmin's Operations → Database Backups page controls the daily Beijing-time
schedule, enable switch, and local retention. The job makes a consistent MySQL dump,
selecting the active database from `MOLLYTIME_DB_URL` in `.env`,
compresses and encrypts it, then uploads it to the private OSS prefix
`mollytime-backups/mysql/`. The encryption key is
`/opt/mollytime/data/backup-fernet.key`; keep an offline copy. Local encrypted
copies older than the configured number of days are removed, while OSS retention must be managed
separately.

To restore, download a `.sql.gz.fernet` object, decrypt it with the saved
Fernet key, decompress it, and import the SQL into a fresh MySQL database.
Verify account, item, and media row counts before restarting the application.

The old Shanghai server is a rollback source until migration and playback have
been verified. New writes on either server after cutover will diverge, so a
rollback requires a deliberate database reconciliation.

## Automatic deployment

Pushing a commit to `main` runs `.github/workflows/deploy.yml`. CI reads the
current APK version and native-input fingerprint from Seoul using the restricted
SSH command `apk-state`, builds both web apps, and builds a signed Android APK
only when its native inputs changed (or `force_apk` was selected). It sends the
release to `ubuntu@43.133.227.83`. The public Seoul host key is pinned in
`infra/seoul-known-hosts`; the existing `MOLLYTIME_DEPLOY_KEY` secret is reused.
The CI public key is restricted to `check`, `apk-state`, and deployment commands
by `infra/github-deploy-seoul-gate.sh` on the Seoul host.

The fixed host receiver `/usr/local/lib/mollytime-deploy-seoul.py` comes from
`infra/github-deploy-seoul.py`. It validates the release archive and APK plan,
builds an image tagged with the commit SHA, runs an encrypted MySQL backup to
OSS, replaces only the API service, checks the public HTTPS pages, then
publishes the signed APK to OSS and advances the Seoul-local release manifest.
Application or publication failure restores the previous image and deployment
state. It does not roll back MySQL data. The receiver and gate are installed
through the management SSH key; uploaded releases cannot overwrite them.

The host cron runs `infra/backup-seoul.sh` under the same backup lock. The
receiver invokes it with `--force` before each deployment. The MySQL data and
encryption key live outside the release directory. CI does not restart MySQL or
Caddy. The first deployment starts from the current image tag recorded in
`/opt/mollytime/.env`; subsequent release paths are recorded in
`/opt/mollytime/seoul-deployment-state.json`.

## Initial cutover checks

The Caddyfile can temporarily return HTTP 503 while old local media is being
uploaded to permanent OSS objects. Keep that response until
`mollytime-media-to-oss.service` on Shanghai has uploaded and verified every
referenced file and committed the SQLite catalog changes. The migration keeps
the media IDs, uploads files under `families/<family-id>/media/`, and changes
the relevant `media_files` and `upload_targets` rows from `local` to `oss`.
It leaves old disk files in place for rollback. Previously cloud stored objects
keep their existing keys and are not reuploaded.

Take a fresh SQLite backup on Shanghai after the OSS migration and import it
into a fresh MySQL schema on Seoul, preserving the first imported schema as a
rollback copy. Confirm zero `local` rows in `media_files`, the app health
endpoint, parent and TV pages, an authenticated read, and video playback before
replacing the temporary Caddy response with the repository's
`infra/Caddyfile.seoul`. Keep the Shanghai server available for rollback.

## Legacy TV client transition

The Shanghai HTTPS endpoint on `118.89.122.66:8096` temporarily relays
application requests to `https://mollytime.app` using
`infra/nginx-tls-relay.conf`. The legacy address keeps its IP certificate.
Media, account, device, and client release requests from both addresses use the
Seoul application. Both endpoints therefore read the same MySQL catalog and
Seoul-local APK manifest. APK bytes live in the private OSS bucket. The old
SQLite service remains on Shanghai only as a rollback source.

New TV packages suggest `https://mollytime.app`. Existing installations with
the exact legacy IP address migrate their saved server origin on startup while
retaining device credentials. Releasing the package does not prove that every
installed TV has upgraded. Check an installed TV's server address and playback,
then observe that the legacy endpoint is no longer receiving client requests
before stopping the Shanghai proxy. Keep the IP certificate valid while the
relay is needed.
