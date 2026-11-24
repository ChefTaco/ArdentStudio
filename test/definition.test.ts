import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentDefinitionSha256, agentPersonaSha256, canonicalJson, DEFINITION_MIN_ARDENT, definitionRuntimeVersion, sealAgentDefinition, verifyAgentDefinition,
  type AgentDefinition, type AgentDefinitionBody,
} from '../src/templates/definition.js';
import { credentialLikePaths } from '../src/templates/secrets.js';
import { createProject, createTestContext, json, waitFor, type TestContext } from './helpers.js';

// Produced by sealAgentDefinition of @hivemagnus/magnus-contracts (Magnus 3.3.0) from the bodies in its own tests.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-definition-v1.json', import.meta.url), 'utf8')) as {
  body: AgentDefinitionBody; sealed: AgentDefinition; canonical_body: string; persona_canonical: string; unicode: AgentDefinition;
  canonical_sample: { input: unknown; output: string };
};

let ctx: TestContext;
afterEach(() => ctx?.close());

const PIN = { version: '1.2.0', sha256: 'c'.repeat(64) };
const agentBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Archivist', category: 'research', purpose: 'Keeps the project archive tidy.', example_uses: ['Index notes'],
  soul_md: '# Archivist\n\nOrderly and kind.', identity_md: '# Identity\n\nThe project archivist.',
  skills: [{ kind: 'hiveskills', ref: 'web-research', ...PIN }, { kind: 'hiveskills', ref: 'summarize' }, { kind: 'local', ref: 'filing' }],
  model_hint: 'research-large', runtime_req: { ardent: '>=3.2.0', backend: 'any' }, integrations: ['hivemem', 'hiveskills'],
  expected_outputs: ['Index'], avatar_preset: { preset: 'silhouette-a', accent: 'blue', emblem: 'book' },
  ...overrides,
});
const github = () => ['gh', 'p_', 'x'.repeat(36)].join('');

async function userTemplate(body = agentBody()): Promise<{ id: string }> {
  const created = await ctx.call('POST', '/templates', { body: { kind: 'agent', body } });
  expect(created.status).toBe(201);
  return json(created);
}
async function exported(id: string, version = 1) {
  const response = await ctx.call('POST', `/templates/${id}/versions/${version}/definition`, { body: {} });
  expect(response.status).toBe(200);
  return json<{ definition: AgentDefinition; omitted: Array<{ kind: string; name: string; reason: string }> }>(response);
}

