import type { z } from 'zod';
import type { ReferenceLink } from '../../db/repos/links.js';
import { linkIdSchema, type createLinkRequestSchema, type updateLinkRequestSchema } from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

/** The WHATWG serialization, so the same address is stored and compared one way. */
const normalize = (url: string) => new URL(url).href;

export function linkRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store } = deps;

  const requireLink = (id: string | undefined): ReferenceLink => {
    const parsed = linkIdSchema.safeParse(id);
    const link = parsed.success ? store.links.get(parsed.data) : undefined;
    if (!link || link.deleted_at) throw notFound('Link');
    return link;
  };

  const ensureUnique = (projectId: string, url: string, except?: string) => {
    const existing = store.links.findByUrl(projectId, url);
    if (existing && existing.id !== except) throw new ApiError(409, 'LINK_EXISTS', 'The project already has this link', { link_id: existing.id });
  };

  register('POST', '/projects/{projectId}/links', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof createLinkRequestSchema>;
    const url = normalize(input.url);
    ensureUnique(project.id, url);
    const actor = actorOf(principal);
    const link = store.tx(() => {
      const created = store.links.create({ projectId: project.id, url, title: input.title, noteMd: input.note_md, createdBy: actor.userId });
      store.emit(project.id, 'link.created', { link: created });
      store.record(actor, 'link.create', { type: 'link', id: created.id }, { project_id: project.id, url }, idempotencyKey);
      return created;
    });
    deps.knowledge.kick();
    return { status: 201, body: link };
  });

  register('GET', '/projects/{projectId}/links', (_c, { params }) => ({ body: { links: store.links.list(requireProject(store, params.projectId).id) } }));

  register('PATCH', '/links/{linkId}', (_c, { params, body, principal, idempotencyKey }) => {
    const link = requireLink(params.linkId);
    requireActive(requireProject(store, link.project_id));
    const patch = body as z.infer<typeof updateLinkRequestSchema>;
    const url = patch.url === undefined ? undefined : normalize(patch.url);
    if (url !== undefined) ensureUnique(link.project_id, url, link.id);
    const actor = actorOf(principal);
    const updated = store.tx(() => {
      const next = store.links.update(link.id, { url, title: patch.title, noteMd: patch.note_md });
      store.emit(link.project_id, 'link.updated', { link: next });
      store.record(actor, 'link.update', { type: 'link', id: link.id }, { fields: Object.keys(patch) }, idempotencyKey);
      return next;
    });
    deps.knowledge.kick();
    return { body: updated };
  });

  register('DELETE', '/links/{linkId}', (_c, { params, principal, idempotencyKey }) => {
    const link = requireLink(params.linkId);
    requireActive(requireProject(store, link.project_id));
    const actor = actorOf(principal);
    const deleted = store.tx(() => {
      const next = store.links.delete(link.id);
      store.emit(link.project_id, 'link.deleted', { link: next });
      store.record(actor, 'link.delete', { type: 'link', id: link.id }, { url: link.url }, idempotencyKey);
      return next;
    });
    deps.knowledge.kick();
    return { body: deleted };
  });

  register('POST', '/links/{linkId}/reindex', (_c, { params, principal, idempotencyKey }) => {
    const link = requireLink(params.linkId);
    requireActive(requireProject(store, link.project_id));
    const actor = actorOf(principal);
    const queued = store.tx(() => {
      const next = store.links.queueSync(link.id);
      store.emit(link.project_id, 'link.updated', { link: next });
      store.record(actor, 'link.reindex', { type: 'link', id: link.id }, {}, idempotencyKey);
      return next;
    });
    deps.knowledge.kick();
    return { body: queued };
  });
}
