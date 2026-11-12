import type { z } from 'zod';
import { newId } from '../../ids.js';
import type { teamBodySchema, teamRevisionSchema, templateRefSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type TeamBody = z.infer<typeof teamBodySchema>;
export type TeamRevision = z.infer<typeof teamRevisionSchema>;
export type TemplateRef = z.infer<typeof templateRefSchema>;

interface RevisionRow {
  id: string; project_id: string; revision: number; status: TeamRevision['status']; source_template_id: string | null;
  source_template_version: number | null; body_json: string; created_by: string; created_at: string; updated_at: string;
  published_by: string | null; published_at: string | null;
}

export interface AgentBinding { id: string; agent_ref: string; display_name: string | null; created_at: string; updated_at: string }

export class TeamConflictError extends Error {
  override name = 'TeamConflictError';
}

const toRevision = (row: RevisionRow): TeamRevision => ({
  id: row.id, project_id: row.project_id, revision: row.revision, status: row.status,
  source_template: row.source_template_id && row.source_template_version ? { template_id: row.source_template_id, version: row.source_template_version } : null,
  body: readJson<TeamBody>(row.body_json, { roles: [], relationships: [], stages: [] }),
  created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, published_by: row.published_by, published_at: row.published_at,
});

export class TeamRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  pointers(projectId: string): { current: number | null; draft: number | null } {
    const row = this.db.prepare('SELECT current_revision, draft_revision FROM team_assignments WHERE project_id = ?').get(projectId) as
      { current_revision: number | null; draft_revision: number | null } | undefined;
    return { current: row?.current_revision ?? null, draft: row?.draft_revision ?? null };
  }

  revision(projectId: string, revision: number): TeamRevision | undefined {
    const row = this.db.prepare('SELECT * FROM team_assignment_revisions WHERE project_id = ? AND revision = ?').get(projectId, revision) as RevisionRow | undefined;
    return row ? toRevision(row) : undefined;
  }

  current(projectId: string): TeamRevision | undefined {
    const { current } = this.pointers(projectId);
    return current ? this.revision(projectId, current) : undefined;
  }

  draft(projectId: string): TeamRevision | undefined {
    const { draft } = this.pointers(projectId);
    return draft ? this.revision(projectId, draft) : undefined;
  }

  /** Create the draft, or replace its body. The draft is always one past the newest revision. */
  saveDraft(projectId: string, input: { baseRevision: number | null; body: TeamBody; sourceTemplate: TemplateRef | null | undefined; userId: string }): TeamRevision {
    const pointers = this.pointers(projectId);
    if (pointers.current !== input.baseRevision) {
      throw new TeamConflictError(`The published revision is r${pointers.current ?? 0}, not r${input.baseRevision ?? 0}`);
    }
    const now = this.clock.now().toISOString();
    const existing = pointers.draft ? this.revision(projectId, pointers.draft) : undefined;
    if (existing) {
      const source = input.sourceTemplate === undefined ? existing.source_template : input.sourceTemplate;
      this.db.prepare(`UPDATE team_assignment_revisions SET body_json = ?, source_template_id = ?, source_template_version = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'`).run(writeJson(input.body), source?.template_id ?? null, source?.version ?? null, now, existing.id);
      return this.revision(projectId, existing.revision)!;
    }
    const max = (this.db.prepare('SELECT MAX(revision) AS n FROM team_assignment_revisions WHERE project_id = ?').get(projectId) as { n: number | null }).n ?? 0;
    const revision = max + 1;
    const source = input.sourceTemplate ?? null;
    this.db.prepare(`INSERT INTO team_assignment_revisions (id, project_id, revision, status, source_template_id, source_template_version, body_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`).run(newId('teamRevision'), projectId, revision, source?.template_id ?? null, source?.version ?? null,
      writeJson(input.body), input.userId, now, now);
    this.db.prepare('UPDATE team_assignments SET draft_revision = ?, updated_at = ? WHERE project_id = ?').run(revision, now, projectId);
    return this.revision(projectId, revision)!;
  }

  /** The draft becomes current; the previous current revision is superseded. */
  publish(projectId: string, draftRevision: number, userId: string): TeamRevision {
    const pointers = this.pointers(projectId);
    if (pointers.draft !== draftRevision) throw new TeamConflictError(`r${draftRevision} is not the current draft`);
    const now = this.clock.now().toISOString();
    if (pointers.current) {
      this.db.prepare("UPDATE team_assignment_revisions SET status = 'superseded', updated_at = ? WHERE project_id = ? AND revision = ?").run(now, projectId, pointers.current);
    }
    this.db.prepare("UPDATE team_assignment_revisions SET status = 'published', published_by = ?, published_at = ?, updated_at = ? WHERE project_id = ? AND revision = ?")
      .run(userId, now, now, projectId, draftRevision);
    this.db.prepare('UPDATE team_assignments SET current_revision = ?, draft_revision = NULL, updated_at = ? WHERE project_id = ?').run(draftRevision, now, projectId);
    return this.revision(projectId, draftRevision)!;
  }

  /** Every project and role an agent is bound to in a current or draft team. */
  rolesForAgents(): Array<{ agent_ref: string; project_id: string; project_name: string; role_key: string; role_name: string }> {
    const rows = this.db.prepare(`SELECT r.project_id, p.name AS project_name, r.body_json FROM team_assignment_revisions r
      JOIN team_assignments a ON a.project_id = r.project_id AND r.revision = COALESCE(a.draft_revision, a.current_revision)
      JOIN projects p ON p.id = r.project_id WHERE p.status = 'active'`).all() as Array<{ project_id: string; project_name: string; body_json: string }>;
    return rows.flatMap(row => readJson<TeamBody>(row.body_json, { roles: [], relationships: [], stages: [] }).roles
      .filter(role => role.agent_ref)
      .map(role => ({ agent_ref: role.agent_ref!, project_id: row.project_id, project_name: row.project_name, role_key: role.key, role_name: role.name })));
  }

  /** Ids of the projects where an agent is bound to a role in the published or the draft team. */
  projectsForAgent(agentRef: string): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT r.project_id FROM team_assignments a
      JOIN team_assignment_revisions r ON r.project_id = a.project_id AND r.revision IN (a.current_revision, a.draft_revision)
      WHERE EXISTS (SELECT 1 FROM json_each(r.body_json, '$.roles') role WHERE json_extract(role.value, '$.agent_ref') = ?)`).all(agentRef) as Array<{ project_id: string }>;
    return new Set(rows.map(row => row.project_id));
  }

  // ── Agent bindings: a stable Studio id per Magnus-managed agent ──

  ensureBinding(agentRef: string, displayName?: string | null): AgentBinding {
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO agent_bindings (id, agent_ref, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (agent_ref) DO NOTHING`).run(newId('binding'), agentRef, displayName ?? null, now, now);
    if (displayName) this.db.prepare('UPDATE agent_bindings SET display_name = ?, updated_at = ? WHERE agent_ref = ? AND display_name IS NOT ?').run(displayName, now, agentRef, displayName);
    return this.binding(agentRef)!;
  }

  binding(agentRef: string): AgentBinding | undefined {
    return this.db.prepare('SELECT * FROM agent_bindings WHERE agent_ref = ?').get(agentRef) as AgentBinding | undefined;
  }

  bindings(): AgentBinding[] {
    return this.db.prepare('SELECT * FROM agent_bindings ORDER BY agent_ref').all() as AgentBinding[];
  }
}
