// `ardent-studio backup <dir>`: a consistent copy of a data directory while the service runs, without
// the sqlite3 CLI (the image ships only Node). The database is copied first with VACUUM INTO (one read
// transaction, so the copy is consistent), then every blob that copy records is copied and re-hashed.
// Blobs are immutable, but the service removes the ones nothing references any more (a file delete, the
// hourly sweep). A blob removed after the copy was taken is no longer needed by the live database, so
// the database is copied again and the pass resumes with the blobs that newer copy records; a blob
// still recorded by the newer copy and still missing is a real loss and fails the backup.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from './db/sqlite.js';
import { DATABASE_FILE } from './service.js';
import { VERSION } from './version.js';

export class BackupError extends Error {
  override name = 'BackupError';
}

export interface BackupResult { database: string; blobs: number; bytes: number }

export interface BackupOptions {
  /** How many times the database is copied again when blobs were removed during the pass. */
  maxSnapshots?: number;
  /** Called after each database copy is read, before its blobs are copied. For tests. */
  onSnapshot?: (attempt: number) => void | Promise<void>;
}

interface BlobRow { sha256: string; path: string; size: number }

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function snapshot(source: string, database: string): BlobRow[] {
  rmSync(database, { force: true });
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    live.prepare('VACUUM INTO ?').run(database);
  } finally {
    live.close();
  }
  const copy = new Database(database, { readonly: true, fileMustExist: true });
  try {
    return copy.prepare('SELECT sha256, path, size FROM blobs ORDER BY sha256').all() as BlobRow[];
  } finally {
    copy.close();
  }
}

export async function backupDataDir(dataDir: string, target: string, options: BackupOptions = {}): Promise<BackupResult> {
  if (!isAbsolute(dataDir)) throw new BackupError('ARDENT_STUDIO_DATA must be an absolute path');
  const source = join(dataDir, DATABASE_FILE);
  if (!existsSync(source)) throw new BackupError(`No ${DATABASE_FILE} in ${dataDir}`);
  const out = resolve(target);
  if (out === resolve(dataDir) || out.startsWith(`${resolve(dataDir)}/`)) throw new BackupError('The backup directory must be outside the data directory');
  if (existsSync(out) && readdirSync(out).length) throw new BackupError(`${out} is not empty`);
  mkdirSync(out, { recursive: true, mode: 0o700 });

  const database = join(out, DATABASE_FILE);
  const maxSnapshots = options.maxSnapshots ?? 5;
  /** Blobs already copied and verified, by digest: a later pass reuses them. */
  const copied = new Map<string, string>();
  let missing = new Set<string>();
  let rows: BlobRow[] = [];
  for (let attempt = 1; ; attempt++) {
    rows = snapshot(source, database);
    await options.onSnapshot?.(attempt);
    const gone = new Set<string>();
    for (const row of rows) {
      if (copied.has(row.sha256)) continue;
      const from = join(dataDir, 'blobs', row.path);
      const to = join(out, 'blobs', row.path);
      if (!existsSync(from)) {
        // Missing from two copies in a row: the live database still records it, so it is lost.
        if (missing.has(row.sha256)) throw new BackupError(`Blob ${row.sha256} is recorded but missing from ${join(dataDir, 'blobs')}`);
        gone.add(row.sha256);
        continue;
      }
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
      if (await sha256Of(to) !== row.sha256) throw new BackupError(`Blob ${row.sha256} does not match its digest; the backup is incomplete`);
      copied.set(row.sha256, to);
    }
    if (!gone.size) break;
    if (attempt >= maxSnapshots) throw new BackupError(`Blobs kept being removed while the backup ran (${maxSnapshots} database copies); run it again`);
    missing = gone;
  }
  // Blobs an earlier copy recorded that the final one no longer does.
  const kept = new Set(rows.map(row => row.sha256));
  for (const [sha256, path] of copied) if (!kept.has(sha256)) rmSync(path, { force: true });
  const bytes = rows.reduce((sum, row) => sum + row.size, 0);
  writeFileSync(join(out, 'backup.json'), `${JSON.stringify({ product: 'ardent-studio', version: VERSION, created_at: new Date().toISOString(), blobs: rows.length, bytes }, null, 2)}\n`, { mode: 0o600 });
  return { database, blobs: rows.length, bytes };
}
