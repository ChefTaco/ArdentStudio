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

- Consistent backup while running: `sqlite3 studio.sqlite ".backup '/backup/studio.sqlite'"` (or the
  SQLite online backup API), then copy `blobs/` (blobs are immutable once written, so copying after
  the database backup captures everything it references).
- Simplest: stop the container, copy or snapshot the volume, start it again.

## Restore

1. Stop ArdentStudio.
2. Replace the volume contents with the backup (`studio.sqlite` and `blobs/`). Remove any stale
   `studio.sqlite-wal` and `studio.sqlite-shm` that do not belong to the backup.
3. Start ArdentStudio. It verifies the migration history, applies newer migrations and clears
   `blobs/tmp/`.
4. Clients reconnecting with a cursor newer than the restored feed get `reset` and refetch.

Knowledge in HiveMem is derived from the stored files: after restoring an older backup, use
**reindex** on reference files to bring HiveMem back in line.

## Upgrade

- Migrations are numbered and additive and run on start, each in a transaction. The service
  refuses to start on a database written by a newer version: upgrade instead of downgrading.
- Back up before upgrading.

## Health

- `GET /api/ardentstudio/v1/health/live`: the process serves requests (the image's health check).
- `GET /api/ardentstudio/v1/health/ready`: 200 only when the database answers, Magnus answers with
  at least one available Ardent agent, and HiveMem is healthy; otherwise 503 with the failing
  checks. Results are cached for ten seconds.

## Maintenance

Hourly, the service removes project events older than `ARDENT_STUDIO_EVENT_RETENTION_DAYS` (the
cursor boundary is kept so stale clients get `reset`) and idempotency keys older than a day. The
audit log is never pruned.

## Logs

JSON lines on stderr. Logs carry ids, counts and error summaries, never tokens, secrets or file
contents.
