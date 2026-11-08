import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export interface ProjectEventRecord {
  seq: number;
  project_id: string;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface EventCursor {
  lastSeq: number;
  compactedThrough: number;
}

interface EventRow { project_id: string; seq: number; type: string; payload_json: string; at: string }

const toRecord = (row: EventRow): ProjectEventRecord => ({
  seq: row.seq, project_id: row.project_id, type: row.type, at: row.at, payload: readJson(row.payload_json, {}),
});

export class EventRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /**
   * Append one event. Must run inside a transaction: the seq is taken from the
   * project's cursor row in the same transaction, so concurrent writers cannot
   * reuse or reorder sequence numbers.
   */
  append(projectId: string, type: string, payload: Record<string, unknown>): ProjectEventRecord {
    if (!this.db.inTransaction) throw new Error('Project events are appended inside a transaction');
    this.db.prepare('INSERT INTO project_event_cursors (project_id) VALUES (?) ON CONFLICT (project_id) DO NOTHING').run(projectId);
    const { last_seq: seq } = this.db.prepare('UPDATE project_event_cursors SET last_seq = last_seq + 1 WHERE project_id = ? RETURNING last_seq')
      .get(projectId) as { last_seq: number };
    const at = this.clock.now().toISOString();
    this.db.prepare('INSERT INTO events (project_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, seq, type, writeJson(payload), at);
    return { seq, project_id: projectId, type, at, payload };
  }

  cursor(projectId: string): EventCursor {
    const row = this.db.prepare('SELECT last_seq, compacted_through FROM project_event_cursors WHERE project_id = ?')
      .get(projectId) as { last_seq: number; compacted_through: number } | undefined;
    return { lastSeq: row?.last_seq ?? 0, compactedThrough: row?.compacted_through ?? 0 };
  }

  after(projectId: string, after: number, limit = 500): ProjectEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(projectId, after, limit) as EventRow[];
    return rows.map(toRecord);
  }

  latest(projectId: string): ProjectEventRecord | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as EventRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Drop events older than the cutoff and remember, per project, the highest seq dropped. */
  compact(cutoff: Date): number {
    return this.db.transaction(() => {
      const bounds = this.db.prepare('SELECT project_id, MAX(seq) AS seq FROM events WHERE at < ? GROUP BY project_id')
        .all(cutoff.toISOString()) as Array<{ project_id: string; seq: number }>;
      let removed = 0;
      for (const bound of bounds) {
        removed += this.db.prepare('DELETE FROM events WHERE project_id = ? AND seq <= ?').run(bound.project_id, bound.seq).changes;
        this.db.prepare('UPDATE project_event_cursors SET compacted_through = MAX(compacted_through, ?) WHERE project_id = ?').run(bound.seq, bound.project_id);
      }
      return removed;
    })();
  }
}
