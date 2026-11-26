# Operations

## Data and backup

All state is in the data directory (`ARDENT_STUDIO_DATA`, the `/data` volume in the image):

| Path | Contents |
|---|---|
| `studio.sqlite` (+ `-wal`, `-shm`) | Every Studio record, the audit log and the event feed (SQLite, WAL) |
| `blobs/aa/bb/<sha256>` | Uploaded files and, later, deliverables and exports, addressed by SHA-256 |
| `blobs/tmp/` | Writes in progress; cleared on start |

**Back up the whole volume as one unit.** The database references blobs by digest, so a database
without its blobs is incomplete.

- Consistent backup while running: `ardent-studio backup <dir>` (in the container:
  `docker exec <container> node /app/dist/main.js backup /data-backup/<stamp>` with a backup volume
  mounted there). It reads only `ARDENT_STUDIO_DATA`, copies the database in one read transaction
  (`VACUUM INTO`), then copies every blob that copy records and checks each against its digest, and
  writes `backup.json`. When a file delete or the hourly sweep removes a blob during the copy, it copies
  the database again and copies the blobs that newer copy records (up to five copies); a blob still
  recorded and still missing fails the backup. The directory must be new or empty and outside the data directory. The image
  has no `sqlite3` CLI; on a host that has one, `sqlite3 studio.sqlite ".backup ..."` followed by a copy
  of `blobs/` works too.
- Simplest: stop the container, copy or snapshot the volume, start it again.

## Restore

1. Stop ArdentStudio.
2. Replace the volume contents with the backup (`studio.sqlite` and `blobs/`). Remove any stale
   `studio.sqlite-wal` and `studio.sqlite-shm` that do not belong to the backup.
3. Start ArdentStudio. It verifies the migration history, applies newer migrations and clears
   `blobs/tmp/`.
4. Clients reconnecting with a cursor newer than the restored feed get `reset` and refetch.

Knowledge in HiveMem is derived from the stored files: after restoring an older backup, call
`POST /api/ardentstudio/v1/projects/<id>/reindex` for each project (or reindex single files) to bring
HiveMem back in line.

## Upgrade

- Migrations are numbered and additive and run on start, each in a transaction. The service
  refuses to start on a database written by a newer version: upgrade instead of downgrading.
- Back up before upgrading.

## Health

- `GET /api/ardentstudio/v1/health/live`: the process serves requests (the image's health check).
- `GET /api/ardentstudio/v1/health/ready`: 200 only when the database answers, Magnus answers with
  at least one available Ardent agent, and HiveMem is healthy; otherwise 503 with the failing
  checks. Results are cached for ten seconds. The route needs no token, so a failing check answers
  only a code (`MAGNUS_UNAVAILABLE`, `HIVEMEM_TIMEOUT`, ...); what the dependency said is in the
  service log (`Readiness check failed`, logged when it changes).
- A fresh suite has no Ardent agent until one is created (Studio's New Agent, or `./hive.sh ardent
  setup`), so `/health/ready` answers 503 until then. Use `/health/live` for container health checks,
  restarts and load-balancer liveness; use `/health/ready` to tell whether Studio can run work.
- On `SIGTERM` or `SIGINT` Studio stops accepting connections, ends open event streams (clients
  reconnect with their last `seq`), gives requests in flight up to 8 seconds, closes what is still
  open, then stops background work and closes the database. That fits a container stop's default
  10-second timeout.

## Maintenance

Hourly, the service removes project events older than `ARDENT_STUDIO_EVENT_RETENTION_DAYS` (the
cursor boundary is kept so stale clients get `reset`) and idempotency keys older than a day, and
deletes stored bytes (`blobs/`) that nothing references any more and that were not written or reused in
the last ten minutes: deleted files, refused or abandoned uploads, superseded conversions and the bytes of
purged projects. The audit log is never pruned.

Purging an archived project (`POST /projects/<id>/purge`, `ardentstudio:agents:admin`, with the exact
project name as `confirm_name`) cannot be undone except from a backup: take one first when in doubt.
HiveMem sources of a purged project wait in `knowledge_retirements` until HiveMem accepts their
retirement (`Purged project source retirement failed` in the log while it does not); the project's HiveMem
workspace is kept and can be removed in HiveMem when it is no longer wanted.

## Logs

JSON lines on stderr. Logs carry ids, counts and error summaries, never tokens, secrets or file
contents.
