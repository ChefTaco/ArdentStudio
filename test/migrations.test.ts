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
  'events', 'project_event_cursors', 'audit', 'idempotency_keys', 'workflow_runs', 'workflow_nodes',
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

  it('add the task execution columns to an existing database without touching its rows', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter(item => item.id <= 6));
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO tasks (id, project_id, title, mode, source_json, state, created_by, created_at, updated_at, ardent_agent_ref, ardent_task_id, submit_attempts)
      VALUES ('tsk_old', 'prj_old', 'Old task', 'turn', '{"message_id":"msg_old"}', 'completed', 'operator', '2026-01-01', '2026-01-01', 'node1~lead',
        '11111111-1111-4111-8111-111111111111', 2);`);
    const before = db.prepare("SELECT * FROM tasks WHERE id = 'tsk_old'").get() as Record<string, unknown>;
    expect(migrate(db, MIGRATIONS.filter(item => item.id <= 7)).at(-1)).toBe(7);
    const after = db.prepare("SELECT * FROM tasks WHERE id = 'tsk_old'").get() as Record<string, unknown>;
    expect(after).toEqual({ ...before, execution_json: null, root_ref: null, parent_ref: null, submit_payload_json: null, submit_next_at: null,
      ardent_attempts_json: null, recovery_json: null });
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all() as Array<{ name: string }>).map(row => row.name);
    expect(indexes).toContain('tasks_root_ref');
    db.close();
  });

  it('add the workflow tables and task columns without touching existing rows, one task per node attempt', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter(item => item.id <= 7));
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO tasks (id, project_id, title, mode, source_json, state, created_by, created_at, updated_at)
      VALUES ('tsk_old', 'prj_old', 'Old task', 'turn', '{}', 'completed', 'operator', '2026-01-01', '2026-01-01');`);
    const before = db.prepare("SELECT * FROM tasks WHERE id = 'tsk_old'").get() as Record<string, unknown>;
    expect(migrate(db).at(-1)).toBe(8);
    expect(db.prepare("SELECT * FROM tasks WHERE id = 'tsk_old'").get()).toEqual({ ...before, workflow_run_id: null, workflow_node_key: null, workflow_attempt: null });
    const insert = db.prepare(`INSERT INTO tasks (id, project_id, title, mode, source_json, state, created_by, created_at, updated_at, workflow_run_id, workflow_node_key, workflow_attempt)
      VALUES (?, 'prj_old', 'Node', 'assignment', '{}', 'queued', 'operator', '2026-01-01', '2026-01-01', 'wfr_1', 'research', ?)`);
    insert.run('tsk_a1', 1);
    insert.run('tsk_a2', 2);
    expect(() => insert.run('tsk_dup', 1)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO workflow_runs (id, project_id, spec_json, spec_sha256, state, created_by, created_at, updated_at)
      VALUES ('wfr_x', 'prj_old', '{}', 'x', 'paused', 'operator', 'a', 'a')`).run()).toThrow(/CHECK/);
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
