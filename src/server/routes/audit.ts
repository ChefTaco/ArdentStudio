// The suite audit export (HiveAuditRecord v1). Read by Cindertrace with an Oathweave service
// token holding ardentstudio:audit:read, or by a linked Studio admin.
import { exportAuditPage } from '../../audit/export.js';
import type { AppDeps } from '../deps.js';
import type { createRouter } from '../routing.js';

export function auditRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  register('GET', '/audit/export', c => ({ body: exportAuditPage(deps.store.audit, new URL(c.req.url).searchParams) }));
}
