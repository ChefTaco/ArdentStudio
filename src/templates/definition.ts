// Portable agent definitions (hive-agent-definition/1) built from and imported into agent templates.
//
// The canonical JSON, digests, seal and verification are a port of @hivemagnus/magnus-contracts
// `agent-definition` (Magnus 3.3.0, not yet published when this was written); test/definition.test.ts
// checks them against fixtures that release's implementation produced. Once Studio depends on a
// magnus-contracts release that exports them, this module can use those instead.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { AgentTemplateBody } from '../db/repos/templates.js';
import {
  AGENT_DEFINITION_EXCLUDES, AGENT_DEFINITION_SCHEMA, agentDefinitionSchema, agentTemplateBodySchema, emberpathAliasSchema,
  type agentDefinitionBodySchema, type definitionOmissionSchema, type integrationSchema,
} from '../shared/browser.js';
import { credentialLikePaths } from './secrets.js';

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDefinitionBody = z.infer<typeof agentDefinitionBodySchema>;
export type DefinitionOmission = z.infer<typeof definitionOmissionSchema>;
export interface DefinitionIgnored { path: string; reason: string }

/** The runtime package a definition built from a template names. */
export const ARDENT_RUNTIME_PACKAGE = '@hivemagnus/ardent';
/**
 * The lowest Ardent a definition built from a template names. Studio's own features need Ardent 2.2.0
 * (missions and previews) and fall back when later capabilities (recovery, lineage, artifact transfer v2)
 * are missing, so a template requires no runtime capability. Magnus's preflight accepts only the same
 * major version at or above the defined one, so the floor is the first release of the current major line.
 * A template whose `runtime_req.ardent` names a later version keeps it.
 */
export const DEFINITION_MIN_ARDENT = '3.0.0';

const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const TEMPLATE_TEXT_MAX = 65_536;
const TEMPLATE_SKILLS_MAX = 50;
const DEFAULT_AVATAR: AgentTemplateBody['avatar_preset'] = { preset: 'silhouette-a', accent: 'blue', emblem: 'compass' };

export class DefinitionError extends Error {
  override name = 'DefinitionError';
  constructor(readonly code: 'DEFINITION_INVALID' | 'DEFINITION_CONTAINS_CREDENTIAL' | 'DEFINITION_INCOMPLETE' | 'DEFINITION_UNREPRESENTABLE',
    message: string, readonly paths?: string[]) {
    super(message);
  }
}

/** Canonical JSON: object keys sorted by code unit, no whitespace, undefined members dropped. Rejects non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON has no non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON cannot hold a ${typeof value}`);
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function agentPersonaSha256(persona: { soul_md: string; identity_md: string }): string {
  return sha256Hex(canonicalJson({ soul_md: persona.soul_md, identity_md: persona.identity_md }));
}

/** The digest of a definition, computed without its `sha256` member (which may be absent). */
export function agentDefinitionSha256(definition: AgentDefinitionBody | AgentDefinition): string {
  const { sha256: _ignored, ...body } = definition as AgentDefinition;
  return sha256Hex(canonicalJson(body));
}

/** Fill in both digests of a definition body. */
export function sealAgentDefinition(body: AgentDefinitionBody): AgentDefinition {
  const sealed = { ...body, persona: { ...body.persona, sha256: agentPersonaSha256(body.persona) } };
  return { ...sealed, sha256: agentDefinitionSha256(sealed) };
}

export type AgentDefinitionCheck =
  | { ok: true; definition: AgentDefinition }
  | { ok: false; code: 'DEFINITION_INVALID' | 'DEFINITION_CONTAINS_CREDENTIAL'; detail: string; paths?: string[] };

/** No credential-like string anywhere (even in a malformed definition), the shape, then both digests. */
export function verifyAgentDefinition(raw: unknown): AgentDefinitionCheck {
  const paths = credentialLikePaths(raw);
  if (paths.length) return { ok: false, code: 'DEFINITION_CONTAINS_CREDENTIAL', detail: `Credential-like values at ${paths.slice(0, 10).join(', ')}`, paths };
  const parsed = agentDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'DEFINITION_INVALID', detail: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500) };
  }
  if (agentPersonaSha256(parsed.data.persona) !== parsed.data.persona.sha256) return { ok: false, code: 'DEFINITION_INVALID', detail: 'persona.sha256 does not match the persona texts' };
  if (agentDefinitionSha256(parsed.data) !== parsed.data.sha256) return { ok: false, code: 'DEFINITION_INVALID', detail: 'sha256 does not match the canonical definition' };
  return { ok: true, definition: parsed.data };
}

const semver = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)?.slice(1).map(Number) as [number, number, number] | undefined;
const newer = (left: [number, number, number], right: [number, number, number]) =>
  left[0] !== right[0] ? left[0] > right[0] : left[1] !== right[1] ? left[1] > right[1] : left[2] > right[2];

