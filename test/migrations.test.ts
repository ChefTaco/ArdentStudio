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
  'events', 'project_event_cursors', 'audit', 'idempotency_keys', 'workflow_runs', 'workflow_nodes', 'deliverable_renditions',
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
    expect(migrate(db, MIGRATIONS.filter(item => item.id <= 8)).at(-1)).toBe(8);
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

  it('add the transfer columns and rendition table without touching existing imports', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter(item => item.id <= 8));
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO artifact_imports (project_id, task_id, agent_ref, artifact_id, sha256, name, mime, size, manifest_json, ardent_event_seq, state, created_at, updated_at)
      VALUES ('prj_old', 'tsk_old', 'node1~lead', 'art_1', '${'a'.repeat(64)}', 'map.png', 'image/png', 10, '{}', 3, 'imported', '2026-01-01', '2026-01-01');`);
    const before = db.prepare("SELECT * FROM artifact_imports WHERE artifact_id = 'art_1'").get() as Record<string, unknown>;
    expect(migrate(db, MIGRATIONS.filter(item => item.id <= 9)).at(-1)).toBe(9);
    expect(db.prepare("SELECT * FROM artifact_imports WHERE artifact_id = 'art_1'").get()).toEqual({ ...before, received_bytes: 0, transfer: null, resumes: 0, error_code: null });
    expect(() => db.prepare("UPDATE artifact_imports SET transfer = 'carrier pigeon'").run()).toThrow(/CHECK/);
    const columns = (db.prepare('PRAGMA table_info(deliverable_renditions)').all() as Array<{ name: string }>).map(row => row.name);
    expect(columns).toEqual(['deliverable_revision_id', 'position', 'role', 'sha256', 'mime', 'size', 'purpose', 'width', 'height', 'has_alpha', 'created_at']);
    db.close();
  });

  it('add the source definition column to agent template versions, which stay immutable', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter(item => item.id <= 9));
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO agent_template_versions (template_id, version, body_json, changelog, created_by, created_at) VALUES ('tpl_old', 1, '{}', 'Initial', 'operator', '2026-01-01');`);
    const before = db.prepare("SELECT * FROM agent_template_versions WHERE template_id = 'tpl_old'").get() as Record<string, unknown>;
    expect(migrate(db, MIGRATIONS.filter(item => item.id <= 10)).at(-1)).toBe(10);
    expect(db.prepare("SELECT * FROM agent_template_versions WHERE template_id = 'tpl_old'").get()).toEqual({ ...before, source_definition_json: null });
    expect(() => db.prepare("UPDATE agent_template_versions SET source_definition_json = '{}'").run()).toThrow();
    db.close();
  });

  it('add file deletion and blob use columns without changing existing rows', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.filter(item => item.id <= 10));
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO blobs (sha256, size, mime, path, created_at) VALUES ('${'b'.repeat(64)}', 1, 'text/plain', 'bb/bb/x', '2026-01-01');
      INSERT INTO files (id, project_id, name, mime, size, sha256, purpose, created_by, created_at, knowledge_state, knowledge_updated_at)
        VALUES ('file_old', 'prj_old', 'a.txt', 'text/plain', 1, '${'b'.repeat(64)}', 'attachment', 'operator', '2026-01-01', 'not_indexed', '2026-01-01');`);
    expect(migrate(db).at(-1)).toBe(11);
    expect(db.prepare("SELECT deleted_at, deleted_by FROM files WHERE id = 'file_old'").get()).toEqual({ deleted_at: null, deleted_by: null });
    expect(db.prepare('SELECT used_at FROM blobs').get()).toEqual({ used_at: null });
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
