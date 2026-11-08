// Agent Studio: presentation, per-person drafts, streaming previews, applying a draft through
// Magnus, HiveSkills catalog installs, development records with comments, and Magnus New Agent. The
// agent itself (identity, skills, model) lives in Ardent and changes only through Magnus, as the acting person.
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import { ConfigEditError, configuredSkills, editConfig, modelPath } from '../../agents/config-edit.js';
import { operationView } from '../../agents/operations.js';
import {
  agentOperationSchema, ARDENT_SERVICE_CAN_RESTART, ardentTaskDoneEventSchema, ardentTaskEventSchema, ardentTaskTextEventSchema, MagnusError, parseAgentRef,
  type MagnusAgentOperation,
} from '../../clients/magnus.js';
import { ARDENT_FINISHED } from '../../conductor/follower.js';
import type { AgentDraft } from '../../db/repos/agents.js';
import type { AgentTemplateBody } from '../../db/repos/templates.js';
import {
  agentRefSchema, APPLY_PARTS, IDEMPOTENCY_HEADER, idempotencyKeySchema,
  type applyRequestSchema, type applyResultSchema, type createDevelopmentCommentRequestSchema, type developmentQuerySchema, type installSkillRequestSchema, type newAgentRequestSchema,
  type previewRequestSchema, type putAgentDraftRequestSchema, type putPresentationRequestSchema,
} from '../../shared/browser.js';
import { actorOf, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

type ApplyResult = z.infer<typeof applyResultSchema>;
const ACTIVE = ['queued', 'running', 'pausing', 'paused'];

/** What Magnus's refusals of an agent change mean for the person applying it. */
const APPLY_REFUSALS: Readonly<Record<string, string>> = {
  ACTING_ADMIN_REQUIRED: 'Magnus applies agent changes only for a Magnus ADMIN. Ask an ADMIN to apply this draft.',
  ACTING_SUBJECT_UNLINKED: 'Your sign-in is not linked to a Magnus account, so Magnus cannot apply changes for you.',
  CONFIG_PATH_FORBIDDEN: 'Magnus refused a configuration change outside the settings Studio may change.',
  CONFLICT: 'The agent changed since this draft was saved. Reload the agent and save the draft again.',
};
/** Magnus skill-install refusals that explain themselves. */
const SKILL_INSTALL_REFUSALS: readonly string[] = ['HIVESKILLS_UNCONFIGURED', 'SKILL_VERSION_UNAVAILABLE', 'SKILL_CONFLICT', 'SKILL_ARCHIVE_INVALID'];
const RESTART_UNAVAILABLE = 'Studio cannot restart an agent: Magnus does not let its service identity run service-restart. Restart the profile from the Magnus console.';

function requireRef(value: string | undefined): string {
  const parsed = agentRefSchema.safeParse(value);
  if (!parsed.success) throw notFound('Agent');
  return parsed.data;
}

/** Magnus refusals keep their meaning; anything else is Magnus being unreachable. */
function magnusError(error: unknown, upgradeCode = 'AGENT_UPGRADE_REQUIRED'): never {
  if (error instanceof MagnusError) {
    if (error.code === 'AGENT_UPGRADE_REQUIRED') throw new ApiError(409, upgradeCode, error.message);
    if (error.status === 403) throw new ApiError(403, error.code, `Magnus refused: ${error.message}`);
    if (error.status === 409) throw new ApiError(409, error.code === 'CONFLICT' ? 'MAGNUS_CONFLICT' : error.code, error.message);
    if (error.status === 400 || error.status === 422) throw new ApiError(422, 'MAGNUS_REJECTED', error.message);
    if (error.status === 404) throw new ApiError(404, 'NOT_FOUND', error.message);
  }
  throw new ApiError(503, 'MAGNUS_UNAVAILABLE', `Magnus could not be reached: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
}

const draftView = (draft: AgentDraft | undefined) => draft ? { agent_ref: draft.agent_ref, user_id: draft.user_id, base: draft.base, draft: draft.draft, created_at: draft.created_at, updated_at: draft.updated_at } : null;

export function agentStudioRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, magnus } = deps;

  // Registered before /agents/{agentRef}/… so the static segment wins.
  register('GET', '/agents/operations/{operationId}', async (_c, { params }) => {
    const record = /^[A-Za-z0-9_-]{1,128}$/.test(params.operationId ?? '') ? store.agents.operation(params.operationId!) : undefined;
    if (!record) throw notFound('Operation');
    try {
      const current = await magnus.agentOperation(record.id);
      deps.operations.apply(record.id, current);
      return { body: operationView(store.agents.operation(record.id)!, current) };
    } catch {
      const stored = agentOperationSchema.safeParse(record.operation);
      return { body: operationView(record, stored.success ? stored.data : undefined) };
    }
  });

  register('POST', '/agents', async (_c, { body, principal, idempotencyKey }) => {
    const input = body as z.infer<typeof newAgentRequestSchema>;
    const actor = actorOf(principal);
    let template: AgentTemplateBody | undefined;
    if (input.template) {
      const version = store.templates.version(input.template.template_id, input.template.version);
      if (!version || version.kind !== 'agent') throw new ApiError(422, 'UNKNOWN_TEMPLATE', 'template is not an agent template version');
      template = version.body as AgentTemplateBody;
    }
    const soul = input.soul_md ?? template?.soul_md ?? '';
    const identity = input.identity_md ?? template?.identity_md ?? '';
    if (!soul.trim() || !identity.trim()) throw new ApiError(422, 'IDENTITY_REQUIRED', 'Give soul_md and identity_md, or an agent template that has them');
    if (input.role_key && !input.project_id) throw new ApiError(422, 'PROJECT_REQUIRED', 'role_key needs project_id');
    const project = input.project_id ? requireProject(store, input.project_id) : undefined;
    const skills = input.skills ?? (template?.skills ?? []).filter(skill => skill.kind === 'local' && /^[A-Za-z0-9_-]{1,100}$/.test(skill.ref)).map(skill => skill.ref);
    const ref = `${input.node_id}~${input.profile}`;
    let accepted: { operationId: string };
    try {
      accepted = await magnus.createAgent({ nodeId: input.node_id, profile: input.profile, ...(input.api_port !== undefined ? { apiPort: input.api_port } : {}),
        soul_md: soul, identity_md: identity, model: input.model, skills, hivemem: true,
        ...(input.artifacts_max_bytes !== undefined ? { artifacts_max_bytes: input.artifacts_max_bytes } : {}) }, { actingSubject: actor.subject });
    } catch (error) { magnusError(error); }
    const record = store.tx(() => {
      const created = store.agents.recordOperation({ id: accepted.operationId, agentRef: ref, projectId: project?.id ?? null, roleKey: input.role_key ?? null, createdBy: actor.userId });
      if (template && !store.agents.presentation(ref)) {
        store.agents.savePresentation({ agentRef: ref, portrait: template.avatar_preset, avatarFileId: null, displayName: template.name, updatedBy: actor.userId });
      }
      if (project) store.emit(project.id, 'agent.operation.updated', { operation: operationView(created, undefined) });
      store.record(actor, 'agent.create', { type: 'agent', id: ref }, { operation_id: created.id, template: input.template ?? null, skills: skills.length }, idempotencyKey);
      return created;
    });
    deps.operations.follow(record.id);
    return { status: 201, body: operationView(record, undefined) };
  });

  register('GET', '/agents/{agentRef}/presentation', (_c, { params }) => {
    const ref = requireRef(params.agentRef);
    const saved = store.agents.presentation(ref);
    return { body: saved
      ? { agent_ref: ref, display_name: saved.display_name, portrait: saved.portrait, avatar_file_id: saved.avatar_file_id, updated_by: saved.updated_by, updated_at: saved.updated_at }
      : { agent_ref: ref, display_name: null, portrait: null, avatar_file_id: null, updated_by: null, updated_at: null } };
  });

  register('PUT', '/agents/{agentRef}/presentation', (_c, { params, body, principal, idempotencyKey }) => {
    const ref = requireRef(params.agentRef);
    const input = body as z.infer<typeof putPresentationRequestSchema>;
    if (input.avatar_file_id && store.files.get(input.avatar_file_id)?.purpose !== 'avatar') throw new ApiError(422, 'UNKNOWN_FILE', 'avatar_file_id must be a file uploaded with purpose avatar');
    const actor = actorOf(principal);
    const saved = store.tx(() => {
      const next = store.agents.savePresentation({ agentRef: ref, portrait: input.portrait, avatarFileId: input.avatar_file_id, displayName: input.display_name, updatedBy: actor.userId });
      store.record(actor, 'agent.presentation', { type: 'agent', id: ref }, {}, idempotencyKey);
      return next;
    });
    return { body: { agent_ref: ref, display_name: saved.display_name, portrait: saved.portrait, avatar_file_id: saved.avatar_file_id, updated_by: saved.updated_by, updated_at: saved.updated_at } };
  });

  register('GET', '/agents/{agentRef}/draft', (_c, { params, principal }) => ({ body: { draft: draftView(store.agents.draft(requireRef(params.agentRef), actorOf(principal).userId)) } }));

  register('PUT', '/agents/{agentRef}/draft', async (_c, { params, body, principal, idempotencyKey }) => {
    const ref = requireRef(params.agentRef);
    const input = body as z.infer<typeof putAgentDraftRequestSchema>;
    const actor = actorOf(principal);
    const base: Record<string, unknown> = { ...input.base };
    // A draft remembers what it was based on, so Apply never overwrites a newer revision.
    for (const kind of ['soul', 'identity'] as const) {
      if (input.draft[kind] === undefined || base[`${kind}_revision`]) continue;
      try {
        base[`${kind}_revision`] = (await magnus.identity(ref, kind, { actingSubject: actor.subject })).revision;
      } catch { /* Saved without a base: Apply will ask for one rather than guess. */ }
    }
    if ((input.draft.skills_enabled !== undefined || input.draft.model !== undefined) && !base.config_revision) {
      try {
        base.config_revision = (await magnus.config(ref, { actingSubject: actor.subject })).revision;
      } catch { /* Reading the configuration needs a Magnus ADMIN; Apply reports CONFIG_REVISION_REQUIRED without it. */ }
    }
    const saved = store.tx(() => {
      const draft = store.agents.saveDraft({ agentRef: ref, userId: actor.userId, base, draft: input.draft });
      store.record(actor, 'agent.draft.save', { type: 'agent', id: ref }, { parts: Object.keys(input.draft) }, idempotencyKey);
      return draft;
    });
    return { body: { draft: draftView(saved) } };
  });

  register('DELETE', '/agents/{agentRef}/draft', (_c, { params, principal, idempotencyKey }) => {
    const ref = requireRef(params.agentRef);
    const actor = actorOf(principal);
    store.tx(() => {
      if (store.agents.deleteDraft(ref, actor.userId)) store.record(actor, 'agent.draft.discard', { type: 'agent', id: ref }, {}, idempotencyKey);
    });
    return { body: { draft: null } };
  });

  register('POST', '/agents/{agentRef}/preview', async (c, { params, body, principal }) => {
    const ref = requireRef(params.agentRef);
    const { nodeId } = parseAgentRef(ref);
    const input = body as z.infer<typeof previewRequestSchema>;
    const actor = actorOf(principal);
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key !== undefined && !idempotencyKeySchema.safeParse(key).success) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${IDEMPOTENCY_HEADER}`);
    let level: number;
    try { level = await magnus.studioLevel(nodeId); } catch (error) { magnusError(error); }
    if (level < 2) throw new ApiError(409, 'PREVIEW_UNAVAILABLE', `Previews need the Magnus agent on node ${nodeId} at Studio level 2 with Ardent 2.2.0; upgrade the agent from the Magnus console`);
    const draft = input.use_draft ? store.agents.draft(ref, actor.userId)?.draft ?? {} : {};
    const overrides = Object.fromEntries(Object.entries(draft).filter(([name, value]) => ['soul', 'identity', 'skills_enabled', 'model'].includes(name) && value !== undefined));
    let taskId: string;
    let sessionId: string;
    try {
      sessionId = (await magnus.openSession(ref, { key: `studio-preview:${actor.userId}`, context: 'preview', ...(input.new_session ? { reset: true } : {}) })).id;
      taskId = (await magnus.submitPreview(ref, { prompt: input.prompt, ...(Object.keys(overrides).length ? { overrides } : {}), session_id: sessionId,
        ...(key ? { idempotency_key: `studio-preview:${key}` } : {}) }, { actingSubject: actor.subject })).task_id;
    } catch (error) { magnusError(error, 'PREVIEW_UNAVAILABLE'); }
    store.tx(() => store.record(actor, 'agent.preview', { type: 'agent', id: ref }, { task_id: taskId, draft: Object.keys(overrides) }, key));
    c.header('cache-control', 'no-store');
    c.header('x-accel-buffering', 'no');
    return streamSSE(c, async stream => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
      await send('preview.accepted', { task_id: taskId, session_id: sessionId });
      let cursor = 0;
      const until = Date.now() + 30 * 60_000;
      try {
        while (!abort.signal.aborted && Date.now() < until) {
          let done = false;
          for await (const message of magnus.streamTask(ref, taskId, { after: cursor, signal: abort.signal })) {
            if (message.event === 'task.text' || message.event === 'task.delta') {
              const text = ardentTaskTextEventSchema.safeParse(JSON.parse(message.data) as unknown);
              if (text.success) await send(message.event === 'task.text' ? 'preview.text' : 'preview.delta', text.data);
            } else if (message.event === 'task.event') {
              const event = ardentTaskEventSchema.safeParse(JSON.parse(message.data) as unknown);
              if (!event.success) continue;
              cursor = event.data.sequence;
              await send('preview.event', { sequence: event.data.sequence, kind: event.data.kind });
            } else if (message.event === 'task.done') {
              const record = ardentTaskDoneEventSchema.safeParse(JSON.parse(message.data) as unknown);
              await send('preview.done', { task_id: taskId, state: record.success ? record.data.state : 'unknown',
                result: record.success ? record.data.result ?? null : null, error: record.success ? record.data.error ?? null : 'Unreadable final record' });
              done = true;
              break;
            }
          }
          if (done) return;
          // Ardent ends a stream after 60 seconds; a finished task may end before its done event.
          const task = await magnus.task(ref, taskId, { signal: abort.signal }).catch(() => undefined);
          if (task && (ARDENT_FINISHED as readonly string[]).includes(task.state)) {
            await send('preview.done', { task_id: taskId, state: task.state, result: task.result, error: task.error });
            return;
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) await send('preview.error', { code: 'STREAM_FAILED', message: error instanceof Error ? error.message.slice(0, 300) : 'The preview stream failed' });
      }
    });
  });

  register('POST', '/agents/{agentRef}/apply', async (_c, { params, body, principal, idempotencyKey }) => {
    const ref = requireRef(params.agentRef);
    const { parts } = body as z.infer<typeof applyRequestSchema>;
    const actor = actorOf(principal);
    const saved = store.agents.draft(ref, actor.userId);
    if (!saved) throw new ApiError(409, 'NO_DRAFT', 'Save a draft before applying it');
    const draft = { ...saved.draft } as Record<string, unknown>;
    const base = { ...saved.base } as Record<string, unknown>;
    const context = { actingSubject: actor.subject };
    const failed = (part: ApplyResult['part'], error: unknown, code?: string): ApplyResult => {
      if (error instanceof MagnusError) {
        const mapped = error.status === 400 ? 'INVALID_INPUT' : error.code;
        const explained = APPLY_REFUSALS[mapped];
        return { part, status: 'failed', error: explained ?? error.message.slice(0, 300), code: mapped, revision: null, activation_required: false };
      }
      if (error instanceof ConfigEditError) return { part, status: 'failed', error: error.message.slice(0, 300), code: error.code, revision: null, activation_required: false };
      return { part, status: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : String(error), code: code ?? 'FAILED', revision: null, activation_required: false };
    };
    const unchanged = (part: ApplyResult['part']): ApplyResult => ({ part, status: 'unchanged', error: null, code: null, revision: null, activation_required: false });
    // Skills and the model share the configuration revision: each change answers the next one.
    let configRevision = typeof base.config_revision === 'string' ? base.config_revision : undefined;
    const results: ApplyResult[] = [];
    for (const part of APPLY_PARTS.filter(item => parts.includes(item))) {
      if (part === 'soul' || part === 'identity') {
        const text = draft[part];
        if (typeof text !== 'string') { results.push(unchanged(part)); continue; }
        const revision = base[`${part}_revision`];
        if (typeof revision !== 'string') { results.push(failed(part, `The draft has no base ${part} revision; reload the agent and save the draft again`, 'BASE_REVISION_MISSING')); continue; }
        try {
          const answer = await magnus.saveIdentity(ref, part, { text, revision }, context);
          results.push({ part, status: 'applied', error: null, code: null, revision: answer.revision, activation_required: false });
          delete draft[part];
          delete base[`${part}_revision`];
        } catch (error) { results.push(failed(part, error)); }
      } else if (part === 'skills') {
        const wanted = draft.skills_enabled;
        if (!Array.isArray(wanted)) { results.push(unchanged(part)); continue; }
        if (!configRevision) { results.push(failed(part, 'Changing skills needs the agent\'s configuration revision (base.config_revision)', 'CONFIG_REVISION_REQUIRED')); continue; }
        let activation = false;
        let changed = 0;
        try {
          // The skill list reports the running profile; a switch changes the saved configuration, so
          // the draft is compared with that. A skill enabled since the last restart stays enabled.
          const [current, config] = await Promise.all([magnus.skills(ref, context), magnus.config(ref, context)]);
          const configured = new Set(configuredSkills(config.text));
          const changes = current.filter(skill => configured.has(skill.name) !== wanted.includes(skill.name));
          const unknown = (wanted as string[]).filter(name => !current.some(skill => skill.name === name));
          if (unknown.length) { results.push(failed(part, `The agent has no skills named ${unknown.join(', ')}`, 'UNKNOWN_SKILL')); continue; }
          for (const skill of changes) {
            const answer = await magnus.setSkill(ref, skill.name, { enabled: wanted.includes(skill.name), revision: configRevision }, context);
            configRevision = answer.revision;
            activation ||= answer.activation_required;
            changed++;
          }
          results.push(changed ? { part, status: 'applied', error: null, code: null, revision: configRevision, activation_required: activation } : unchanged(part));
          delete draft.skills_enabled;
        } catch (error) {
          // Skills already switched stay switched: the draft keeps the rest, based on the newest revision.
          const result = failed(part, error);
          results.push(changed ? { ...result, error: `${result.error ?? ''} ${changed} skill change${changed === 1 ? ' was' : 's were'} applied before this.`.trim(), activation_required: activation } : result);
        }
      } else {
        const model = draft.model;
        if (typeof model !== 'string') { results.push(unchanged(part)); continue; }
        if (!configRevision) { results.push(failed(part, 'Changing the model needs the agent\'s configuration revision (base.config_revision)', 'CONFIG_REVISION_REQUIRED')); continue; }
        try {
          const config = await magnus.config(ref, context);
          if (config.revision !== configRevision) throw new MagnusError('The configuration revision is stale', 409, 'CONFLICT');
          const path = modelPath(config.text);
          const text = editConfig(config.text, { [path]: model });
          if (text === config.text) { results.push(unchanged(part)); delete draft.model; continue; }
          const answer = await magnus.saveConfig(ref, { text, revision: configRevision }, context);
          configRevision = answer.revision;
          results.push({ part, status: 'applied', error: null, code: null, revision: answer.revision, activation_required: answer.activation_required });
          delete draft.model;
        } catch (error) { results.push(failed(part, error)); }
      }
    }
    // A draft that still changes configuration is based on the newest revision Studio produced.
    if (draft.skills_enabled !== undefined || draft.model !== undefined) {
      if (configRevision) base.config_revision = configRevision;
    } else delete base.config_revision;
    const binding = store.team.binding(ref);
    const active = binding ? (store.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE binding_id = ? AND state IN (${ACTIVE.map(() => '?').join(', ')})`)
      .get(binding.id, ...ACTIVE) as { n: number }).n : 0;
    const remaining = store.tx(() => {
      const left = Object.keys(draft).length
        ? store.agents.saveDraft({ agentRef: ref, userId: actor.userId, base, draft })
        : (store.agents.deleteDraft(ref, actor.userId), undefined);
      store.record(actor, 'agent.apply', { type: 'agent', id: ref }, { results: results.map(item => ({ part: item.part, status: item.status, code: item.code })) }, idempotencyKey);
      return left;
    });
    const applied = results.some(item => item.status === 'applied');
    const activation = results.some(item => item.activation_required);
    const notes = [
      applied && active ? `Applies from the agent's next turn; ${active} running task${active === 1 ? '' : 's'} keep${active === 1 ? 's' : ''} current instructions.` : '',
      activation ? 'Skill and model changes take effect after the agent\'s profile restarts; restart it from the Magnus console.' : '',
    ].filter(Boolean);
    return { body: { results, active_tasks: active, draft: draftView(remaining), note: notes.length ? notes.join(' ') : null,
      activation_required: activation, restart: { available: ARDENT_SERVICE_CAN_RESTART, reason: ARDENT_SERVICE_CAN_RESTART ? null : RESTART_UNAVAILABLE } } };
  });

  register('POST', '/agents/{agentRef}/skills/install', async (_c, { params, body, principal, idempotencyKey }) => {
    const ref = requireRef(params.agentRef);
    const input = body as z.infer<typeof installSkillRequestSchema>;
    const actor = actorOf(principal);
    let result;
    try {
      result = await magnus.installSkill(ref, input, { actingSubject: actor.subject });
    } catch (error) {
      // Magnus's own skill refusals say what to fix; keep their codes.
      if (error instanceof MagnusError && SKILL_INSTALL_REFUSALS.includes(error.code)) throw new ApiError(error.status === 422 ? 422 : error.status === 503 ? 503 : 409, error.code, error.message);
      if (error instanceof MagnusError && error.status === 400 && error.message === 'Invalid Ardent action')
        throw new ApiError(409, 'MAGNUS_UPGRADE_REQUIRED', 'This Magnus release cannot install catalog skills; upgrade Magnus first');
      magnusError(error);
    }
    store.record(actor, 'agent.skill.install', { type: 'agent', id: ref }, { source: result.source, name: result.name, version: result.version, sha256: result.sha256,
      changed: result.changed, enabled: result.enabled, enable_error: result.enable_error !== null }, idempotencyKey);
    return { body: { ...result, note: result.activation_required ? 'The skill takes effect after the agent\'s profile restarts; restart it from the Magnus console.' : null,
      restart: { available: ARDENT_SERVICE_CAN_RESTART, reason: ARDENT_SERVICE_CAN_RESTART ? null : RESTART_UNAVAILABLE } } };
  });

  register('GET', '/agents/{agentRef}/development', async (_c, { params, query, principal }) => {
    const ref = requireRef(params.agentRef);
    const filter = query as z.infer<typeof developmentQuerySchema>;
    try {
      const page = await magnus.development(ref, { ...(filter.after ? { after: filter.after } : {}), ...(filter.limit ? { limit: Number(filter.limit) } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
        { actingSubject: principal?.subject });
      const comments = store.agents.developmentCommentsFor(ref, page.records.map(record => record.id));
      return { body: { supported: true, reason: null, next: page.next, records: page.records.map(record => ({ ...record, comments: comments.get(record.id) ?? [] })) } };
    } catch (error) {
      if (error instanceof MagnusError && (error.code === 'AGENT_UPGRADE_REQUIRED' || error.status === 404)) {
        return { body: { supported: false, reason: error.code === 'AGENT_UPGRADE_REQUIRED' ? error.message : 'This runtime doesn\'t publish development records', records: [], next: null } };
      }
      magnusError(error);
    }
  });

  register('POST', '/agents/{agentRef}/development/{recordId}/comments', async (_c, { params, body, principal, idempotencyKey }) => {
    const ref = requireRef(params.agentRef);
    const recordId = params.recordId ?? '';
    if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(recordId)) throw notFound('Development record');
    const input = body as z.infer<typeof createDevelopmentCommentRequestSchema>;
    const actor = actorOf(principal);
    const comment = store.tx(() => {
      const created = store.agents.addDevelopmentComment({ agentRef: ref, recordRef: recordId, bodyMd: input.body_md, author: actor.userId });
      store.record(actor, 'agent.development.comment', { type: 'agent', id: ref }, { record_ref: recordId, relay: input.relay_to_agent }, idempotencyKey);
      return created;
    });
    let relayError: string | null = null;
    if (input.relay_to_agent) {
      try {
        await magnus.addDevelopmentNote(ref, { kind: 'operator_comment', title: `Comment on ${recordId}`.slice(0, 200), body: input.body_md.slice(0, 8000),
          sources: [{ kind: 'note', ref: recordId }], author: 'operator' }, { actingSubject: actor.subject });
      } catch (error) { relayError = error instanceof Error ? error.message.slice(0, 300) : 'The note could not be recorded'; }
    }
    return { status: 201, body: { comment, relayed: input.relay_to_agent && relayError === null, relay_error: relayError } };
  });
}

export type { MagnusAgentOperation };
