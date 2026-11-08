// Edits to an agent's config.yaml that Studio may send through Magnus config-save. The document is
// edited in place with the yaml library, so comments, order, formatting and every other value stay
// exactly as they were; only ARDENT_SERVICE_CONFIG_PATHS may change, and that is checked before
// anything is sent.
import { isMap, parse, parseDocument } from 'yaml';
import { ARDENT_SERVICE_CONFIG_PATHS, type ArdentServiceConfigPath } from '../clients/magnus.js';

export class ConfigEditError extends Error {
  override name = 'ConfigEditError';
  constructor(message: string, readonly code: 'CONFIG_UNREADABLE' | 'CONFIG_PATH_FORBIDDEN') { super(message); }
}

const ALLOWED: ReadonlySet<string> = new Set(ARDENT_SERVICE_CONFIG_PATHS);

/** The value at a dotted path of the configuration, or undefined. */
export function configValue(text: string, path: ArdentServiceConfigPath): unknown {
  const document = parseDocument(text);
  if (document.errors.length) throw new ConfigEditError(`The agent's configuration is not valid YAML: ${document.errors[0]!.message}`, 'CONFIG_UNREADABLE');
  return document.getIn(path.split('.'));
}

/** Set allowlisted values, keeping the rest of the document byte for byte where YAML allows. */
export function editConfig(text: string, changes: Partial<Record<ArdentServiceConfigPath, unknown>>): string {
  const document = parseDocument(text);
  if (document.errors.length) throw new ConfigEditError(`The agent's configuration is not valid YAML: ${document.errors[0]!.message}`, 'CONFIG_UNREADABLE');
  if (!isMap(document.contents)) throw new ConfigEditError('The agent\'s configuration is not a YAML mapping', 'CONFIG_UNREADABLE');
  for (const [path, value] of Object.entries(changes)) {
    if (!ALLOWED.has(path)) throw new ConfigEditError(`Studio may not change ${path}`, 'CONFIG_PATH_FORBIDDEN');
    document.setIn(path.split('.'), value);
  }
  const next = document.toString({ flowCollectionPadding: false });
  const outside = changedConfigPaths(text, next).filter(path => !ALLOWED.has(path));
  if (outside.length) throw new ConfigEditError(`The edit would change ${outside.join(', ')}`, 'CONFIG_PATH_FORBIDDEN');
  return next;
}

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Leaf paths whose values differ between two configurations. An array is one value. */
export function changedConfigPaths(before: string, after: string): string[] {
  const changed: string[] = [];
  const walk = (left: unknown, right: unknown, path: string[]) => {
    if ((plainObject(left) || left === undefined) && (plainObject(right) || right === undefined) && (plainObject(left) || plainObject(right))) {
      const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
      for (const key of keys) walk((left as Record<string, unknown> | undefined)?.[key], (right as Record<string, unknown> | undefined)?.[key], [...path, key]);
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(path.join('.'));
  };
  walk(parse(before) as unknown, parse(after) as unknown, []);
  return changed;
}

/** The model setting for the configured backend: providers.codex.model on codex, else providers.llamacpp.model. */
export function modelPath(text: string): ArdentServiceConfigPath {
  return configValue(text, 'execution.backend') === 'codex' ? 'providers.codex.model' : 'providers.llamacpp.model';
}