describe('hive-agent-definition/1 port', () => {
  it('seals and verifies exactly as magnus-contracts does', () => {
    expect(canonicalJson(fixture.canonical_sample.input)).toBe(fixture.canonical_sample.output);
    expect(canonicalJson({ b: [1, { d: 'x', c: undefined }], a: null })).toBe('{"a":null,"b":[1,{"d":"x"}]}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    const sealed = sealAgentDefinition(fixture.body);
    expect(sealed).toEqual(fixture.sealed);
    const { sha256: _sha, ...rest } = sealed;
    expect(canonicalJson(rest)).toBe(fixture.canonical_body);
    expect(canonicalJson({ soul_md: fixture.body.persona.soul_md, identity_md: fixture.body.persona.identity_md })).toBe(fixture.persona_canonical);
    expect(agentPersonaSha256(fixture.sealed.persona)).toBe(fixture.sealed.persona.sha256);
    expect(agentDefinitionSha256(fixture.unicode)).toBe(fixture.unicode.sha256);
    expect(verifyAgentDefinition(fixture.unicode)).toMatchObject({ ok: true });
    // Key order does not matter.
    expect(verifyAgentDefinition(Object.fromEntries(Object.entries(fixture.sealed).reverse()))).toEqual({ ok: true, definition: fixture.sealed });
  });

  it('refuses a changed definition, a changed persona, a fixed shape broken and credentials anywhere', () => {
    expect(verifyAgentDefinition({ ...fixture.sealed, name: 'Other' })).toMatchObject({ ok: false, code: 'DEFINITION_INVALID' });
    const persona = { ...fixture.sealed, persona: { ...fixture.sealed.persona, soul_md: '# Other\n' } };
    expect(verifyAgentDefinition({ ...persona, sha256: agentDefinitionSha256(persona) })).toMatchObject({ ok: false, detail: expect.stringMatching(/persona\.sha256/) });
    expect(verifyAgentDefinition({ ...fixture.sealed, excludes: ['history'] }).ok).toBe(false);
    expect(verifyAgentDefinition({ ...fixture.sealed, history: [] }).ok).toBe(false);
    const jwt = ['eyJ', 'a'.repeat(12), '.eyJ', 'b'.repeat(12), '.', 'c'.repeat(12)].join('');
    const userinfo = ['https://', 'user', ':', 'pass', '@example.com/'].join('');
    expect(credentialLikePaths({ a: [`token ${github()}`], b: { c: jwt }, d: userinfo, e: 'plain text' })).toEqual(['$.a[0]', '$.b.c', '$.d']);
    expect(credentialLikePaths({ [github()]: 'x' })).toEqual(['$[key]']);
    const leaked = verifyAgentDefinition({ ...fixture.body, persona: { ...fixture.body.persona, soul_md: `Bearer ${'z'.repeat(30)}` } });
    expect(leaked).toMatchObject({ ok: false, code: 'DEFINITION_CONTAINS_CREDENTIAL', paths: ['$.persona.soul_md'] });
  });

  it('names a runtime of the current Ardent major, or the later one a template asks for', () => {
    expect([null, '>=2.2.0', 'nonsense', '>=3.0.0', '3.1.4', '>=3.2.0', '^3.2.1', 'v4.0.0'].map(definitionRuntimeVersion))
      .toEqual([DEFINITION_MIN_ARDENT, '3.0.0', '3.0.0', '3.0.0', '3.1.4', '3.2.0', '3.2.1', '4.0.0']);
  });
});

describe('template definitions', () => {
  it('build a sealed, credential-free definition from a seed template, the same one every time', async () => {
    ctx = await createTestContext();
    const seed = ctx.store.templates.list({ kind: 'agent', archived: 'false' })[0]!;
    const version = ctx.store.templates.version(seed.id, 1)!;
    const answer = await exported(seed.id);
    expect(verifyAgentDefinition(answer.definition)).toEqual({ ok: true, definition: answer.definition });
    expect(credentialLikePaths(answer)).toEqual([]);
    expect(answer.definition).toMatchObject({
      schema: 'hive-agent-definition/1', name: seed.name, created_at: version.created_at, source_template: { template_id: seed.id, version: 1 },
      runtime: { package: '@hivemagnus/ardent', version: '3.0.0', required_capabilities: [] }, extensions: [], skills: [],
      config: { execution: { backend: 'llamacpp' }, model: {}, artifacts: {}, channels: 'excluded' },
      requirements: { bindings: [{ key: 'hivemem', kind: 'hivemem', required: true }, { key: 'model', kind: 'emberpath_alias', required: true }], secrets: [] },
      excludes: ['history', 'memory', 'sessions', 'artifacts'],
    });
    expect(answer.definition.persona).toMatchObject({ soul_md: version.kind === 'agent' ? version.body.soul_md : '', sha256: agentPersonaSha256(answer.definition.persona) });
    expect((await exported(seed.id)).definition.sha256).toBe(answer.definition.sha256);
  });

  it('carry pinned HiveSkills releases and the model alias, and list what they cannot carry', async () => {
    ctx = await createTestContext();
    const template = await userTemplate();
    const { definition, omitted } = await exported(template.id);
    expect(definition.skills).toEqual([{ slug: 'web-research', ...PIN }]);
    expect(definition.config.model).toEqual({ emberpath_alias: 'research-large' });
    expect(definition.runtime.version).toBe('3.2.0');
    expect(definition.requirements.bindings).toEqual([
      { key: 'hivemem', kind: 'hivemem', required: true }, { key: 'model', kind: 'emberpath_alias', required: false }, { key: 'hiveskills', kind: 'hiveskills', required: true },
    ]);
    expect(omitted.map(item => [item.kind, item.name])).toEqual([['skill', 'summarize'], ['skill', 'filing']]);
    expect(omitted[0]!.reason).toMatch(/Not pinned/);

    const spaced = await userTemplate(agentBody({ name: 'Spaced', model_hint: 'a model name' }));
    expect((await exported(spaced.id)).omitted).toContainEqual(expect.objectContaining({ kind: 'model', name: 'model_hint' }));
    const team = ctx.store.templates.list({ kind: 'team', archived: 'false' })[0]!;
    expect((await json(await ctx.call('POST', `/templates/${team.id}/versions/1/definition`, { body: {} }))).error.code).toBe('NOT_AGENT_TEMPLATE');
    expect((await ctx.call('POST', `/templates/${template.id}/versions/9/definition`, { body: {} })).status).toBe(404);
  });

  it('refuse a pinned skill without both version and digest, or a pin on a local skill', async () => {
    ctx = await createTestContext();
    for (const skill of [{ kind: 'hiveskills', ref: 'web-research', version: '1.2.0' }, { kind: 'local', ref: 'filing', ...PIN }]) {
      expect((await ctx.call('POST', '/templates', { body: { kind: 'agent', body: agentBody({ skills: [skill] }) } })).status).toBe(400);
    }
  });
});

describe('definition import', () => {
  it('round-trips: an exported definition becomes a new version with source_definition and the same persona and skills', async () => {
    ctx = await createTestContext();
    const template = await userTemplate();
    const first = await exported(template.id);
    const imported = await ctx.call('POST', '/templates/import-definition', { body: { definition: first.definition } });
    expect(imported.status).toBe(201);
    const answer = await json(imported);
    expect(answer).toMatchObject({ version: 2, created: false, source_definition: { name: 'Archivist', sha256: first.definition.sha256 }, ignored: [] });
    expect(answer.template).toMatchObject({ id: template.id, latest_version: 2 });
    const v2 = await json(await ctx.call('GET', `/templates/${template.id}/versions/2`));
    expect(v2.source_definition).toEqual({ name: 'Archivist', sha256: first.definition.sha256 });
    expect(v2.body).toEqual({ ...agentBody(), skills: [{ kind: 'hiveskills', ref: 'web-research', ...PIN }, { kind: 'local', ref: 'filing' }] });
    expect((await json(await ctx.call('GET', `/templates/${template.id}/versions/1`))).source_definition).toBeNull();

    const second = await exported(template.id, 2);
    expect(second.definition.persona.sha256).toBe(first.definition.persona.sha256);
    expect(second.definition.skills).toEqual(first.definition.skills);
    expect(second.definition.source_template).toEqual({ template_id: template.id, version: 2 });
    expect(ctx.store.audit.list({ targetId: template.id }).some(entry => entry.action === 'template.import-definition')).toBe(true);
  });

  it('creates a new template for a definition from elsewhere and lists what a template cannot hold', async () => {
    ctx = await createTestContext();
    const imported = await ctx.call('POST', '/templates/import-definition', { body: { definition: fixture.sealed } });
    expect(imported.status).toBe(201);
    const answer = await json(imported);
    expect(answer).toMatchObject({ version: 1, created: true, source_definition: { name: 'Researcher', sha256: fixture.sealed.sha256 } });
    expect(answer.template).toMatchObject({ slug: 'researcher', source: 'user', latest_version: 1 });
    expect(answer.template.latest.body).toMatchObject({
      name: 'Researcher', soul_md: '# Soul\n', identity_md: '# Identity\n', model_hint: 'research-large',
      skills: [{ kind: 'hiveskills', ref: 'web-research', version: '1.2.0', sha256: 'b'.repeat(64) }], runtime_req: { ardent: '>=3.2.0', backend: 'llamacpp' },
      integrations: ['hivemem', 'hiveskills', 'emberpath'],
    });
    expect(answer.ignored.map((item: { path: string }) => item.path)).toEqual([
      '$.extensions[0]', '$.runtime.required_capabilities', '$.config.execution.deadline_seconds', '$.requirements.secrets[0]',
    ]);
  });

  it('refuses a tampered digest, a credential and a stale base', async () => {
    ctx = await createTestContext();
    const template = await userTemplate();
    const { definition } = await exported(template.id);

    const tampered = await ctx.call('POST', '/templates/import-definition', { body: { definition: { ...definition, sha256: 'f'.repeat(64) } } });
    expect(tampered.status).toBe(422);
    expect((await json(tampered)).error.code).toBe('DEFINITION_INVALID');
    const renamed = await ctx.call('POST', '/templates/import-definition', { body: { definition: { ...definition, name: 'Someone else' } } });
    expect((await json(renamed)).error).toMatchObject({ code: 'DEFINITION_INVALID', message: expect.stringMatching(/sha256/) });

    const leakedBody = { ...definition, persona: { ...definition.persona, identity_md: `Use ${github()}` } };
    const leaked = await ctx.call('POST', '/templates/import-definition', { body: { definition: sealAgentDefinition(leakedBody) } });
    expect(leaked.status).toBe(422);
    expect((await json(leaked)).error).toMatchObject({ code: 'DEFINITION_CONTAINS_CREDENTIAL', details: { paths: ['$.definition.persona.identity_md'] } });
    expect(JSON.stringify(await json(await ctx.call('GET', `/templates/${template.id}`)))).not.toContain(github());

    expect((await ctx.call('POST', '/templates/import-definition', { body: { definition } })).status).toBe(201);
    // The same definition again: built from version 1, which is no longer the latest.
    const stale = await ctx.call('POST', '/templates/import-definition', { body: { definition } });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { latest_version: 2 } });
    expect((await ctx.call('POST', '/templates/import-definition', { body: { definition, template_id: template.id } })).status).toBe(400);
    expect((await ctx.call('POST', '/templates/import-definition', { body: { definition, template_id: template.id, base_version: 2 } })).status).toBe(201);
    expect(ctx.store.templates.summary(template.id)!.latest_version).toBe(3);
  });
});

