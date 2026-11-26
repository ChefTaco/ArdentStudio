// Removing a purged project's rows. Audit rows are never removed (the table is append-only), agent
// operations keep their row without the project, and the HiveMem sources of its references and
// links are handed back as retirements to queue. Blobs are removed afterwards, by the caller, once
// nothing references them.
import type { Db } from '../database.js';
import { hivememProjectId } from './projects.js';
import { knowledgeSourceId } from './files.js';
import { linkSourceId } from './links.js';
import type { RetirementInput } from './retirements.js';

export interface PurgedRows {
  removed: Record<string, number>;
  /** Blob digests the project's rows referenced; remove each once nothing else does. */
  blobs: string[];
  /** Artifact import ids, whose partial transfer files can go. */
  imports: number[];
  retirements: RetirementInput[];
}

const REVISIONS = 'SELECT r.id FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id WHERE d.project_id = ?';
const SYNCED = "(knowledge_revision IS NOT NULL OR knowledge_state NOT IN ('not_indexed', 'unsupported'))";

/** Delete every row of the project. Call inside a transaction. */
export function purgeProjectRows(db: Db, projectId: string): PurgedRows {
  const project = db.prepare('SELECT hivemem_workspace_id FROM projects WHERE id = ?').get(projectId) as { hivemem_workspace_id: string } | undefined;
  if (!project) throw new Error('Project not found');
  // Records of one project reference each other in every direction; the checks run at commit, when all are gone.
  db.pragma('defer_foreign_keys = ON');

  const shas = (sql: string, count = 1) => (db.prepare(sql).all(...Array<string>(count).fill(projectId)) as Array<{ sha: string }>).map(row => row.sha);
  const blobs = new Set([
    ...shas('SELECT sha256 AS sha FROM files WHERE project_id = ?'),
    ...shas(`SELECT blob_sha256 AS sha FROM deliverable_revisions WHERE id IN (${REVISIONS})`),
    ...shas(`SELECT sha256 AS sha FROM deliverable_renditions WHERE deliverable_revision_id IN (${REVISIONS})`),
    ...shas('SELECT blob_sha256 AS sha FROM exports WHERE project_id = ?'),
    ...shas('SELECT sha256 AS sha FROM artifact_imports WHERE project_id = ?'),
    ...shas(`SELECT blob_sha256 AS sha FROM docx_documents WHERE (source_kind = 'file' AND source_id IN (SELECT id FROM files WHERE project_id = ?))
      OR (source_kind = 'revision' AND source_id IN (${REVISIONS}))`, 2),
    ...shas(`SELECT document_sha256 AS sha FROM docx_documents WHERE (source_kind = 'file' AND source_id IN (SELECT id FROM files WHERE project_id = ?))
      OR (source_kind = 'revision' AND source_id IN (${REVISIONS}))`, 2),
  ]);
  const imports = (db.prepare('SELECT id FROM artifact_imports WHERE project_id = ?').all(projectId) as Array<{ id: number }>).map(row => row.id);

  // The same rule as deleting one file or link: a source that may have reached HiveMem is retired.
  const workspace = project.hivemem_workspace_id;
  const memProject = hivememProjectId(projectId);
  const files = db.prepare(`SELECT id, sha256, knowledge_source_id, knowledge_revision FROM files WHERE project_id = ? AND purpose = 'reference' AND ${SYNCED}`)
    .all(projectId) as Array<{ id: string; sha256: string; knowledge_source_id: string | null; knowledge_revision: string | null }>;
  const links = db.prepare(`SELECT id, url, knowledge_source_id, knowledge_revision FROM reference_links WHERE project_id = ? AND ${SYNCED}`)
    .all(projectId) as Array<{ id: string; url: string; knowledge_source_id: string; knowledge_revision: string | null }>;
  const retirements: RetirementInput[] = [
    ...files.map(file => ({ studio_project_id: projectId, workspace_id: workspace, hivemem_project_id: memProject, source_id: file.knowledge_source_id ?? knowledgeSourceId(file.id),
      source_uri: `ardentstudio://projects/${projectId}/files/${file.id}`, revision: `retired:${file.knowledge_revision ?? file.sha256}` })),
    ...links.map(link => ({ studio_project_id: projectId, workspace_id: workspace, hivemem_project_id: memProject, source_id: link.knowledge_source_id || linkSourceId(link.id),
      source_uri: link.url, revision: `retired:${link.knowledge_revision ?? 'none'}` })),
  ];

  const removed: Record<string, number> = {};
  const run = (name: string, sql: string, count = 1) => {
    const changes = db.prepare(sql).run(...Array<string>(count).fill(projectId)).changes;
    removed[name] = (removed[name] ?? 0) + changes;
  };
  run('docx_documents', `DELETE FROM docx_documents WHERE (source_kind = 'file' AND source_id IN (SELECT id FROM files WHERE project_id = ?))
    OR (source_kind = 'revision' AND source_id IN (${REVISIONS}))`, 2);
  run('renditions', `DELETE FROM deliverable_renditions WHERE deliverable_revision_id IN (${REVISIONS})`);
  run('review_comments', 'DELETE FROM review_comments WHERE project_id = ?');
  run('review_decisions', 'DELETE FROM review_decisions WHERE project_id = ?');
  run('artifact_imports', 'DELETE FROM artifact_imports WHERE project_id = ?');
  run('revisions', `DELETE FROM deliverable_revisions WHERE id IN (${REVISIONS})`);
  run('exports', 'DELETE FROM exports WHERE project_id = ?');
  run('deliverables', 'DELETE FROM deliverables WHERE project_id = ?');
  run('workflow_nodes', 'DELETE FROM workflow_nodes WHERE run_id IN (SELECT id FROM workflow_runs WHERE project_id = ?)');
  run('team_proposals', 'DELETE FROM team_proposals WHERE project_id = ?');
  run('agent_sessions', 'DELETE FROM agent_sessions WHERE project_id = ?');
  run('activity', 'DELETE FROM activity WHERE project_id = ?');
  run('tasks', 'DELETE FROM tasks WHERE project_id = ?');
  run('workflow_runs', 'DELETE FROM workflow_runs WHERE project_id = ?');
  run('messages', 'DELETE FROM messages WHERE project_id = ?');
  run('message_cursors', 'DELETE FROM message_cursors WHERE project_id = ?');
  run('conversations', 'DELETE FROM conversations WHERE project_id = ?');
  run('decisions', 'DELETE FROM decisions WHERE project_id = ?');
  run('room_layouts', 'DELETE FROM room_layouts WHERE project_id = ?');
  run('team_revisions', 'DELETE FROM team_assignment_revisions WHERE project_id = ?');
  run('team_assignments', 'DELETE FROM team_assignments WHERE project_id = ?');
  run('links', 'DELETE FROM reference_links WHERE project_id = ?');
  run('files', 'DELETE FROM files WHERE project_id = ?');
  run('requested_deliverables', 'DELETE FROM requested_deliverables WHERE project_id = ?');
  run('members', 'DELETE FROM project_members WHERE project_id = ?');
  run('events', 'DELETE FROM events WHERE project_id = ?');
  run('event_cursors', 'DELETE FROM project_event_cursors WHERE project_id = ?');
  // Magnus owns the agent; Studio's mirror of the operation stays, without the project.
  run('agent_operations_detached', 'UPDATE agent_operations SET project_id = NULL WHERE project_id = ?');
  run('projects', 'DELETE FROM projects WHERE id = ?');
  return { removed, blobs: [...blobs], imports, retirements };
}
