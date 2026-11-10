import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from '../src/db/sqlite.js';
import { MigrationError, migrate, openDatabase, schemaVersion } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';

const RECORD_TABLES = [
  'projects', 'requested_deliverables', 'files', 'blobs', 'agent_templates', 'agent_template_versions', 'team_templates', 'team_template_versions',
  'agent_bindings', 'agent_presentation', 'team_assignments', 'team_assignment_revisions', 'room_layouts', 'conversations', 'messages', 'decisions',
  'tasks', 'activity', 'deliverables', 'deliverable_revisions', 'review_comments', 'review_decisions', 'exports', 'agent_drafts', 'development_comments',
  'events', 'project_event_cursors', 'audit', 'idempotency_keys',
];

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('migrations', () => {
  it('create every record table from an empty database, in WAL mode with foreign keys', () => {
    dir = mkdtempSync(join(tmpdir(), 'ardent-studio-migrations-'));
    const db = openDatabase(join(dir, 'studio.sqlite'));
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
    for (const table of RECORD_TABLES) expect(tables.has(table), table).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    db.close();
  });

  it('are idempotent and resume from a previous version', () => {
    const db = new Database(':memory:');
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toEqual([1]);
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toEqual([]);
    const extra = { id: MIGRATIONS.length + 1, name: 'fixture_addition', sql: 'CREATE TABLE fixture_addition (id INTEGER PRIMARY KEY);' };
    expect(migrate(db, [...MIGRATIONS, extra])).toEqual([...MIGRATIONS.slice(1).map(item => item.id), extra.id]);
    expect(schemaVersion(db)).toBe(extra.id);
    db.close();
  });

  it('refuse an edited migration and a database from a newer version', () => {
    const db = new Database(':memory:');
    migrate(db);
    const edited = MIGRATIONS.map(item => item.id === 1 ? { ...item, sql: `${item.sql}\n-- changed` } : item);
    expect(() => migrate(db, edited)).toThrow(MigrationError);
    expect(() => migrate(db, [])).toThrow(/does not know/);
    expect(() => migrate(new Database(':memory:'), [{ id: 2, name: 'gap', sql: '' }])).toThrow(/numbered/);
    db.close();
  });

  it('keep audit append-only and template versions immutable', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare("INSERT INTO audit (at, actor_user_id, action, target_type, target_id) VALUES ('2026-01-01', 'operator', 'x', 'y', 'z')").run();
    expect(() => db.prepare("UPDATE audit SET action = 'changed'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    db.prepare("INSERT INTO team_templates (id, slug, source, latest_version, name, category, purpose, created_by, created_at, updated_at) VALUES ('t', 's', 'user', 1, 'n', 'c', 'p', 'u', 'a', 'a')").run();
    db.prepare("INSERT INTO team_template_versions (template_id, version, body_json, changelog, created_by, created_at) VALUES ('t', 1, '{}', 'x', 'u', 'a')").run();
    expect(() => db.prepare("UPDATE team_template_versions SET body_json = '[]'").run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM team_template_versions').run()).toThrow(/immutable/);
    db.close();
  });
});
