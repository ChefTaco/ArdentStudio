import type { z } from 'zod';
import { newId } from '../../ids.js';
import type {
  agentTemplateBodySchema, teamTemplateBodySchema, templateDetailSchema, templateKindSchema, templateSourceSchema,
  templateSummarySchema, templateVersionSchema, templateVersionSummarySchema,
} from '../../shared/browser.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type TemplateKind = z.infer<typeof templateKindSchema>;
export type TemplateSource = z.infer<typeof templateSourceSchema>;
export type AgentTemplateBody = z.infer<typeof agentTemplateBodySchema>;
export type TeamTemplateBody = z.infer<typeof teamTemplateBodySchema>;
export type TemplateSummary = z.infer<typeof templateSummarySchema>;
export type TemplateVersion = z.infer<typeof templateVersionSchema>;
export type TemplateVersionSummary = z.infer<typeof templateVersionSummarySchema>;
export type TemplateDetail = z.infer<typeof templateDetailSchema>;

type Body<K extends TemplateKind> = K extends 'agent' ? AgentTemplateBody : TeamTemplateBody;

interface TemplateRow {
  id: string; slug: string; source: TemplateSource; archived: number; latest_version: number; name: string; category: string;
  purpose: string; created_by: string; created_at: string; updated_at: string;
}
interface VersionRow { template_id: string; version: number; body_json: string; changelog: string; created_by: string; created_at: string }

const TABLES = {
  agent: { templates: 'agent_templates', versions: 'agent_template_versions' },
  team: { templates: 'team_templates', versions: 'team_template_versions' },
} as const;

export class TemplateConflictError extends Error {
  override name = 'TemplateConflictError';
}