/** The runtime version for a template's `runtime_req.ardent` (`3.2.0`, `>=3.2.0`, `^3.2.0`, …): never below DEFINITION_MIN_ARDENT. */
export function definitionRuntimeVersion(requirement: string | null): string {
  const match = /^\s*(?:>=|\^|~|=)?\s*v?(\d+\.\d+\.\d+)\s*$/u.exec(requirement ?? '');
  const wanted = match ? semver(match[1]!) : undefined;
  return wanted && newer(wanted, semver(DEFINITION_MIN_ARDENT)!) ? wanted.join('.') : DEFINITION_MIN_ARDENT;
}

export interface TemplateVersionInput { template_id: string; version: number; created_at: string; body: AgentTemplateBody }

/**
 * The definition of an agent template version. Deterministic: created_at is the version's, so one version
 * always has one digest. Throws DefinitionError for a version that cannot be a definition or would carry a
 * credential (checked over the whole answer, which is what gets shared).
 */
export function buildTemplateDefinition(version: TemplateVersionInput): { definition: AgentDefinition; omitted: DefinitionOmission[] } {
  const { body } = version;
  if (!body.soul_md.trim() || !body.identity_md.trim()) throw new DefinitionError('DEFINITION_INCOMPLETE', 'A definition needs the template\'s soul and identity text; this version has an empty one');
  const omitted: DefinitionOmission[] = [];

  const skills: AgentDefinitionBody['skills'] = [];
  for (const skill of body.skills) {
    const pinned = skill.kind === 'hiveskills' && skill.version !== undefined && skill.sha256 !== undefined;
    if (pinned && SKILL_SLUG.test(skill.ref) && !skills.some(item => item.slug === skill.ref)) {
      skills.push({ slug: skill.ref, version: skill.version!, sha256: skill.sha256! });
      continue;
    }
    omitted.push({ kind: 'skill', name: skill.ref, reason: skill.kind === 'local'
      ? 'A local skill has no portable source; a definition carries only pinned HiveSkills releases'
      : !pinned ? 'Not pinned: the template names no HiveSkills release version and sha256 for it'
        : !SKILL_SLUG.test(skill.ref) ? 'Not a HiveSkills catalog slug' : 'Listed more than once' });
  }

  let alias: string | undefined;
  if (body.model_hint !== null && body.model_hint.trim()) {
    if (emberpathAliasSchema.safeParse(body.model_hint).success) alias = body.model_hint;
    else omitted.push({ kind: 'model', name: 'model_hint', reason: 'Not an Emberpath alias; the target binds model to an alias' });
  }

  const description = body.purpose.trim() ? body.purpose : undefined;
  const definitionBody: AgentDefinitionBody = {
    schema: AGENT_DEFINITION_SCHEMA,
    name: body.name.trim().slice(0, 128),
    ...(description !== undefined ? { description } : {}),
    created_at: version.created_at,
    source_template: { template_id: version.template_id, version: version.version },
    persona: { soul_md: body.soul_md, identity_md: body.identity_md, sha256: '' },
    runtime: { package: ARDENT_RUNTIME_PACKAGE, version: definitionRuntimeVersion(body.runtime_req.ardent), required_capabilities: [] },
    extensions: [],
    skills,
    // New Agent provisions llamacpp-backend agents; a template that allows any backend gets that one.
    config: { execution: { backend: body.runtime_req.backend === 'codex' ? 'codex' : 'llamacpp' }, model: alias ? { emberpath_alias: alias } : {}, artifacts: {}, channels: 'excluded' },
    requirements: {
      bindings: [
        { key: 'hivemem', kind: 'hivemem', required: true },
        { key: 'model', kind: 'emberpath_alias', required: alias === undefined },
        ...(skills.length ? [{ key: 'hiveskills', kind: 'hiveskills' as const, required: true }] : []),
      ],
      secrets: [],
    },
    excludes: [...AGENT_DEFINITION_EXCLUDES],
  };
  const definition = sealAgentDefinition(definitionBody);
  const leaked = credentialLikePaths({ definition, omitted });
  if (leaked.length) throw new DefinitionError('DEFINITION_CONTAINS_CREDENTIAL', `The definition would carry credential-like text at ${leaked.slice(0, 10).join(', ')}`, leaked.slice(0, 50));
  const checked = verifyAgentDefinition(definition);
  if (!checked.ok) throw new DefinitionError('DEFINITION_INCOMPLETE', `This version cannot be a definition: ${checked.detail}`.slice(0, 500));
  return { definition: checked.definition, omitted };
}

