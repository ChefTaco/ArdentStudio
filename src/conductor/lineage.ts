// The lineage of a Studio task (GET /tasks/{taskId}/lineage): its relationships in Studio, the
// Ardent lineage of each Ardent attempt as the profile records it (relayed through Magnus), and the
// filter that finds its provider traces in Emberpath. Attribution only: nothing reads this to grant
// access or to choose tools, memory, missions or artifacts.
import { ARDENT_RUNTIME_LEVELS, ARDENT_UNSUPPORTED_CAPABILITY, MagnusError, type ArdentProfileRuntime, type MagnusClient } from '../clients/magnus.js';
import type { StudioTask } from '../db/repos/tasks.js';
import type { Store } from '../db/store.js';
import { ardentTaskRef, studioRef } from './execution.js';

export interface LineageOptions {
  store: Store;
  magnus: Pick<MagnusClient, 'taskLineage'>;
  /** The profile's runtime levels (the conductor's cached read). */
  runtime: (agentRef: string) => Promise<ArdentProfileRuntime>;
  instance: string;
}

const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : 'unknown error';

export async function taskLineage(task: StudioTask, options: LineageOptions) {
  const { store, instance } = options;
  const self = task.execution?.self ?? studioRef(instance, 'task', task.id) ?? null;
  const entry = (item: StudioTask) => ({ task_id: item.id, ref: item.execution?.self ?? studioRef(instance, 'task', item.id) ?? null, role_key: item.role_key, state: item.state, mode: item.mode });
  const children = self ? store.tasks.withParent(task.project_id, self).filter(item => item.id !== task.id) : [];
  const from = typeof task.source.from_task === 'string' ? store.tasks.get(task.source.from_task) : undefined;
  const handedTo = store.tasks.list(task.project_id).filter(item => item.source.from_task === task.id);
  const reassignedFrom = task.reassigned_from ? store.tasks.get(task.reassigned_from) : undefined;
  const relationship = (item: StudioTask) => typeof item.source.relationship === 'string' ? item.source.relationship : null;
  const revisions = store.review.revisionsOfTask(task.id).map(revision => ({ revision_id: revision.id, deliverable_id: revision.deliverable_id, revision: revision.revision, blob_sha256: revision.blob_sha256 }));
  const studio = {
    self, root: task.root_ref ?? task.execution?.root ?? null, parent: task.parent_ref ?? task.execution?.parent ?? null,
    execution: task.execution ? { root: task.execution.root, parent: task.execution.parent ?? null, self: task.execution.self ?? null,
      attempt: task.execution.attempt ?? null, inputs: task.execution.inputs ?? [] } : null,
    children: children.map(entry),
    reassigned_from: reassignedFrom ? entry(reassignedFrom) : null,
    reassigned_to: store.tasks.reassignedFrom(task.id).map(entry),
    handoffs: [
      ...(from ? [{ ...entry(from), direction: 'from' as const, relationship: relationship(task) }] : []),
      ...handedTo.map(item => ({ ...entry(item), direction: 'to' as const, relationship: relationship(item) })),
    ],
    assignment_revision: task.assignment_revision,
    revisions,
    workflow: task.workflow ? { ...task.workflow, ref: studioRef(instance, 'workflow', task.workflow.run_id) ?? null } : null,
  };
  const { ardent, unavailable } = await ardentLineage(task, options);
  return { task_id: task.id, studio, ardent, ardent_unavailable: unavailable, emberpath: { filter: { executionRoot: studio.root } } };
}

async function ardentLineage(task: StudioTask, options: LineageOptions) {
  const agentRef = task.ardent.agent_ref;
  const ids = task.ardent.task_id ? [...task.ardent_attempts, task.ardent.task_id] : [];
  if (!agentRef || !ids.length) return { ardent: null, unavailable: { code: 'NOT_STARTED', message: 'The task has not started in Ardent' } };
  let runtime: ArdentProfileRuntime;
  try { runtime = await options.runtime(agentRef); } catch (error) {
    return { ardent: null, unavailable: { code: 'MAGNUS_UNAVAILABLE', message: `Magnus could not be reached: ${errorText(error)}` } };
  }
  if (runtime.lineage < ARDENT_RUNTIME_LEVELS.lineage) {
    return { ardent: null, unavailable: { code: 'LINEAGE_UNSUPPORTED',
      message: runtime.studio < 4 ? 'The agent\'s Magnus node agent cannot relay task lineage; upgrade the Magnus agent' : 'The agent runs an Ardent without task lineage; upgrade Ardent to 3.2.0 or later' } };
  }
  const attempts = [];
  for (const id of ids) {
    const base = { ardent_task_id: id, ref: ardentTaskRef(agentRef, id) ?? null, current: id === task.ardent.task_id };
    try {
      attempts.push({ ...base, lineage: await options.magnus.taskLineage(agentRef, id) as Record<string, unknown>, error: null });
    } catch (error) {
      if (error instanceof MagnusError && error.code === ARDENT_UNSUPPORTED_CAPABILITY) {
        return { ardent: null, unavailable: { code: 'LINEAGE_UNSUPPORTED', message: error.message } };
      }
      const code = error instanceof MagnusError ? (error.status === 404 ? 'NOT_FOUND' : error.code) : 'MAGNUS_UNAVAILABLE';
      attempts.push({ ...base, lineage: null, error: { code, message: errorText(error) } });
    }
  }
  return { ardent: { agent_ref: agentRef, attempts }, unavailable: null };
}
