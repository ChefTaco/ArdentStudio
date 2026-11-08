import type { AgentDirectory } from '../agents/directory.js';
import type { Authenticator, Principal } from '../auth/oathweave.js';
import type { BlobStore } from '../blobs/store.js';
import type { HiveMemClient } from '../clients/hivemem.js';
import type { AuditActor } from '../db/repos/audit.js';
import type { Project } from '../db/repos/projects.js';
import type { Store } from '../db/store.js';
import type { EventBus } from '../events/bus.js';
import type { KnowledgeSync } from '../knowledge/sync.js';
import type { Logger } from '../logger.js';
import { ApiError, notFound } from './errors.js';

export interface AppDeps {
  store: Store;
  blobs: BlobStore;
  bus: EventBus;
  authenticate: Authenticator;
  agents: AgentDirectory;
  hivemem: Pick<HiveMemClient, 'health'>;
  knowledge: Pick<KnowledgeSync, 'kick' | 'ensureWorkspace'>;
  logger: Logger;
  /** SSE heartbeat interval. Default 15 s. */
  heartbeatMs?: number;
  /** How often an open stream re-checks its token. Default 5 s. */
  streamRecheckMs?: number;
}

export function actorOf(principal: Principal | undefined): AuditActor {
  if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required');
  return { userId: principal.userId, subject: principal.subject, issuer: principal.issuer };
}

export function requireProject(store: Store, id: string | undefined): Project {
  const project = id ? store.projects.get(id) : undefined;
  if (!project) throw notFound('Project');
  return project;
}

export function requireActive(project: Project): Project {
  if (project.status !== 'active') throw new ApiError(409, 'PROJECT_ARCHIVED', 'The project is archived; reopen it to make changes');
  return project;
}
