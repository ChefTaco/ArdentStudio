import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

interface Row { method: string; path: string; fingerprint: string; state: 'pending' | 'complete'; status: number | null; response_json: string | null; created_at: string }

/** Keys are scoped to the acting user. Completed answers are kept for a day. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 3600_000;
/** How long an unfinished claim blocks its key. Requests finish long before this. */
export const STALE_CLAIM_MS = 10 * 60_000;

export class IdempotencyRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  claim(userId: string, key: string, method: string, path: string, fingerprint: string): IdempotencyClaim {
    return this.db.transaction((): IdempotencyClaim => {
      const row = this.db.prepare('SELECT method, path, fingerprint, state, status, response_json, created_at FROM idempotency_keys WHERE actor_user_id = ? AND key = ?')
        .get(userId, key) as Row | undefined;
      if (!row) {
        this.db.prepare(`INSERT INTO idempotency_keys (actor_user_id, key, method, path, fingerprint, state, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(userId, key, method, path, fingerprint, this.clock.now().toISOString());
        return { kind: 'claimed' };
      }
      if (row.method !== method || row.path !== path || row.fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (row.state === 'pending') {
        // A claim a crash left behind is released after a while so the client can retry.
        if (Date.parse(row.created_at) > this.clock.now().getTime() - STALE_CLAIM_MS) return { kind: 'in_progress' };
        this.db.prepare('UPDATE idempotency_keys SET created_at = ? WHERE actor_user_id = ? AND key = ?').run(this.clock.now().toISOString(), userId, key);
        return { kind: 'claimed' };
      }
      return { kind: 'replay', status: row.status ?? 200, body: readJson(row.response_json, null) };
    })();
  }

  complete(userId: string, key: string, status: number, body: unknown): void {
    this.db.prepare("UPDATE idempotency_keys SET state = 'complete', status = ?, response_json = ? WHERE actor_user_id = ? AND key = ?")
      .run(status, writeJson(body), userId, key);
  }

  /** A failed request releases its key so the client can retry with it. */
  release(userId: string, key: string): void {
    this.db.prepare("DELETE FROM idempotency_keys WHERE actor_user_id = ? AND key = ? AND state = 'pending'").run(userId, key);
  }

  prune(): number {
    const cutoff = new Date(this.clock.now().getTime() - IDEMPOTENCY_RETENTION_MS).toISOString();
    return this.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff).changes;
  }
}
