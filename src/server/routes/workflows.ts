// Workflow runs: start one from an inline spec or a team template's workflow, read it, and act on
// its nodes. Starting a run is creating tasks in the project, so it takes the same permission and
// team checks as POST /projects/{projectId}/tasks; node tasks run with their team role's grants.
import type { z } from 'zod';
import { WorkflowError } from '../../conductor/workflows.js';
import type { WorkflowSourceTemplate, WorkflowSpec } from '../../db/repos/workflows.js';
import type { Store } from '../../db/store.js';
import {
  templateIdSchema, workflowRunIdSchema, workflowSpecSchema,
  type createWorkflowRunRequestSchema, type listWorkflowRunsQuerySchema, type workflowNodeActionRequestSchema,
} from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

function workflowError(error: unknown): never {
  if (error instanceof WorkflowError) throw new ApiError(error.status, error.code, error.message, error.details);
  throw error;
}

function requireRun(store: Store, projectId: string, id: string | undefined): string {
  const parsed = workflowRunIdSchema.safeParse(id);
  const run = parsed.success ? store.workflows.run(parsed.data) : undefined;
  if (!run || run.project_id !== projectId) throw notFound('Workflow run');
  return run.id;
}

/** The workflow a team template version defines, validated again as a spec. */
function templateWorkflow(store: Store, ref: { template_id: string; version: number }, key: string): { spec: WorkflowSpec; source: WorkflowSourceTemplate } {
  const id = templateIdSchema.safeParse(ref.template_id);
  const version = id.success ? store.templates.version(id.data, ref.version) : undefined;
  if (!version || version.kind !== 'team') throw new ApiError(422, 'UNKNOWN_TEMPLATE', 'template_ref is not a team template version');
  const workflow = version.body.workflows?.find(item => item.key === key);
  if (!workflow) throw new ApiError(422, 'UNKNOWN_WORKFLOW', `Team template version ${ref.version} has no workflow "${key}"`);
  const spec = workflowSpecSchema.parse(workflow.spec);
  return { spec: { ...spec, name: spec.name ?? workflow.name }, source: { template_id: version.template_id, version: version.version, workflow: workflow.key } };
}

export function workflowRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, conductor } = deps;
  const engine = conductor.workflows;

  register('GET', '/projects/{projectId}/workflow-runs', (_c, { params, query }) => {
    const project = requireProject(store, params.projectId);
    const filter = query as z.infer<typeof listWorkflowRunsQuerySchema>;
    return { body: { runs: engine.list(project.id, filter.state) } };
  });

  register('POST', '/projects/{projectId}/workflow-runs', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof createWorkflowRunRequestSchema>;
    const { spec, source } = input.spec ? { spec: input.spec, source: null } : templateWorkflow(store, input.template_ref!, input.workflow!);
    const actor = actorOf(principal);
    const run = store.tx(() => {
      const started = (() => {
        try { return engine.start({ project, spec, inputs: input.inputs ?? {}, sourceTemplate: source, createdBy: actor.userId }); } catch (error) { return workflowError(error); }
      })();
      store.record(actor, 'workflow.start', { type: 'workflow_run', id: started.id }, {
        nodes: spec.nodes.length, output: spec.output, spec_sha256: started.spec_sha256, template_id: source?.template_id ?? null, workflow: source?.workflow ?? null,
      }, idempotencyKey);
      return started;
    });
    conductor.kick();
    return { status: 201, body: run };
  });

  register('GET', '/projects/{projectId}/workflow-runs/{runId}', (_c, { params }) => {
    const project = requireProject(store, params.projectId);
    return { body: engine.view(requireRun(store, project.id, params.runId)) };
  });

  register('POST', '/projects/{projectId}/workflow-runs/{runId}/nodes/{nodeKey}/actions', async (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const runId = requireRun(store, project.id, params.runId);
    const input = body as z.infer<typeof workflowNodeActionRequestSchema>;
    const actor = actorOf(principal);
    const run = await engine.act(runId, params.nodeKey ?? '', input.action,
      detail => store.record(actor, `workflow.${input.action}`, { type: 'workflow_run', id: runId }, detail, idempotencyKey)).catch(workflowError);
    return { body: run };
  });
}
