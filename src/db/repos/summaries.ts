// Project card facts derived from stored records only: open questions, review work, active tasks
// and the newest meaningful activity. Nothing here is cached except the counts last announced,
// which decide whether a change needs a project.updated event.
import type { z } from 'zod';
import type { lastActivitySchema, projectCountsSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import { readJson, writeJson } from '../json.js';
import type { TeamBody } from './team.js';

export type ProjectCounts = z.infer<typeof projectCountsSchema>;
export type LastActivity = z.infer<typeof lastActivitySchema>;

/** Event types whose records can change a count. Other events never trigger a recount. */
export const COUNT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.created', 'message.updated', 'task.created', 'task.updated', 'deliverable.revision.created', 'review.decision.created',
]);

const ACTIVE_STATES = "('queued', 'running', 'input_required', 'pausing', 'paused')";

const excerpt = (text: string, max = 120) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

interface Candidate { type: string; at: string; text: () => string }

export class ProjectSummaryRepository {
  constructor(private readonly db: Db) {}

  counts(projectId: string): ProjectCounts {
    const one = (sql: string) => (this.db.prepare(sql).get(projectId) as { n: number }).n;
    return {
      open_questions: one(`SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND kind = 'clarification'
        AND json_extract(links_json, '$.answer_message_id') IS NULL`),
      // A newer revision supersedes an unreviewed or changes_requested one, so each of these is the latest of its deliverable.
      review_pending: one(`SELECT COUNT(*) AS n FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id
        WHERE d.project_id = ? AND r.review_status IN ('unreviewed', 'changes_requested')`),
      active_tasks: one(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state IN ${ACTIVE_STATES}`),
    };
  }

  /** Project ids with review_pending > 0. */
  needingReview(): Set<string> {
    return new Set((this.db.prepare(`SELECT DISTINCT d.project_id AS id FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id
      WHERE r.review_status IN ('unreviewed', 'changes_requested')`).all() as Array<{ id: string }>).map(row => row.id));
  }

  /**
   * Recount and compare with the counts last announced. Returns the new counts when they changed
   * (and stores them), else undefined. Call inside the transaction that changed the records.
   */
  recount(projectId: string): ProjectCounts | undefined {
    const row = this.db.prepare('SELECT counts_json FROM projects WHERE id = ?').get(projectId) as { counts_json: string | null } | undefined;
    if (!row) return undefined;
    const counts = this.counts(projectId);
    const previous = readJson<ProjectCounts | null>(row.counts_json, null);
    if (previous && previous.open_questions === counts.open_questions && previous.review_pending === counts.review_pending
      && previous.active_tasks === counts.active_tasks) return undefined;
    this.db.prepare('UPDATE projects SET counts_json = ? WHERE id = ?').run(writeJson(counts), projectId);
    return counts;
  }

  /** The newest meaningful record, described from that record alone. */
  lastActivity(projectId: string, team: Pick<TeamBody, 'roles'> | undefined): LastActivity | null {
    const roleName = (key: string | null | undefined) => (key ? team?.roles.find(role => role.key === key)?.name ?? key : null);
    const get = <T>(sql: string): T | undefined => this.db.prepare(sql).get(projectId) as T | undefined;
    const candidates: Candidate[] = [];

    const message = get<{ kind: string; body_md: string; author_json: string; created_at: string }>(`SELECT kind, body_md, author_json, created_at FROM messages
      WHERE project_id = ? AND state <> 'streaming' AND body_md <> '' ORDER BY seq DESC LIMIT 1`);
    if (message) {
      candidates.push({ type: 'message.created', at: message.created_at, text: () => {
        const author = readJson<{ kind: string; user_id?: string; role_key?: string | null }>(message.author_json, { kind: 'system' });
        const body = excerpt(message.body_md);
        if (author.kind === 'system') return body;
        const who = author.kind === 'user' ? author.user_id ?? 'Someone' : roleName(author.role_key) ?? 'An agent';
        const verb = message.kind === 'clarification' ? ' asked' : message.kind === 'decision_proposal' ? ' proposed' : message.kind === 'summary' ? ' summarized' : '';
        return `${who}${verb}: ${body}`;
      } });
    }
    const decision = get<{ title: string; decided_by: string; created_at: string }>('SELECT title, decided_by, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    if (decision) candidates.push({ type: 'decision.created', at: decision.created_at, text: () => `${decision.decided_by} pinned a decision: ${excerpt(decision.title)}` });
    const revision = get<{ name: string; revision: number; producer_role: string | null; received_at: string }>(`SELECT d.name, r.revision, d.producer_role, r.received_at
      FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id WHERE d.project_id = ? ORDER BY r.received_at DESC, r.id DESC LIMIT 1`);
    if (revision) candidates.push({ type: 'deliverable.revision.created', at: revision.received_at, text: () => `${roleName(revision.producer_role) ?? 'An agent'} delivered ${excerpt(revision.name, 80)} r${revision.revision}` });
    const review = get<{ decision: string; decided_by: string; name: string; revision: number; created_at: string }>(`SELECT v.decision, v.decided_by, d.name, r.revision, v.created_at
      FROM review_decisions v JOIN deliverable_revisions r ON r.id = v.revision_id JOIN deliverables d ON d.id = r.deliverable_id
      WHERE v.project_id = ? ORDER BY v.created_at DESC, v.id DESC LIMIT 1`);
    if (review) {
      const verb = review.decision === 'accepted' ? 'accepted' : review.decision === 'rejected' ? 'rejected' : 'requested changes to';
      candidates.push({ type: 'review.decision.created', at: review.created_at, text: () => `${review.decided_by} ${verb} ${excerpt(review.name, 80)} r${review.revision}` });
    }
    const file = get<{ name: string; created_by: string; created_at: string }>("SELECT name, created_by, created_at FROM files WHERE project_id = ? AND purpose <> 'avatar' ORDER BY created_at DESC, id DESC LIMIT 1");
    if (file) candidates.push({ type: 'file.created', at: file.created_at, text: () => `${file.created_by} added ${excerpt(file.name, 80)}` });
    const link = get<{ title: string; created_by: string; created_at: string }>('SELECT title, created_by, created_at FROM reference_links WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1');
    if (link) candidates.push({ type: 'link.created', at: link.created_at, text: () => `${link.created_by} added the link ${excerpt(link.title, 80)}` });
    const published = get<{ revision: number; published_by: string; published_at: string }>(`SELECT revision, published_by, published_at FROM team_assignment_revisions
      WHERE project_id = ? AND published_at IS NOT NULL ORDER BY revision DESC LIMIT 1`);
    if (published) candidates.push({ type: 'team.revision.published', at: published.published_at, text: () => `${published.published_by} published team r${published.revision}` });
    const exported = get<{ revision_ids_json: string; created_by: string; created_at: string }>('SELECT revision_ids_json, created_by, created_at FROM exports WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    if (exported) {
      const count = readJson<string[]>(exported.revision_ids_json, []).length;
      candidates.push({ type: 'export.created', at: exported.created_at, text: () => `${exported.created_by} exported ${count} deliverable${count === 1 ? '' : 's'}` });
    }
    const project = get<{ created_by: string; created_at: string; archived_at: string | null }>('SELECT created_by, created_at, archived_at FROM projects WHERE id = ?');
    if (project) {
      candidates.push({ type: 'project.created', at: project.created_at, text: () => `${project.created_by} created the project` });
      if (project.archived_at) candidates.push({ type: 'project.archived', at: project.archived_at, text: () => 'The project was archived' });
    }
    // Newest wins; on a tie the earlier candidate (the more specific record) is kept.
    const newest = candidates.reduce<Candidate | undefined>((best, item) => (!best || item.at > best.at ? item : best), undefined);
    return newest ? { type: newest.type, at: newest.at, text: newest.text() } : null;
  }
}
