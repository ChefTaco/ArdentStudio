// `ardent-studio backup <dir>`: a consistent copy of a data directory while the service runs, without
// the sqlite3 CLI (the image ships only Node). The database is copied first with VACUUM INTO (one read
// transaction, so the copy is consistent), then every blob that copy records is copied and re-hashed.
// Blobs are immutable once written, so the blobs the copied database needs are all still there.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from './db/sqlite.js';
import { DATABASE_FILE } from './service.js';
import { VERSION } from './version.js';

export class BackupError extends Error {
  override name = 'BackupError';
}

export interface BackupResult { database: string; blobs: number; bytes: number }

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function backupDataDir(dataDir: string, target: string): Promise<BackupResult> {
  if (!isAbsolute(dataDir)) throw new BackupError('ARDENT_STUDIO_DATA must be an absolute path');
  const source = join(dataDir, DATABASE_FILE);
  if (!existsSync(source)) throw new BackupError(`No ${DATABASE_FILE} in ${dataDir}`);
  const out = resolve(target);
  if (out === resolve(dataDir) || out.startsWith(`${resolve(dataDir)}/`)) throw new BackupError('The backup directory must be outside the data directory');
  if (existsSync(out) && readdirSync(out).length) throw new BackupError(`${out} is not empty`);
  mkdirSync(out, { recursive: true, mode: 0o700 });

  const database = join(out, DATABASE_FILE);
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    live.prepare('VACUUM INTO ?').run(database);
  } finally {
    live.close();
  }

  const copy = new Database(database, { readonly: true, fileMustExist: true });
  let rows: Array<{ sha256: string; path: string; size: number }>;
  try {
    rows = copy.prepare('SELECT sha256, path, size FROM blobs ORDER BY sha256').all() as typeof rows;
  } finally {
    copy.close();
  }
  let bytes = 0;
  for (const row of rows) {
    const from = join(dataDir, 'blobs', row.path);
    const to = join(out, 'blobs', row.path);
    if (!existsSync(from)) throw new BackupError(`Blob ${row.sha256} is recorded but missing from ${join(dataDir, 'blobs')}`);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to);
    if (await sha256Of(to) !== row.sha256) throw new BackupError(`Blob ${row.sha256} does not match its digest; the backup is incomplete`);
    bytes += row.size;
  }
  writeFileSync(join(out, 'backup.json'), `${JSON.stringify({ product: 'ardent-studio', version: VERSION, created_at: new Date().toISOString(), blobs: rows.length, bytes }, null, 2)}\n`, { mode: 0o600 });
  return { database, blobs: rows.length, bytes };
}