/**
 * An agent template body from a verified definition. `base` (the template's latest version, when the
 * definition is added to an existing template) supplies what a definition does not carry: category,
 * examples, expected outputs, portrait and local skills. Everything of the definition a template cannot
 * hold is listed in `ignored`.
 */
export function templateBodyFromDefinition(definition: AgentDefinition, base?: AgentTemplateBody): { body: AgentTemplateBody; ignored: DefinitionIgnored[] } {
  const ignored: DefinitionIgnored[] = [];
  const ignore = (path: string, reason: string) => ignored.push({ path, reason });
  for (const kind of ['soul_md', 'identity_md'] as const) {
    if (definition.persona[kind].length > TEMPLATE_TEXT_MAX) throw new DefinitionError('DEFINITION_UNREPRESENTABLE', `persona.${kind} is longer than a template holds (${TEMPLATE_TEXT_MAX} characters)`);
  }

  const skills: AgentTemplateBody['skills'] = [];
  definition.skills.forEach((skill, index) => {
    if (skills.length < TEMPLATE_SKILLS_MAX) skills.push({ kind: 'hiveskills', ref: skill.slug, version: skill.version, sha256: skill.sha256 });
    else ignore(`$.skills[${index}]`, `A template holds at most ${TEMPLATE_SKILLS_MAX} skills`);
  });
  // A definition never carries local skills, so the base version's stay.
  for (const skill of base?.skills ?? []) {
    if (skill.kind !== 'local' || skills.some(item => item.kind === 'local' && item.ref === skill.ref)) continue;
    if (skills.length < TEMPLATE_SKILLS_MAX) skills.push(skill);
  }

  definition.extensions.forEach((extension, index) =>
    ignore(`$.extensions[${index}]`, `${extension.name}@${extension.version}: templates do not carry extensions; install the definition through Magnus to keep them`));
  if (definition.runtime.package !== ARDENT_RUNTIME_PACKAGE) ignore('$.runtime.package', `Templates are for ${ARDENT_RUNTIME_PACKAGE}`);
  if (definition.runtime.required_capabilities.length) ignore('$.runtime.required_capabilities', 'Templates do not record runtime capabilities');
  for (const key of ['deadline_seconds', 'max_parallel_tasks', 'max_parallel_tool_calls'] as const) {
    if (definition.config.execution[key] !== undefined) ignore(`$.config.execution.${key}`, 'Templates do not hold execution limits');
  }
  if (definition.config.artifacts.max_bytes !== undefined) ignore('$.config.artifacts.max_bytes', 'Templates do not hold an artifact size limit');
  definition.requirements.secrets.forEach((secret, index) => ignore(`$.requirements.secrets[${index}]`, `${secret.env_name}: templates never name secrets; bind it when installing`));
  definition.requirements.bindings.forEach((binding, index) => {
    if (binding.kind === 'channel' || binding.kind === 'peer') ignore(`$.requirements.bindings[${index}]`, `${binding.key}: channels and peers are installation-specific`);
  });

  // The template's own runtime requirement stays when the definition was built from it.
  const ardent = base?.runtime_req.ardent && definitionRuntimeVersion(base.runtime_req.ardent) === definition.runtime.version
    ? base.runtime_req.ardent : `>=${definition.runtime.version}`;
  const backend = base?.runtime_req.backend === 'any' && definition.config.execution.backend === 'llamacpp' ? 'any' : definition.config.execution.backend;
  // A new template's integrations follow the definition; an existing one keeps its own, plus HiveSkills for its skills.
  const integrations = new Set<z.infer<typeof integrationSchema>>(base?.integrations ?? []);
  if (!base && definition.requirements.bindings.some(binding => binding.kind === 'hivemem')) integrations.add('hivemem');
  if (!base && definition.config.model.emberpath_alias !== undefined) integrations.add('emberpath');
  if (definition.skills.length) integrations.add('hiveskills');

  const body: AgentTemplateBody = {
    name: definition.name,
    category: base?.category ?? 'imported',
    purpose: definition.description?.trim() ? definition.description : base?.purpose ?? `Imported from the agent definition ${definition.name}.`,
    example_uses: base?.example_uses ?? [],
    soul_md: definition.persona.soul_md,
    identity_md: definition.persona.identity_md,
    skills,
    model_hint: definition.config.model.emberpath_alias ?? base?.model_hint ?? null,
    runtime_req: { ardent, backend },
    integrations: (['hivemem', 'hiveskills', 'emberpath'] as const).filter(item => integrations.has(item)),
    expected_outputs: base?.expected_outputs ?? [],
    avatar_preset: base?.avatar_preset ?? DEFAULT_AVATAR,
  };
  const parsed = agentTemplateBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new DefinitionError('DEFINITION_UNREPRESENTABLE', `The definition does not fit a template: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`.slice(0, 500));
  }
  return { body: parsed.data, ignored };
}
