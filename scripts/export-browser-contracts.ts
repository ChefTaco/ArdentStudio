#!/usr/bin/env -S npx tsx
// Generates docs/openapi-browser.json from the zod browser contract (src/shared/browser.ts).
//
//   --write              regenerate docs/openapi-browser.json
//   --check              fail when docs/openapi-browser.json is stale (CI)
//   --output NEW_DIR     export the committed contract (browser.ts, openapi-browser.json) with
//                        per-file SHA-256 provenance, for a static console such as HiveXUI to vendor
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as contract from '../src/shared/browser.js';
import {
  ARDENT_STUDIO_API_PREFIX, ARDENT_STUDIO_AUDIENCE, ARDENT_STUDIO_PERMISSIONS, ardentStudioBrowserContractVersion, ardentStudioBrowserRoutes,
  errorResponseSchema, IDEMPOTENCY_HEADER, UPLOAD_MIME_TYPES, type ArdentStudioBrowserRoute,
} from '../src/shared/browser.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const OPENAPI_PATH = 'docs/openapi-browser.json';

type Json = Record<string, unknown>;

/** Every exported schema becomes a named component, so shared shapes appear once. */
const NAMED = (() => {
  const names = new Map<z.ZodType, string>();
  for (const [key, value] of Object.entries(contract)) {
    if (!(value instanceof z.ZodType) || !key.endsWith('Schema')) continue;
    const name = key.charAt(0).toUpperCase() + key.slice(1, -'Schema'.length);
    // An alias (projectResponseSchema = projectSchema) keeps the shorter name.
    const existing = names.get(value);
    if (!existing || name.length < existing.length) names.set(value, name);
  }
  return names;
})();

const COMPONENT_REF = '#/components/schemas/';

function openObjects<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => openObjects<unknown>(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !(key === 'additionalProperties' && item === false))
    .map(([key, item]) => [key, openObjects<unknown>(item)])) as T;
}

/** Keep only the components that operations reach. */
function reachable(document: Json, schemas: Record<string, Json>): Record<string, Json> {
  const keep = new Set<string>();
  const pending = [JSON.stringify({ ...document, components: { ...(document.components as Json), schemas: {} } })];
  while (pending.length) {
    for (const match of pending.pop()!.matchAll(/"#\/components\/schemas\/([A-Za-z0-9]+)"/g)) {
      if (keep.has(match[1]!)) continue;
      keep.add(match[1]!);
      pending.push(JSON.stringify(schemas[match[1]!] ?? {}));
    }
  }
  return Object.fromEntries(Object.entries(schemas).filter(([id]) => keep.has(id)).sort(([a], [b]) => a.localeCompare(b)));
}

/** Components for both directions. A request-side variant gets an `Input` suffix only when it differs. */
const COMPONENTS = (() => {
  const convert = (io: 'input' | 'output', suffix: string) => {
    const registry = z.registry<{ id: string }>();
    for (const [schema, id] of NAMED) registry.add(schema, { id });
    const result = z.toJSONSchema(registry, { io, unrepresentable: 'any', target: 'draft-2020-12', uri: id => `${COMPONENT_REF}${id}${suffix}` }) as { schemas: Record<string, Json> };
    return Object.fromEntries(Object.entries(result.schemas).map(([id, value]) => {
      const { $schema: _schema, $id: _id, ...rest } = value;
      // Responses may gain fields in later releases; clients strip what they do not know.
      return [id, io === 'output' ? openObjects(rest) : rest];
    }));
  };
  const output = convert('output', '');
  const input = convert('input', 'Input');
  // Collapse input variants that match their output form, then rewrite references to them.
  const same = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const id of Object.keys(input)) {
      if (same.has(id)) continue;
      const text = JSON.stringify(input[id]).replace(/"#\/components\/schemas\/([A-Za-z0-9]+)Input"/g, (match, name: string) => same.has(name) ? `"${COMPONENT_REF}${name}"` : match);
      if (text === JSON.stringify(output[id])) { same.add(id); changed = true; }
    }
  }
  const rewrite = (value: Json): Json => JSON.parse(JSON.stringify(value).replace(/"#\/components\/schemas\/([A-Za-z0-9]+)Input"/g,
    (match, name: string) => same.has(name) ? `"${COMPONENT_REF}${name}"` : match)) as Json;
  const schemas: Record<string, Json> = { ...output };
  for (const [id, value] of Object.entries(input)) if (!same.has(id)) schemas[`${id}Input`] = rewrite(value);
  return { schemas, inputName: (id: string) => same.has(id) ? id : `${id}Input` };
})();

