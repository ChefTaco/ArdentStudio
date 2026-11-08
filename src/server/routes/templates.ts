import type { z } from 'zod';
import type { AgentTemplateBody, TeamTemplateBody, TemplateKind } from '../../db/repos/templates.js';
import { TemplateConflictError } from '../../db/repos/templates.js';
import type { Store } from '../../db/store.js';
import {
  agentTemplateBodySchema, teamTemplateBodySchema, templateIdSchema,
  type archiveTemplateRequestSchema, type createTemplateRequestSchema, type createTemplateVersionRequestSchema, type listTemplatesQuerySchema,
} from '../../shared/browser.js';
import { validateTeam } from '../../team/validation.js';
import { credentialLikePaths } from '../../templates/secrets.js';
import { actorOf, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

export function requireTemplate(store: Store, id: string | undefined): { id: string; kind: TemplateKind } {
  const parsed = templateIdSchema.safeParse(id);
  const kind = parsed.success ? store.templates.kindOf(parsed.data) : undefined;
  if (!parsed.success || !kind) throw notFound('Template');
  return { id: parsed.data, kind };
}

/** Reject credentials, and team structures with errors, before anything is stored. */
export function checkTemplateBody(store: Store, kind: TemplateKind, body: AgentTemplateBody | TeamTemplateBody): void {
  const paths = credentialLikePaths(body);
  if (paths.length) throw new ApiError(422, 'CREDENTIAL_LIKE_VALUE', 'Templates must not contain credentials', { paths });
  if (kind !== 'team') return;
  const team = body as TeamTemplateBody;
  const validation = validateTeam({ mode: 'template', roles: team.roles, relationships: team.relationships });
  if (!validation.can_publish) throw new ApiError(422, 'TEAM_INVALID', 'The team has errors', { validation });
  for (const role of team.roles) {
    const ref = role.agent_template_ref;
    if (!ref) continue;
    const version = store.templates.version(ref.template_id, ref.version);
    if (!version || version.kind !== 'agent') throw new ApiError(422, 'UNKNOWN_AGENT_TEMPLATE', `Role ${role.key} names an agent template version that does not exist`);
  }
}

export function templateRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store } = deps;

  register('GET', '/templates', (_c, { query }) => ({ body: { templates: store.templates.list(query as z.infer<typeof listTemplatesQuerySchema>) } }));

  register('GET', '/templates/{templateId}', (_c, { params }) => ({ body: store.templates.detail(requireTemplate(store, params.templateId).id) }));

  register('GET', '/templates/{templateId}/versions/{version}', (_c, { params }) => {
    const { id } = requireTemplate(store, params.templateId);
    const number = /^\d{1,9}$/.test(params.version ?? '') ? Number(params.version) : NaN;
    const version = Number.isSafeInteger(number) ? store.templates.version(id, number) : undefined;
    if (!version) throw notFound('Template version');
    return { body: version };
  });

  register('POST', '/templates', (_c, { body, principal, idempotencyKey }) => {
    const input = body as z.infer<typeof createTemplateRequestSchema>;
    const actor = actorOf(principal);
    checkTemplateBody(store, input.kind, input.body);
    const slug = input.slug ?? store.templates.freeSlug(input.kind, input.body.name);
    try {
      const id = store.tx(() => {
        const created = input.kind === 'agent'
          ? store.templates.create('agent', { slug, source: 'user', body: input.body, changelog: input.changelog, createdBy: actor.userId })
          : store.templates.create('team', { slug, source: 'user', body: input.body, changelog: input.changelog, createdBy: actor.userId });
        store.record(actor, 'template.create', { type: 'template', id: created }, { kind: input.kind, slug }, idempotencyKey);
        return created;
      });
      return { status: 201, body: store.templates.detail(id) };
    } catch (error) {
      if (error instanceof TemplateConflictError) throw new ApiError(409, 'SLUG_TAKEN', error.message);
      throw error;
    }
  });

  register('POST', '/templates/{templateId}/versions', (_c, { params, body, principal, idempotencyKey }) => {
    const { id, kind } = requireTemplate(store, params.templateId);
    const input = body as z.infer<typeof createTemplateVersionRequestSchema>;
    const actor = actorOf(principal);
    const summary = store.templates.summary(id)!;
    if (summary.archived) throw new ApiError(409, 'TEMPLATE_ARCHIVED', 'Unarchive the template before adding a version');
    const parsed = kind === 'agent' ? agentTemplateBodySchema.safeParse(input.body) : teamTemplateBodySchema.safeParse(input.body);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', `The body is not a valid ${kind} template`);
    checkTemplateBody(store, kind, parsed.data);
    try {
      store.tx(() => {
        const version = kind === 'agent'
          ? store.templates.addVersion('agent', id, { baseVersion: input.base_version, body: parsed.data as AgentTemplateBody, changelog: input.changelog, createdBy: actor.userId })
          : store.templates.addVersion('team', id, { baseVersion: input.base_version, body: parsed.data as TeamTemplateBody, changelog: input.changelog, createdBy: actor.userId });
        store.record(actor, 'template.version', { type: 'template', id }, { version }, idempotencyKey);
      });
    } catch (error) {
      if (error instanceof TemplateConflictError) throw new ApiError(409, 'VERSION_CONFLICT', error.message, { latest_version: store.templates.summary(id)!.latest_version });
      throw error;
    }
    return { status: 201, body: store.templates.detail(id) };
  });

  register('POST', '/templates/{templateId}/archive', (_c, { params, body, principal, idempotencyKey }) => {
    const { id, kind } = requireTemplate(store, params.templateId);
    const { archived } = body as z.infer<typeof archiveTemplateRequestSchema>;
    const actor = actorOf(principal);
    store.tx(() => {
      store.templates.setArchived(kind, id, archived);
      store.record(actor, archived ? 'template.archive' : 'template.unarchive', { type: 'template', id }, {}, idempotencyKey);
    });
    return { body: store.templates.detail(id) };
  });
}
