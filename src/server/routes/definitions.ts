// Portable agent definitions (hive-agent-definition/1) from agent templates: build one from a version,
// import one as a new version, and check or create an agent from one through Magnus 3.3.0. Studio never
// installs anything itself: Magnus validates and installs the definition as the acting Magnus ADMIN.
import type { z } from 'zod';
import { operationView } from '../../agents/operations.js';
import { MagnusError } from '../../clients/magnus.js';
import type { AgentTemplateBody, SourceDefinition } from '../../db/repos/templates.js';
import { TemplateConflictError } from '../../db/repos/templates.js';
import type {
  definitionDeployCheckRequestSchema, definitionDeployRequestSchema, importDefinitionRequestSchema,
} from '../../shared/browser.js';
import { buildTemplateDefinition, DefinitionError, templateBodyFromDefinition, verifyAgentDefinition, type AgentDefinition } from '../../templates/definition.js';
import { credentialLikePaths } from '../../templates/secrets.js';
import { actorOf, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';
import { checkTemplateBody, requireTemplate } from './templates.js';

const MAGNUS_TOO_OLD = 'This Magnus release has no agent definitions (Magnus 3.3.0 adds them); upgrade Magnus first';

function definitionError(error: DefinitionError): ApiError {
  return new ApiError(422, error.code, error.message, error.paths ? { paths: error.paths } : undefined);
}

/**
 * Magnus's answers to the definition routes. A Magnus before 3.3.0 has no such route: it refuses the
 * service identity's request as outside its endpoint scope (403 FORBIDDEN) or does not know the route (404).
 */
function magnusDefinitionError(error: unknown): never {
  if (error instanceof MagnusError) {
    if (error.status === 404 && error.message === 'Managed node not found') throw new ApiError(404, 'NOT_FOUND', 'Node not found in Magnus');
    if (error.status === 404 || (error.status === 403 && error.code === 'FORBIDDEN')) throw new ApiError(409, 'MAGNUS_UPGRADE_REQUIRED', MAGNUS_TOO_OLD);
    if (error.status === 403) throw new ApiError(403, error.code, `Magnus refused: ${error.message}`);
    if (error.status === 409 && error.code === 'PREFLIGHT_FAILED') {
      const problems = (error.details as { problems?: unknown } | undefined)?.problems;
      throw new ApiError(409, 'PREFLIGHT_FAILED', error.message, { problems: Array.isArray(problems) ? problems.slice(0, 200) : [] });
    }
    if (error.status === 409) throw new ApiError(409, error.code === 'CONFLICT' ? 'MAGNUS_CONFLICT' : error.code, error.message);
    if (error.status === 400 || error.status === 422) throw new ApiError(422, error.code.startsWith('DEFINITION_') ? error.code : 'MAGNUS_REJECTED', error.message);
  }
  throw new ApiError(503, 'MAGNUS_UNAVAILABLE', `Magnus could not be reached: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
}

export function definitionRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, magnus } = deps;

  /** An agent template version and the definition built from it. */
  const versionDefinition = (params: Record<string, string>) => {
    const { id, kind } = requireTemplate(store, params.templateId);
    const number = /^\d{1,9}$/.test(params.version ?? '') ? Number(params.version) : NaN;
    const version = Number.isSafeInteger(number) ? store.templates.version(id, number) : undefined;
    if (!version) throw notFound('Template version');
    if (kind !== 'agent' || version.kind !== 'agent') throw new ApiError(422, 'NOT_AGENT_TEMPLATE', 'Only agent templates become agent definitions');
    try {
      return { version, ...buildTemplateDefinition(version) };
    } catch (error) {
      if (error instanceof DefinitionError) throw definitionError(error);
      throw error;
    }
  };

  register('POST', '/templates/{templateId}/versions/{version}/definition', (_c, { params }) => {
    const { definition, omitted } = versionDefinition(params);
    return { body: { definition, omitted } };
  });

  register('POST', '/templates/{templateId}/versions/{version}/deploy-check', async (_c, { params, body, principal }) => {
    const input = body as z.infer<typeof definitionDeployCheckRequestSchema>;
    const actor = actorOf(principal);
    const { definition, omitted } = versionDefinition(params);
    let preflight;
    try {
      preflight = await magnus.validateDefinition({ definition, nodeId: input.node_id, bindings: input.bindings }, { actingSubject: actor.subject });
    } catch (error) { magnusDefinitionError(error); }
    return { body: { definition: { name: definition.name, sha256: definition.sha256 }, omitted, preflight } };
  });

  register('POST', '/templates/{templateId}/versions/{version}/deploy', async (_c, { params, body, principal, idempotencyKey }) => {
    const input = body as z.infer<typeof definitionDeployRequestSchema>;
    const actor = actorOf(principal);
    if (input.role_key && !input.project_id) throw new ApiError(422, 'PROJECT_REQUIRED', 'role_key needs project_id');
    const project = input.project_id ? requireProject(store, input.project_id) : undefined;
    const { version, definition } = versionDefinition(params);
    let accepted: { operationId: string };
    try {
      accepted = await magnus.installDefinition({ definition, nodeId: input.node_id, name: input.profile, bindings: input.bindings, apiPort: input.api_port },
        { actingSubject: actor.subject });
    } catch (error) { magnusDefinitionError(error); }
    const ref = `${input.node_id}~${input.profile}`;
    const template = version.body as AgentTemplateBody;
    const record = store.tx(() => {
      const created = store.agents.recordOperation({ id: accepted.operationId, agentRef: ref, projectId: project?.id ?? null, roleKey: input.role_key ?? null, createdBy: actor.userId });
      if (!store.agents.presentation(ref)) {
        store.agents.savePresentation({ agentRef: ref, portrait: template.avatar_preset, avatarFileId: null, displayName: template.name, updatedBy: actor.userId });
      }
      if (project) store.emit(project.id, 'agent.operation.updated', { operation: operationView(created, undefined) });
      store.record(actor, 'agent.create', { type: 'agent', id: ref }, {
        operation_id: created.id, template: { template_id: version.template_id, version: version.version },
        definition: { name: definition.name, sha256: definition.sha256 }, skills: definition.skills.length,
      }, idempotencyKey);
      return created;
    });
    deps.operations.follow(record.id);
    return { status: 201, body: { ...operationView(record, undefined), kind: 'definition' as const } };
  });

  register('POST', '/templates/import-definition', (_c, { body, principal, idempotencyKey }) => {
    const input = body as z.infer<typeof importDefinitionRequestSchema>;
    const actor = actorOf(principal);
    // The whole request, as Magnus checks it: a credential anywhere is refused before anything is parsed.
    const leaked = credentialLikePaths(input);
    if (leaked.length) throw new ApiError(422, 'DEFINITION_CONTAINS_CREDENTIAL', `Credential-like values at ${leaked.slice(0, 10).join(', ')}`, { paths: leaked.slice(0, 50) });
    const checked = verifyAgentDefinition(input.definition);
    if (!checked.ok) throw new ApiError(422, checked.code, checked.detail, checked.paths ? { paths: checked.paths.slice(0, 50) } : undefined);
    const definition: AgentDefinition = checked.definition;

    // The template it becomes a version of: the one named, else the one it was built from when it is here.
    let target: { id: string; baseVersion: number } | undefined;
    if (input.template_id) {
      const { id, kind } = requireTemplate(store, input.template_id);
      if (kind !== 'agent') throw new ApiError(422, 'NOT_AGENT_TEMPLATE', 'A definition becomes a version of an agent template');
      if (input.base_version === undefined) throw new ApiError(400, 'VALIDATION_ERROR', 'base_version is required with template_id');
      target = { id, baseVersion: input.base_version };
    } else if (definition.source_template && store.templates.kindOf(definition.source_template.template_id) === 'agent') {
      target = { id: definition.source_template.template_id, baseVersion: input.base_version ?? definition.source_template.version };
    }

    const summary = target ? store.templates.summary(target.id)! : undefined;
    if (summary?.archived) throw new ApiError(409, 'TEMPLATE_ARCHIVED', 'Unarchive the template before adding a version');
    const latest = target ? store.templates.version(target.id, summary!.latest_version) : undefined;
    let mapped: ReturnType<typeof templateBodyFromDefinition>;
    try {
      mapped = templateBodyFromDefinition(definition, latest?.kind === 'agent' ? latest.body : undefined);
    } catch (error) {
      if (error instanceof DefinitionError) throw definitionError(error);
      throw error;
    }
    checkTemplateBody(store, 'agent', mapped.body);
    const source: SourceDefinition = { name: definition.name, sha256: definition.sha256 };
    const changelog = input.changelog ?? `Imported from the agent definition ${definition.name} (${definition.sha256.slice(0, 12)})`;
    let id: string;
    let version: number;
    try {
      ({ id, version } = store.tx(() => {
        const result = target
          ? { id: target.id, version: store.templates.addVersion('agent', target.id, { baseVersion: target.baseVersion, body: mapped.body, changelog, createdBy: actor.userId, sourceDefinition: source }) }
          : { id: store.templates.create('agent', { slug: store.templates.freeSlug('agent', mapped.body.name), source: 'user', body: mapped.body, changelog, createdBy: actor.userId, sourceDefinition: source }), version: 1 };
        store.record(actor, 'template.import-definition', { type: 'template', id: result.id },
          { version: result.version, created: !target, definition: source, ignored: mapped.ignored.length }, idempotencyKey);
        return result;
      }));
    } catch (error) {
      if (error instanceof TemplateConflictError && target) {
        throw new ApiError(409, 'VERSION_CONFLICT', error.message, { latest_version: store.templates.summary(target.id)!.latest_version });
      }
      throw error;
    }
    return { status: 201, body: { template: store.templates.detail(id), version, created: !target, source_definition: source, ignored: mapped.ignored } };
  });
}