describe('create agent from definition', () => {
  const ALL_BOUND = { hivemem: 'default', hiveskills: 'default' };

  it('checks the definition with Magnus as the acting ADMIN and answers its preflight', async () => {
    ctx = await createTestContext();
    const template = await userTemplate();
    const { definition } = await exported(template.id);
    const check = (body: Record<string, unknown>) => ctx.call('POST', `/templates/${template.id}/versions/1/deploy-check`, { body });

    const passed = await check({ node_id: 'node3', bindings: ALL_BOUND });
    expect(passed.status).toBe(200);
    expect(await json(passed)).toMatchObject({ definition: { name: 'Archivist', sha256: definition.sha256 }, preflight: { ok: true, problems: [] }, omitted: [{ name: 'summarize' }, { name: 'filing' }] });
    const sent = ctx.magnus.calls.find(call => call.path === '/api/v1/ardent/agent-definitions/validate')!;
    expect(sent.actingSubject).toBe('subject-operator');
    expect(sent.body).toEqual({ definition, nodeId: 'node3', bindings: ALL_BOUND });

    ctx.magnus.definitionProblems = [{ code: 'SKILL_VERSION_UNAVAILABLE', detail: 'web-research@1.2.0 is not in the catalog' }];
    expect((await json(await check({ node_id: 'node3' }))).preflight).toEqual({ ok: false, problems: [
      { code: 'SKILL_VERSION_UNAVAILABLE', detail: 'web-research@1.2.0 is not in the catalog' },
      { code: 'MISSING_BINDING', detail: 'Bind hivemem (hivemem)' }, { code: 'MISSING_BINDING', detail: 'Bind hiveskills (hiveskills)' },
    ] });

    ctx.magnus.unknownNodes.add('node9');
    expect((await check({ node_id: 'node9' })).status).toBe(404);
    ctx.magnus.admins.clear();
    const refused = await check({ node_id: 'node3' });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe('ACTING_ADMIN_REQUIRED');
    ctx.magnus.admins.add('subject-operator');
    for (const mode of ['missing', 'scoped'] as const) {
      ctx.magnus.definitions = mode;
      const old = await check({ node_id: 'node3' });
      expect(old.status, mode).toBe(409);
      expect((await json(old)).error).toMatchObject({ code: 'MAGNUS_UPGRADE_REQUIRED', message: expect.stringMatching(/Magnus 3\.3\.0/) });
    }
    expect((await check({ node_id: 'node3', bindings: { 'secret:not a key': 'x' } })).status).toBe(400);
  });

  it('installs through Magnus once the preflight passes and relays the definition operation', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const template = await userTemplate();
    const deploy = (body: Record<string, unknown>) => ctx.call('POST', `/templates/${template.id}/versions/1/deploy`, { body });

    const blocked = await deploy({ node_id: 'node3', profile: 'archivist', bindings: { hivemem: 'default' } });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toMatchObject({ code: 'PREFLIGHT_FAILED', details: { problems: [{ code: 'MISSING_BINDING', detail: 'Bind hiveskills (hiveskills)' }] } });
    expect(ctx.magnus.operations.size).toBe(0);

    const created = await deploy({ node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND, project_id: project.id, role_key: 'archivist' });
    expect(created.status).toBe(201);
    const operation = await json(created);
    expect(operation).toMatchObject({ agent_ref: 'node3~archivist', kind: 'definition', status: 'running', project_id: project.id });
    const sent = ctx.magnus.calls.filter(call => call.path === '/api/v1/ardent/agent-definitions/install').at(-1)!;
    expect(sent.body).toMatchObject({ nodeId: 'node3', name: 'archivist', bindings: ALL_BOUND, definition: { name: 'Archivist', source_template: { template_id: template.id, version: 1 } } });
    expect(ctx.store.agents.presentation('node3~archivist')).toMatchObject({ display_name: 'Archivist' });

    await waitFor(() => ctx.magnus.calls.some(call => call.path.endsWith(`/operations/${operation.id}/stream`)));
    ctx.magnus.updateOperation(operation.id, { status: 'succeeded', completedAt: new Date().toISOString() });
    await waitFor(() => ctx.store.agents.operation(operation.id)!.status === 'succeeded');
    expect(await json(await ctx.call('GET', `/agents/operations/${operation.id}`))).toMatchObject({ kind: 'definition', status: 'succeeded' });
    ctx.magnus.definitions = 'scoped';
    expect((await json(await deploy({ node_id: 'node3', profile: 'other', bindings: ALL_BOUND }))).error.code).toBe('MAGNUS_UPGRADE_REQUIRED');
  });
});
