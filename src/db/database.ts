import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from './sqlite.js';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database;

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(`${migration.id}\n${migration.name}\n${migration.sql}`).digest('hex');
}

/** Open the database (WAL, foreign keys) and apply pending migrations. */
export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Apply pending migrations in order, each in its own transaction. Refuses changed or unknown history. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  for (const [index, migration] of migrations.entries()) {
    if (migration.id !== index + 1) throw new MigrationError('Migrations must be numbered 1, 2, 3, … without gaps');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = db.prepare('SELECT id, name, checksum FROM schema_migrations ORDER BY id').all() as Array<{ id: number; name: string; checksum: string }>;
  for (const row of applied) {
    const known = migrations[row.id - 1];
    if (!known) throw new MigrationError(`Database has migration ${row.id} (${row.name}), which this version does not know. Upgrade ArdentStudio instead of downgrading.`);
    if (migrationChecksum(known) !== row.checksum) throw new MigrationError(`Migration ${row.id} (${row.name}) differs from the one applied to this database`);
  }
  const ran: number[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
  for (const migration of migrations.slice(applied.length)) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, migrationChecksum(migration), new Date().toISOString());
    })();
    ran.push(migration.id);
  }
  return ran;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM schema_migrations').get() as { id: number | null };
  return row.id ?? 0;
}
