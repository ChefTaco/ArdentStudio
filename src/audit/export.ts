// The suite audit export: Studio's append-only audit table as HiveAuditRecord v1, oldest first,
// keyset-paged on the table's monotonic id. Details are flattened to scalars, redacted with the
// suite's log redaction and capped at 4 KB; they never hold secrets or file contents. Details,
// action names, record ids, the export query and cursor reading, strict record validation and
// page building are the suite's shared audit kit (@hivemagnus/hive-common/audit); Studio keeps
// issuing its own `{ id }` cursor form, byte for byte, because collectors store it.
import {
  auditAction, auditDetails, auditExportPage, auditRecordId, parseAuditExportQuery,
  type AuditCursorPosition, type HiveAuditRecord as SharedAuditRecord, type HiveAuditScalar,
} from '@hivemagnus/hive-common/audit';
import { HiveError } from '@hivemagnus/hive-common/errors';
import { encodeCursor } from '@hivemagnus/hive-common/events';
import type { AuditEntry, AuditRepository } from '../db/repos/audit.js';
import { agentRefSchema, type HiveAuditRecord } from '../shared/browser.js';

export const AUDIT_EXPORT_DEFAULT_LIMIT = 100;
export const AUDIT_EXPORT_MAX_LIMIT = 200;
export const AUDIT_DETAILS_MAX_BYTES = 4096;
/** Detail keys that could carry content rather than metadata. None are recorded today; this keeps it so. */
const CONTENT_KEYS = ['body', 'body_md', 'content', 'text', 'prompt', 'brief', 'soul', 'identity', 'instructions', 'answer', 'message'];

export interface AuditExportPage {
  data: HiveAuditRecord[];
  nextCursor: string | null;
}

/**
 * The audit row id a cursor resumes after; 0 for the first page. The shared parser reads Studio's
 * `{ id }` form and the suite's `{ i }` form; Studio's table is ordered by a numeric id alone, so a
 * string id or a time-ordered `{ t, i }` cursor is refused like any malformed one (400 invalid_cursor).
 */
function afterId(position: AuditCursorPosition | undefined): number {
  if (position === undefined) return 0;
  if (typeof position.id !== 'number' || position.at !== undefined) throw new HiveError('invalid_cursor', 'The cursor is not valid', { status: 400 });
  return position.id;
}

/** Studio's cursor: base64url JSON `{ id }` of the last row read (`eyJpZCI6N30` for row 7). */
function encodeStudioCursor(position: AuditCursorPosition): string {
  return encodeCursor({ id: position.id });
}

/** Flat scalars only: arrays of scalars are joined, other arrays become a count, objects and content keys are dropped. */
export function flattenDetails(detail: Record<string, unknown>): Record<string, HiveAuditScalar> {
  return auditDetails(detail, { dropKeys: CONTENT_KEYS, maxBytes: AUDIT_DETAILS_MAX_BYTES });
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
    id: auditRecordId('ardentstudio', entry.id),
    product: 'ardentstudio',
    occurredAt: new Date(entry.at).toISOString(),
    // Stored names stay as recorded; the export maps them onto the record pattern
    // (template.import-definition is exported as template.import_definition).
    action: auditAction(entry.action),
    outcome: 'success',
    actor: actorOf(entry),
    ...(entry.target_type || entry.target_id ? { target: { ...(entry.target_type ? { type: entry.target_type } : {}), ...(entry.target_id ? { id: entry.target_id } : {}) } } : {}),
    ...(agentRef ? { subject: { agentRef, nodeId: agentRef.slice(0, agentRef.indexOf('~')) } } : {}),
    details: flattenDetails(entry.detail),
  };
}

/**
 * One export page for `?after=&limit=`. Throws a 400 HiveError for a malformed query.
 * `nextCursor` is the last row's cursor whenever the page read rows, even when it is the last
 * page, so a collector can store it and poll again; it is null only when nothing was read.
 * A row whose record does not validate is skipped (and counted through `onDropped`), and the
 * cursor still moves past it, so one bad row never stalls the collector.
 */
export function exportAuditPage(
  audit: AuditRepository,
  query: URLSearchParams | Readonly<Record<string, string | undefined>>,
  onDropped?: (count: number) => void,
): AuditExportPage {
  const { after, limit } = parseAuditExportQuery(query, { defaultLimit: AUDIT_EXPORT_DEFAULT_LIMIT, maxLimit: AUDIT_EXPORT_MAX_LIMIT });
  const entries = audit.listAfter(afterId(after), limit);
  const taskRefs = audit.taskAgentRefs(entries.filter(entry => entry.target_type === 'task').map(entry => entry.target_id));
  const page = auditExportPage(entries, {
    limit,
    // Studio's schema type allows explicit undefined on optional fields; the record never holds one.
    toRecord: entry => toAuditRecord(entry, taskRefs) as SharedAuditRecord,
    position: entry => ({ id: entry.id }),
    encodeCursor: encodeStudioCursor,
    ...(onDropped ? { onDropped } : {}),
  });
  return { data: page.data as HiveAuditRecord[], nextCursor: page.nextCursor };
}
