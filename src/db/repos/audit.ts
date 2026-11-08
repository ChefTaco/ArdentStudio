import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export interface AuditActor {
  userId: string;
  subject?: string | undefined;
  issuer?: string | undefined;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_user_id: string;
  actor_subject: string | null;
  actor_issuer: string | null;
  action: string;
  target_type: string;
  target_id: string;
  idempotency_key: string | null;
  detail: Record<string, unknown>;
}

/** Append-only: the table rejects UPDATE and DELETE. Details never hold secrets or file contents. */
export class AuditRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  record(entry: { actor: AuditActor; action: string; targetType: string; targetId: string; idempotencyKey?: string | undefined; detail?: Record<string, unknown> }): void {
    this.db.prepare(`INSERT INTO audit (at, actor_user_id, actor_subject, actor_issuer, action, target_type, target_id, idempotency_key, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.clock.now().toISOString(), entry.actor.userId, entry.actor.subject ?? null, entry.actor.issuer ?? null,
      entry.action, entry.targetType, entry.targetId, entry.idempotencyKey ?? null, writeJson(entry.detail ?? {}),
    );
  }

  list(filter: { targetId?: string; limit?: number } = {}): AuditEntry[] {
    const rows = (filter.targetId
      ? this.db.prepare('SELECT * FROM audit WHERE target_id = ? ORDER BY id DESC LIMIT ?').all(filter.targetId, filter.limit ?? 100)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(filter.limit ?? 100)) as Array<Omit<AuditEntry, 'detail'> & { detail_json: string }>;
    return rows.map(({ detail_json, ...row }) => ({ ...row, detail: readJson(detail_json, {}) }));
  }
}
