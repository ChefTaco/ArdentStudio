import type { AgentDirectory } from '../agents/directory.js';
import type { OperationRelay } from '../agents/operations.js';
import type { Authenticator, Principal } from '../auth/authenticator.js';
import type { IdentityLink } from '../auth/links.js';
import { roleAtLeast, type ProjectAccess } from '../auth/project-access.js';
import type { BlobStore } from '../blobs/store.js';
import type { HiveMemClient } from '../clients/hivemem.js';
import type { MagnusClient } from '../clients/magnus.js';
import type { Conductor } from '../conductor/conductor.js';
import type { LiveText } from '../conductor/live.js';
import type { DocxConverter } from '../review/docx.js';
import type { AuditActor } from '../db/repos/audit.js';
import type { Project } from '../db/repos/projects.js';
import type { Store } from '../db/store.js';
import type { EventBus } from '../events/bus.js';
import type { KnowledgeSync } from '../knowledge/sync.js';
import type { Logger } from '../logger.js';
import type { ProjectRole } from '../shared/browser.js';
import type { TeamProposer } from '../team/proposals.js';
import { ApiError, notFound } from './errors.js';

export interface AppDeps {
  store: Store;
  blobs: BlobStore;
  bus: EventBus;
  authenticate: Authenticator;
  agents: AgentDirectory;
  hivemem: Pick<HiveMemClient, 'health'>;
  knowledge: Pick<KnowledgeSync, 'kick' | 'ensureWorkspace'>;
  conductor: Conductor;
  /** Live reply text of streaming messages. */
  live: LiveText;
  magnus: MagnusClient;
  /** Team proposals asked of an agent (§3.2.4). */
  proposer: Pick<TeamProposer, 'propose'>;
  /** Relays Magnus New Agent operations to the project stream. */
  operations: OperationRelay;
  /** The canvas Word codec, once its package is installed. Without it DOCX conversion answers 501. */
  docx?: DocxConverter | undefined;
  logger: Logger;
  /** SSE heartbeat interval. Default 15 s. */
  heartbeatMs?: number;
  /** How often an open stream re-checks its token. Default 5 s. */
  streamRecheckMs?: number;
  /** Aborted when the service shuts down: open event streams end so the HTTP server can close. */
  closing?: AbortSignal | undefined;
  /** Per-project access. createApp provides it when absent. */
  access?: ProjectAccess;
  /** The account links, listed by GET /people. */
  people?: readonly IdentityLink[];
}

/** AppDeps as the routes see them. */
export type RouteDeps = AppDeps & { access: ProjectAccess };

export function actorOf(principal: Principal | undefined): AuditActor {
  if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required');
  return { userId: principal.userId, subject: principal.subject, issuer: principal.issuer };
}

export function requireProject(store: Store, id: string | undefined): Project {
  const project = id ? store.projects.get(id) : undefined;
  if (!project) throw notFound('Project');
  return project;
}

/**
 * Require a project role. No access at all answers 404 with `what` (the record the route names), so
 * a project's records are not confirmed to people outside it; too low a role answers 403.
 */
export function requireProjectRole(access: ProjectAccess, principal: Principal | undefined, projectId: string, required: ProjectRole, what = 'Project'): ProjectRole {
  if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required');
  const role = access.roleIn(principal, projectId);
  if (role === null) throw notFound(what);
  if (!roleAtLeast(role, required)) throw new ApiError(403, 'PROJECT_ROLE_REQUIRED', `This needs the ${required} role in the project`, { required, role });
  return role;
}

export function requireActive(project: Project): Project {
  if (project.status !== 'active') throw new ApiError(409, 'PROJECT_ARCHIVED', 'The project is archived; reopen it to make changes');
  return project;
}
