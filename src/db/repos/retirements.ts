// HiveMem sources of purged projects that still have to be retired. The project rows are gone, so
// each row carries the workspace and source identifiers it needs.
import type { Db } from '../database.js';
import type { Clock } from '../json.js';

export interface KnowledgeRetirement {
  id: number;
  studio_project_id: string;
  workspace_id: string;
  hivemem_project_id: string;
  source_id: string;
  source_uri: string;
  revision: string;
  attempts: number;
  next_attempt_at: string;
  error: string | null;
}

export type RetirementInput = Pick<KnowledgeRetirement, 'studio_project_id' | 'workspace_id' | 'hivemem_project_id' | 'source_id' | 'source_uri' | 'revision'>;

export class KnowledgeRetirementRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** Queue retirements, due now. A source already queued keeps its row. Call inside a transaction. */
  queue(items: readonly RetirementInput[]): number {
    const now = this.clock.now().toISOString();
    const insert = this.db.prepare(`INSERT INTO knowledge_retirements (studio_project_id, workspace_id, hivemem_project_id, source_id, source_uri, revision, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, source_id) DO NOTHING`);
    let queued = 0;
    for (const item of items) queued += insert.run(item.studio_project_id, item.workspace_id, item.hivemem_project_id, item.source_id, item.source_uri, item.revision, now, now).changes;
    return queued;
  }

  due(limit: number): KnowledgeRetirement[] {
    return this.db.prepare('SELECT * FROM knowledge_retirements WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?')
      .all(this.clock.now().toISOString(), limit) as KnowledgeRetirement[];
  }

  pending(studioProjectId?: string): number {
    const row = (studioProjectId === undefined
      ? this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_retirements').get()
      : this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_retirements WHERE studio_project_id = ?').get(studioProjectId)) as { count: number };
    return row.count;
  }

  done(id: number): void {
    this.db.prepare('DELETE FROM knowledge_retirements WHERE id = ?').run(id);
  }

  failed(id: number, attempts: number, error: string, nextAttemptAt: Date): void {
    this.db.prepare('UPDATE knowledge_retirements SET attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?').run(attempts, error, nextAttemptAt.toISOString(), id);
  }
}
