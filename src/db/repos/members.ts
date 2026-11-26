// Optional per-project membership: the mode on the project row and the listed members. Who may do
// what is decided in src/auth/project-access.ts; this module only stores and reads.
import type { z } from 'zod';
import type { projectMemberRequestSchema, ProjectRole, ProjectScopedParam } from '../../shared/browser.js';
import type { Db } from '../database.js';
import type { Clock } from '../json.js';

export type MembershipMode = 'everyone' | 'members';
export type ProjectMemberInput = z.output<typeof projectMemberRequestSchema>;

export interface StoredMember {
  kind: 'subject' | 'oathweave_role';
  /** '' matches any issuer (subjects) and is always '' for roles. */
  issuer: string;
  value: string;
  role: ProjectRole;
  added_by: string;
  added_at: string;
}

export interface Membership {
  mode: MembershipMode;
  revision: number;
  createdBy: string;
  members: StoredMember[];
}

/** Where to find the project of the record a path parameter names (deleted records too, so they stay private). */
const PROJECT_OF: Record<Exclude<ProjectScopedParam, 'projectId'>, string> = {
  linkId: 'SELECT project_id FROM reference_links WHERE id = ?',
  fileId: 'SELECT project_id FROM files WHERE id = ?',
  conversationId: 'SELECT project_id FROM conversations WHERE id = ?',
  messageId: 'SELECT project_id FROM messages WHERE id = ?',
  decisionId: 'SELECT project_id FROM decisions WHERE id = ?',
  taskId: 'SELECT project_id FROM tasks WHERE id = ?',
  deliverableId: 'SELECT project_id FROM deliverables WHERE id = ?',
  revisionId: 'SELECT d.project_id FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id WHERE r.id = ?',
  commentId: 'SELECT project_id FROM review_comments WHERE id = ?',
};

export class MembershipRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  get(projectId: string): Membership | undefined {
    const row = this.db.prepare('SELECT members_mode, members_revision, created_by FROM projects WHERE id = ?').get(projectId) as
      { members_mode: MembershipMode; members_revision: number; created_by: string } | undefined;
    if (!row) return undefined;
    const members = row.members_mode === 'members'
      ? this.db.prepare('SELECT kind, issuer, value, role, added_by, added_at FROM project_members WHERE project_id = ? ORDER BY kind DESC, value, issuer').all(projectId) as StoredMember[]
      : [];
    return { mode: row.members_mode, revision: row.members_revision, createdBy: row.created_by, members };
  }

  /** Every project in mode members, with its members, for filtering a list in one read. */
  restricted(): Map<string, Membership> {
    const projects = this.db.prepare("SELECT id, members_revision, created_by FROM projects WHERE members_mode = 'members'").all() as
      Array<{ id: string; members_revision: number; created_by: string }>;
    const result = new Map<string, Membership>(projects.map(project => [project.id, { mode: 'members', revision: project.members_revision, createdBy: project.created_by, members: [] }]));
    if (!projects.length) return result;
    const rows = this.db.prepare(`SELECT m.project_id, m.kind, m.issuer, m.value, m.role, m.added_by, m.added_at FROM project_members m
      JOIN projects p ON p.id = m.project_id WHERE p.members_mode = 'members'`).all() as Array<StoredMember & { project_id: string }>;
    for (const { project_id: projectId, ...member } of rows) result.get(projectId)?.members.push(member);
    return result;
  }

  /** Replace the membership and bump its revision. Call inside a transaction. */
  replace(projectId: string, mode: MembershipMode, members: readonly ProjectMemberInput[], addedBy: string): Membership {
    const now = this.clock.now().toISOString();
    const previous = new Map((this.get(projectId)?.members ?? []).map(member => [`${member.kind}\u0000${member.issuer}\u0000${member.value}`, member]));
    this.db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    const insert = this.db.prepare('INSERT INTO project_members (project_id, kind, issuer, value, role, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    if (mode === 'members') {
      for (const member of members) {
        const issuer = member.kind === 'subject' ? member.issuer ?? '' : '';
        const value = member.kind === 'subject' ? member.subject : member.name;
        // An unchanged entry keeps who added it and when.
        const kept = previous.get(`${member.kind}\u0000${issuer}\u0000${value}`);
        insert.run(projectId, member.kind, issuer, value, member.role, kept?.added_by ?? addedBy, kept?.added_at ?? now);
      }
    }
    this.db.prepare('UPDATE projects SET members_mode = ?, members_revision = members_revision + 1 WHERE id = ?').run(mode, projectId);
    return this.get(projectId)!;
  }

  /** The project of the record a path parameter names, or undefined when there is no such record. */
  projectOf(param: ProjectScopedParam, id: string): string | undefined {
    if (param === 'projectId') return id;
    const row = this.db.prepare(PROJECT_OF[param]).get(id) as { project_id: string } | undefined;
    return row?.project_id;
  }

  /**
   * Projects whose records reference this blob: files that are not deleted, deliverable revisions and
   * renditions, and exports. `shared` is true when an agent portrait uses it (portraits are shown in every project).
   */
  blobProjects(sha256: string): { projects: Set<string>; shared: boolean } {
    const rows = this.db.prepare(`SELECT project_id FROM files WHERE sha256 = ? AND deleted_at IS NULL
      UNION SELECT d.project_id FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id WHERE r.blob_sha256 = ?
      UNION SELECT d.project_id FROM deliverable_renditions n JOIN deliverable_revisions r ON r.id = n.deliverable_revision_id
        JOIN deliverables d ON d.id = r.deliverable_id WHERE n.sha256 = ?
      UNION SELECT project_id FROM exports WHERE blob_sha256 = ?`).all(sha256, sha256, sha256, sha256) as Array<{ project_id: string }>;
    const shared = Boolean(this.db.prepare(`SELECT 1 FROM agent_presentation a JOIN files f ON f.id = a.avatar_file_id
      WHERE f.sha256 = ? AND f.deleted_at IS NULL LIMIT 1`).get(sha256));
    return { projects: new Set(rows.map(row => row.project_id)), shared };
  }
}