export class TemplateRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  kindOf(id: string): TemplateKind | undefined {
    if (this.db.prepare('SELECT 1 FROM team_templates WHERE id = ?').get(id)) return 'team';
    if (this.db.prepare('SELECT 1 FROM agent_templates WHERE id = ?').get(id)) return 'agent';
    return undefined;
  }

  idForSlug(kind: TemplateKind, slug: string): string | undefined {
    return (this.db.prepare(`SELECT id FROM ${TABLES[kind].templates} WHERE slug = ?`).get(slug) as { id: string } | undefined)?.id;
  }

  /** A free slug derived from the name, suffixed when taken. */
  freeSlug(kind: TemplateKind, base: string): string {
    const root = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'template';
    for (let index = 1; ; index++) {
      const slug = index === 1 ? root : `${root}-${index}`;
      if (!this.idForSlug(kind, slug)) return slug;
    }
  }

  create<K extends TemplateKind>(kind: K, input: { slug: string; source: TemplateSource; body: Body<K>; changelog: string; createdBy: string }): string {
    if (this.idForSlug(kind, input.slug)) throw new TemplateConflictError(`A ${kind} template with slug ${input.slug} already exists`);
    const id = newId('template');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO ${TABLES[kind].templates} (id, slug, source, archived, latest_version, name, category, purpose, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?)`).run(id, input.slug, input.source, input.body.name, input.body.category, input.body.purpose,
      input.createdBy, now, now);
    this.db.prepare(`INSERT INTO ${TABLES[kind].versions} (template_id, version, body_json, changelog, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?)`)
      .run(id, writeJson(input.body), input.changelog, input.createdBy, now);
    return id;
  }

  /** Add an immutable version on top of baseVersion. A stale base is a conflict, never a silent overwrite. */
  addVersion<K extends TemplateKind>(kind: K, id: string, input: { baseVersion: number; body: Body<K>; changelog: string; createdBy: string }): number {
    const row = this.row(kind, id);
    if (!row) throw new Error('Template not found');
    if (row.latest_version !== input.baseVersion) throw new TemplateConflictError(`Version ${row.latest_version} is newer than base_version ${input.baseVersion}`);
    const version = row.latest_version + 1;
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO ${TABLES[kind].versions} (template_id, version, body_json, changelog, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, version, writeJson(input.body), input.changelog, input.createdBy, now);
    this.db.prepare(`UPDATE ${TABLES[kind].templates} SET latest_version = ?, name = ?, category = ?, purpose = ?, updated_at = ? WHERE id = ?`)
      .run(version, input.body.name, input.body.category, input.body.purpose, now, id);
    return version;
  }

  setArchived(kind: TemplateKind, id: string, archived: boolean): void {
    this.db.prepare(`UPDATE ${TABLES[kind].templates} SET archived = ?, updated_at = ? WHERE id = ?`).run(archived ? 1 : 0, this.clock.now().toISOString(), id);
  }

  summary(id: string): TemplateSummary | undefined {
    const kind = this.kindOf(id);
    const row = kind && this.row(kind, id);
    return kind && row ? this.toSummary(kind, row) : undefined;
  }

  detail(id: string): TemplateDetail | undefined {
    const summary = this.summary(id);
    if (!summary) return undefined;
    const latest = this.version(id, summary.latest_version);
    if (!latest) return undefined;
    return { ...summary, versions: this.versions(summary.kind, id), latest };
  }

  version(id: string, version: number): TemplateVersion | undefined {
    const kind = this.kindOf(id);
    if (!kind) return undefined;
    const row = this.db.prepare(`SELECT * FROM ${TABLES[kind].versions} WHERE template_id = ? AND version = ?`).get(id, version) as VersionRow | undefined;
    if (!row) return undefined;
    const base = { template_id: row.template_id, version: row.version, changelog: row.changelog, created_by: row.created_by, created_at: row.created_at };
    return kind === 'agent'
      ? { ...base, kind: 'agent', body: readJson<AgentTemplateBody>(row.body_json, {} as AgentTemplateBody) }
      : { ...base, kind: 'team', body: readJson<TeamTemplateBody>(row.body_json, {} as TeamTemplateBody) };
  }

  list(filter: { kind?: TemplateKind | undefined; source?: TemplateSource | undefined; archived: 'true' | 'false' | 'all'; q?: string | undefined }): TemplateSummary[] {
    const kinds: TemplateKind[] = filter.kind ? [filter.kind] : ['team', 'agent'];
    const q = filter.q?.toLowerCase();
    return kinds.flatMap(kind => (this.db.prepare(`SELECT * FROM ${TABLES[kind].templates} ORDER BY source DESC, name`).all() as TemplateRow[])
      .filter(row => (!filter.source || row.source === filter.source)
        && (filter.archived === 'all' || (filter.archived === 'true') === Boolean(row.archived))
        && (!q || row.name.toLowerCase().includes(q) || row.purpose.toLowerCase().includes(q) || row.category.toLowerCase().includes(q) || row.slug.includes(q)))
      .map(row => this.toSummary(kind, row)));
  }

  private versions(kind: TemplateKind, id: string): TemplateVersionSummary[] {
    return this.db.prepare(`SELECT version, changelog, created_by, created_at FROM ${TABLES[kind].versions} WHERE template_id = ? ORDER BY version DESC`)
      .all(id) as TemplateVersionSummary[];
  }

  private row(kind: TemplateKind, id: string): TemplateRow | undefined {
    return this.db.prepare(`SELECT * FROM ${TABLES[kind].templates} WHERE id = ?`).get(id) as TemplateRow | undefined;
  }

  /** Projects whose draft or published team uses the template (team: as its source; agent: as a role's template). */
  private usedBy(kind: TemplateKind, id: string): number {
    const sql = kind === 'team'
      ? "SELECT COUNT(DISTINCT project_id) AS n FROM team_assignment_revisions WHERE status IN ('draft', 'published') AND source_template_id = ?"
      : "SELECT COUNT(DISTINCT project_id) AS n FROM team_assignment_revisions WHERE status IN ('draft', 'published') AND instr(body_json, ?) > 0";
    return (this.db.prepare(sql).get(kind === 'team' ? id : `"template_id":"${id}"`) as { n: number }).n;
  }

  private toSummary(kind: TemplateKind, row: TemplateRow): TemplateSummary {
    return {
      id: row.id, kind, slug: row.slug, source: row.source, archived: Boolean(row.archived), name: row.name, category: row.category,
      purpose: row.purpose, latest_version: row.latest_version, used_by: this.usedBy(kind, row.id), created_at: row.created_at, updated_at: row.updated_at,
    };
  }
}