function schema(value: z.ZodType, io: 'input' | 'output'): Json {
  const name = NAMED.get(value);
  if (name) return { $ref: `${COMPONENT_REF}${io === 'input' ? COMPONENTS.inputName(name) : name}` };
  const { $schema: _ignored, ...rest } = z.toJSONSchema(value, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as Json;
  return rest;
}

function inlineSchema(value: z.ZodType, io: 'input' | 'output'): Json {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(value, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as Json;
  return rest;
}

function operationId(route: ArdentStudioBrowserRoute): string {
  const words = route.path.split('/').filter(Boolean).map(part => part.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+(.)?/g, (_m, next: string | undefined) => (next ?? '').toUpperCase()));
  return [route.method.toLowerCase(), ...words.map(word => word.charAt(0).toUpperCase() + word.slice(1))].join('');
}

function operation(route: ArdentStudioBrowserRoute): Json {
  const parameters: Json[] = [...route.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => ({ in: 'path', name: match[1], required: true, schema: { type: 'string' } }));
  if (route.query) {
    const query = inlineSchema(route.query, 'input') as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, value] of Object.entries(query.properties ?? {})) {
      parameters.push({ in: 'query', name, required: (query.required ?? []).includes(name), schema: value });
    }
  }
  if (route.idempotent) {
    parameters.push({ in: 'header', name: IDEMPOTENCY_HEADER, required: true, description: 'Repeating a key replays the first answer; reusing it for a different request answers 409.',
      schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,128}$' } });
  }
  const success = String(route.successStatus ?? 200);
  const responses: Json = {};
  if (route.events) {
    responses[success] = {
      description: 'Server-sent events',
      content: { 'text/event-stream': { schema: { type: 'string' } } },
      'x-events': Object.fromEntries(Object.entries(route.events).map(([name, value]) => [name, schema(value, 'output')])),
    };
  } else if (route.response) {
    responses[success] = { description: 'Success', content: { 'application/json': { schema: schema(route.response, 'output') } } };
  } else {
    responses[success] = { description: 'Bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  }
  const errors = route.permissions.length ? ['400', '401', '403', '404', '409'] : ['503'];
  if (route.requestBody) errors.push('413', '415', '422');
  for (const status of errors) responses[status] = { $ref: '#/components/responses/Error' };

  const result: Json = { operationId: operationId(route), parameters, responses, 'x-permissions': [...route.permissions], 'x-idempotent': route.idempotent };
  if (route.orPermission) result['x-or-permission'] = route.orPermission;
  if (route.accept === 'any') result['x-accept'] = 'any';
  if (route.note) result.description = route.note;
  if (route.permissions.length) result.security = [{ oathweave: [] }];
  else result.security = [];
  if (route.requestBody === 'json' && route.request) {
    result.requestBody = { required: true, content: { 'application/json': { schema: schema(route.request, 'input') } } };
  } else if (route.requestBody === 'raw') {
    result.requestBody = { required: true, content: Object.fromEntries(UPLOAD_MIME_TYPES.map(type => [type, { schema: { type: 'string', format: 'binary' } }])) };
  }
  return result;
}

export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const route of ardentStudioBrowserRoutes) {
    const path = `${ARDENT_STUDIO_API_PREFIX}${route.path}`;
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(route) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ardent Project Studio browser API',
      version: String(ardentStudioBrowserContractVersion),
      description: 'Generated from src/shared/browser.ts by scripts/export-browser-contracts.ts. Do not edit by hand.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    paths,
    components: {
      securitySchemes: {
        oathweave: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: `Oathweave resource token with audience ${ARDENT_STUDIO_AUDIENCE}. Permissions: ${ARDENT_STUDIO_PERMISSIONS.join(', ')}.` },
      },
      responses: {
        Error: { description: 'Error', content: { 'application/json': { schema: schema(errorResponseSchema, 'output') } } },
      },
      schemas: {},
    },
  };
}

export function renderOpenApi(): string {
  const document = buildOpenApi();
  (document.components as Json).schemas = reachable(document, COMPONENTS.schemas);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function exportCommitted(output: string): void {
  const git = (args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root });
  const revision = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const files = [
    { path: 'browser.ts', source: 'src/shared/browser.ts' },
    { path: 'openapi-browser.json', source: OPENAPI_PATH },
  ].map(file => {
    const bytes = git(['show', `${revision}:${file.source}`]);
    if (file.path === 'browser.ts') {
      for (const match of bytes.toString('utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (match[1] !== 'zod') throw new Error(`Browser contract imports server implementation: ${match[1]}`);
      }
    }
    return { ...file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  // Refuses an existing directory or file, so an earlier export is never overwritten.
  mkdirSync(output, { mode: 0o700 });
  for (const file of files) writeFileSync(join(output, file.path), file.bytes, { flag: 'wx', mode: 0o600 });
  const manifest = {
    schema: 1, product: 'ardentstudio-browser', version: ardentStudioBrowserContractVersion,
    repository: 'https://github.com/ChefTaco/ArdentStudio', revision,
    files: files.map(({ path, source, sha256 }) => ({ path, source, sha256 })),
  };
  writeFileSync(join(output, 'provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Exported the browser contract at ${revision}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = join(root, OPENAPI_PATH);
  const mode = process.argv[2];
  if (mode === '--write') {
    writeFileSync(target, renderOpenApi());
    console.log(`Wrote ${OPENAPI_PATH}`);
  } else if (mode === '--check') {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== renderOpenApi()) {
      console.error(`${OPENAPI_PATH} is stale. Run npm run contracts:write and commit the result.`);
      process.exitCode = 1;
    } else console.log(`${OPENAPI_PATH} is up to date.`);
  } else if (mode === '--output' && process.argv[3]) {
    exportCommitted(resolve(process.argv[3]));
  } else {
    console.error('usage: export-browser-contracts.ts --write | --check | --output NEW_DIRECTORY');
    process.exitCode = 2;
  }
}
