// Per-project access. A project in mode everyone (the default) is open to everyone linked: its
// creator is the owner and every other linked person an editor. In mode members only matching
// subjects and Oathweave roles have access, with the highest matching role. A Studio admin
// (ardentstudio:agents:admin) owns every project. Project roles only narrow: the route's
// Oathweave permissions are still required.
import type { Membership } from '../db/repos/members.js';
import type { Store } from '../db/store.js';
import type { ProjectRole } from '../shared/browser.js';
import type { Principal } from './authenticator.js';

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: ProjectRole | null, required: ProjectRole): boolean {
  return role !== null && RANK[role] >= RANK[required];
}

export function isStudioAdmin(principal: Principal): boolean {
  return principal.kind !== 'service' && principal.permissions.includes('ardentstudio:agents:admin');
}

/** The principal's role in a project with this membership, or null for no access. */
export function projectRole(principal: Principal, membership: Membership): ProjectRole | null {
  if (principal.kind === 'service') return null;
  if (isStudioAdmin(principal)) return 'owner';
  if (membership.mode === 'everyone') return membership.createdBy === principal.userId ? 'owner' : 'editor';
  const roles = new Set(principal.roles ?? []);
  let best: ProjectRole | null = null;
  for (const member of membership.members) {
    const matches = member.kind === 'subject'
      ? member.value === principal.subject && (member.issuer === '' || member.issuer === principal.issuer)
      : roles.has(member.value);
    if (matches && (best === null || RANK[member.role] > RANK[best])) best = member.role;
  }
  return best;
}

export class ProjectAccess {
  constructor(private readonly store: Store) {}

  /** The principal's role in the project, or null when it has none or the project does not exist. */
  roleIn(principal: Principal, projectId: string): ProjectRole | null {
    const membership = this.store.members.get(projectId);
    return membership ? projectRole(principal, membership) : null;
  }

  /** A check for many projects at once (lists): every project not in mode members is open. */
  roles(principal: Principal): (projectId: string, createdBy: string) => ProjectRole | null {
    const restricted = this.store.members.restricted();
    return (projectId, createdBy) => projectRole(principal, restricted.get(projectId) ?? { mode: 'everyone', revision: 0, createdBy, members: [] });
  }

  /** Whether the principal owns at least one project (and so can edit a members list). Admins own every project. */
  ownsAny(principal: Principal): boolean {
    if (principal.kind === 'service') return false;
    if (isStudioAdmin(principal)) return true;
    if (this.store.members.createdOpen(principal.userId)) return true;
    for (const membership of this.store.members.restricted().values()) if (projectRole(principal, membership) === 'owner') return true;
    return false;
  }

  /** Whether the principal can read a blob: some project it can see references it, or an agent portrait does. */
  canReadBlob(principal: Principal, sha256: string): boolean {
    const { projects, shared } = this.store.members.blobProjects(sha256);
    if (shared) return true;
    for (const projectId of projects) if (this.roleIn(principal, projectId) !== null) return true;
    return false;
  }
}
