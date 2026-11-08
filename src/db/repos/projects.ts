import type { z } from 'zod';
import { newId } from '../../ids.js';
import type { projectSchema, requestedDeliverableRequestSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type Project = z.infer<typeof projectSchema>;
export type RequestedDeliverableInput = z.infer<typeof requestedDeliverableRequestSchema>;

interface ProjectRow {
  id: string; name: string; brief_md: string; audience: string | null; constraints_json: string; tags_json: string;
  status: 'active' | 'archived'; created_by: string; hivemem_workspace_id: string; hivemem_state: 'pending' | 'ready' | 'failed';
  hivemem_error: string | null; chattermost_channel_id: string | null; last_area: string | null;
  created_at: string; updated_at: string; archived_at: string | null;
}
interface DeliverableRow { id: string; project_id: string; position: number; name: string; kind: string; formats_json: string; stage: string | null; producer_role_key: string | null }

/** The HiveMem workspace for a project. HiveMem project IDs are lower case. */
export function hivememWorkspaceId(projectId: string): string {
  return `ardentstudio-${projectId.toLowerCase()}`;
}
export function hivememProjectId(projectId: string): string {
  return projectId.toLowerCase();
}

export class ProjectRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  create(input: { name: string; brief_md: string; audience: string | null; constraints: string[]; tags: string[]; deliverables: RequestedDeliverableInput[]; createdBy: string }): Project {
    const id = newId('project');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO projects (id, name, brief_md, audience, constraints_json, tags_json, status, created_by, hivemem_workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(id, input.name, input.brief_md, input.audience, writeJson(input.constraints),
      writeJson(input.tags), input.createdBy, hivememWorkspaceId(id), now, now);
    this.replaceDeliverables(id, input.deliverables);
    this.db.prepare('INSERT INTO team_assignments (project_id, updated_at) VALUES (?, ?)').run(id, now);
    return this.get(id)!;
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? this.toProject(row) : undefined;
  }

  list(filter: { status: 'active' | 'archived' | 'all'; q?: string | undefined }): Project[] {
    const rows = (filter.status === 'all'
      ? this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(filter.status)) as ProjectRow[];
    const projects = rows.map(row => this.toProject(row));
    const q = filter.q?.toLowerCase();
    if (!q) return projects;
    return projects.filter(project => project.name.toLowerCase().includes(q) || project.brief_md.toLowerCase().includes(q)
      || project.tags.some(tag => tag.toLowerCase().includes(q)));
  }

  update(id: string, patch: { name?: string | undefined; brief_md?: string | undefined; audience?: string | null | undefined; constraints?: string[] | undefined;
    tags?: string[] | undefined; last_area?: string | null | undefined; chattermost_channel_id?: string | null | undefined; deliverables?: RequestedDeliverableInput[] | undefined }): Project {
    const sets: string[] = [];
    const values: unknown[] = [];
    const column = (name: string, value: unknown) => { sets.push(`${name} = ?`); values.push(value); };
    if (patch.name !== undefined) column('name', patch.name);
    if (patch.brief_md !== undefined) column('brief_md', patch.brief_md);
    if (patch.audience !== undefined) column('audience', patch.audience);
    if (patch.constraints !== undefined) column('constraints_json', writeJson(patch.constraints));
    if (patch.tags !== undefined) column('tags_json', writeJson(patch.tags));
    if (patch.last_area !== undefined) column('last_area', patch.last_area);
    if (patch.chattermost_channel_id !== undefined) column('chattermost_channel_id', patch.chattermost_channel_id);
    column('updated_at', this.clock.now().toISOString());
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    if (patch.deliverables !== undefined) this.replaceDeliverables(id, patch.deliverables);
    return this.get(id)!;
  }

  setStatus(id: string, status: 'active' | 'archived'): Project {
    const now = this.clock.now().toISOString();
    this.db.prepare('UPDATE projects SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'archived' ? now : null, now, id);
    return this.get(id)!;
  }

  setHiveMemState(id: string, state: 'pending' | 'ready' | 'failed', error: string | null): void {
    this.db.prepare('UPDATE projects SET hivemem_state = ?, hivemem_error = ? WHERE id = ?').run(state, error, id);
  }

  pendingWorkspaces(): Project[] {
    return (this.db.prepare("SELECT * FROM projects WHERE hivemem_state <> 'ready'").all() as ProjectRow[]).map(row => this.toProject(row));
  }

  /** Keeps ids of entries whose name is unchanged, so references to them survive edits. */
  private replaceDeliverables(projectId: string, deliverables: RequestedDeliverableInput[]): void {
    const existing = new Map((this.db.prepare('SELECT * FROM requested_deliverables WHERE project_id = ?').all(projectId) as DeliverableRow[])
      .map(row => [row.name, row.id]));
    const keep = new Set<string>();
    const upsert = this.db.prepare(`INSERT INTO requested_deliverables (id, project_id, position, name, kind, formats_json, stage, producer_role_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET position = excluded.position, kind = excluded.kind,
      formats_json = excluded.formats_json, stage = excluded.stage, producer_role_key = excluded.producer_role_key`);
    deliverables.forEach((deliverable, position) => {
      const id = existing.get(deliverable.name) ?? newId('deliverableRequest');
      keep.add(id);
      upsert.run(id, projectId, position, deliverable.name, deliverable.kind, writeJson(deliverable.formats), deliverable.stage ?? null, deliverable.producer_role_key ?? null);
    });
    for (const id of existing.values()) {
      if (!keep.has(id)) this.db.prepare('DELETE FROM requested_deliverables WHERE id = ?').run(id);
    }
  }

  private toProject(row: ProjectRow): Project {
    const deliverables = (this.db.prepare('SELECT * FROM requested_deliverables WHERE project_id = ? ORDER BY position').all(row.id) as DeliverableRow[])
      .map(item => ({ id: item.id, name: item.name, kind: item.kind, formats: readJson<Project['deliverables'][number]['formats']>(item.formats_json, []),
        stage: item.stage as Project['deliverables'][number]['stage'], producer_role_key: item.producer_role_key }));
    return {
      id: row.id, name: row.name, brief_md: row.brief_md, audience: row.audience,
      constraints: readJson(row.constraints_json, []), tags: readJson(row.tags_json, []), status: row.status, created_by: row.created_by,
      hivemem: { workspace_id: row.hivemem_workspace_id, state: row.hivemem_state, error: row.hivemem_error },
      chattermost_channel_id: row.chattermost_channel_id, last_area: row.last_area as Project['last_area'], deliverables,
      created_at: row.created_at, updated_at: row.updated_at, archived_at: row.archived_at,
    };
  }
}
