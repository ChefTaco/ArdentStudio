// The suite audit export: Studio's append-only audit table as HiveAuditRecord v1, oldest first,
// keyset-paged on the table's monotonic id. Details are flattened to scalars, redacted with the
// suite's log redaction and capped at 4 KB; they never hold secrets or file contents.
import { decodeCursor, encodeCursor, feedPage, parseFeedQuery } from '@hivemagnus/hive-common/events';
import { HiveError } from '@hivemagnus/hive-common/errors';
import { redact } from '@hivemagnus/hive-common/log';
import type { AuditEntry, AuditRepository } from '../db/repos/audit.js';
import { agentRefSchema, type HiveAuditRecord } from '../shared/browser.js';

export const AUDIT_EXPORT_DEFAULT_LIMIT = 100;
export const AUDIT_EXPORT_MAX_LIMIT = 200;
export const AUDIT_DETAILS_MAX_BYTES = 4096;
const MAX_STRING = 512;
/** Detail keys that could carry content rather than metadata. None are recorded today; this keeps it so. */
const CONTENT_KEYS = new Set(['body', 'body_md', 'content', 'text', 'prompt', 'brief', 'soul', 'identity', 'instructions', 'answer', 'message']);

type Scalar = string | number | boolean | null;

export interface AuditExportPage {
  data: HiveAuditRecord[];
  nextCursor: string | null;
}

/** The numeric id after a cursor; 0 for the first page. Throws a 400 HiveError for a malformed cursor. */
export function cursorPosition(after: string | undefined): number {
  if (after === undefined || after === '') return 0;
  const position = decodeCursor(after);
  const id = position.id;
  if (Object.keys(position).length !== 1 || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new HiveError('invalid_cursor', 'The cursor is not valid', { status: 400 });
  }
  return id;
}

function scalar(value: unknown): Scalar | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  return undefined;
}

/** Flat scalars only: arrays of scalars are joined, other arrays become a count, objects are dropped. */
export function flattenDetails(detail: Record<string, unknown>): Record<string, Scalar> {
  const redacted = redact(detail);
  const flat: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (CONTENT_KEYS.has(key.toLowerCase())) continue;
    const direct = scalar(value);
    if (direct !== undefined) { flat[key] = direct; continue; }
    if (Array.isArray(value)) {
      const items = value.map(item => scalar(item));
      if (items.every(item => item !== undefined && item !== null && typeof item !== 'boolean')) {
        const joined = scalar(items.join(','));
        if (joined !== undefined) flat[key] = joined;
      } else flat[`${key}_count`] = value.length;
    }
  }
  // Keep the record bounded: drop the longest values until the details fit.
  while (Buffer.byteLength(JSON.stringify(flat)) > AUDIT_DETAILS_MAX_BYTES) {
    const longest = Object.entries(flat).sort(([, a], [, b]) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!longest) break;
    delete flat[longest[0]];
    flat.truncated = true;
  }
  return flat;
}

function actorOf(entry: AuditEntry): HiveAuditRecord['actor'] {
  const userId = entry.actor_user_id;
  if (userId === 'system') return { type: 'system', id: 'system' };
  if (userId.startsWith('service:')) {
    return { type: 'service', id: entry.actor_subject ?? userId.slice('service:'.length), ...(entry.actor_issuer ? { issuer: entry.actor_issuer } : {}) };
  }
  return {
    type: 'user',
    id: entry.actor_subject ?? userId,
    ...(entry.actor_issuer ? { issuer: entry.actor_issuer } : {}),
    displayName: userId,
  };
}

/** The agent a record is about: an agent target, a task that ran on an agent, or a detail agent_ref. */
function agentRefOf(entry: AuditEntry, taskRefs: Map<string, string>): string | undefined {
  const candidates = [
    entry.target_type === 'agent' ? entry.target_id : undefined,
    entry.target_type === 'task' ? taskRefs.get(entry.target_id) : undefined,
    typeof entry.detail.agent_ref === 'string' ? entry.detail.agent_ref : undefined,
  ];
  return candidates.find(candidate => candidate !== undefined && agentRefSchema.safeParse(candidate).success);
}

export function toAuditRecord(entry: AuditEntry, taskRefs: Map<string, string> = new Map()): HiveAuditRecord {
  const agentRef = agentRefOf(entry, taskRefs);
  return {
    id: `ardentstudio:audit:${entry.id}`,
    product: 'ardentstudio',
    occurredAt: new Date(entry.at).toISOString(),
    action: entry.action.toLowerCase(),
    outcome: 'success',
    actor: actorOf(entry),
    target: { type: entry.target_type, id: entry.target_id },
    subject: agentRef ? { agentRef, nodeId: agentRef.slice(0, agentRef.indexOf('~')) } : {},
    details: flattenDetails(entry.detail),
  };
}

/** One export page for `?after=&limit=`. Throws a 400 HiveError for a malformed query. */
export function exportAuditPage(audit: AuditRepository, query: URLSearchParams | Readonly<Record<string, string | undefined>>): AuditExportPage {
  const { after, limit } = parseFeedQuery(query, { defaultLimit: AUDIT_EXPORT_DEFAULT_LIMIT, maxLimit: AUDIT_EXPORT_MAX_LIMIT });
  const entries = audit.listAfter(cursorPosition(after), limit + 1);
  const taskRefs = audit.taskAgentRefs(entries.filter(entry => entry.target_type === 'task').map(entry => entry.target_id));
  const page = feedPage(entries, limit, entry => encodeCursor({ id: entry.id }));
  return { data: page.data.map(entry => toAuditRecord(entry, taskRefs)), nextCursor: page.nextCursor };
}
