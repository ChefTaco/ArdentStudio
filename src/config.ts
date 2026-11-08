import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { parseIdentityLinks, type IdentityLink } from './auth/links.js';
import { trimTrailingSlashes } from './url.js';

export const DEFAULT_PORT = 8097;
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EVENT_RETENTION_DAYS = 30;

export interface ServiceClientConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  /** OAuth scope for the client_credentials request. Oathweave grants nothing without one. */
  scope: string;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  maxBlobBytes: number;
  eventRetentionDays: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  oathweave: {
    issuer: string;
    jwksUrl: string;
    userinfoUrl: string;
    tokenUrl: string;
    identities: IdentityLink[];
  };
  magnus: ServiceClientConfig;
  hivemem: ServiceClientConfig;
  chattermost: { webhookUrl: string } | undefined;
}

export class ConfigError extends Error {
  constructor(readonly issues: ReadonlyArray<{ name: string; message: string }>) {
    super(`Invalid ArdentStudio configuration:\n${issues.map(issue => `  ${issue.name}: ${issue.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Every variable the service reads. Secrets are marked so tooling never prints their values. */
export const ENV_CATALOG: ReadonlyArray<{ name: string; required: boolean; secret: boolean; description: string }> = [
  { name: 'ARDENT_STUDIO_DATA', required: true, secret: false, description: 'Data directory holding studio.sqlite and blobs/. The container uses /data.' },
  { name: 'ARDENT_STUDIO_HOST', required: false, secret: false, description: 'Listen address. Default 127.0.0.1; the container uses 0.0.0.0.' },
  { name: 'ARDENT_STUDIO_PORT', required: false, secret: false, description: `Listen port. Default ${DEFAULT_PORT}.` },
  { name: 'ARDENT_STUDIO_MAX_BLOB_BYTES', required: false, secret: false, description: 'Largest stored file in bytes. Default 67108864 (64 MiB).' },
  { name: 'ARDENT_STUDIO_EVENT_RETENTION_DAYS', required: false, secret: false, description: 'Days of project events kept for stream replay. Default 30.' },
  { name: 'ARDENT_STUDIO_LOG_LEVEL', required: false, secret: false, description: 'debug, info, warn or error. Default info.' },
  { name: 'OATHWEAVE_ISSUER', required: true, secret: false, description: 'Oathweave browser issuer (HTTPS).' },
  { name: 'OATHWEAVE_JWKS_URL', required: true, secret: false, description: 'Oathweave JWKS URL (HTTPS).' },
  { name: 'OATHWEAVE_USERINFO_URL', required: true, secret: false, description: 'Oathweave userinfo URL (HTTPS), used for online session revocation.' },
  { name: 'ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON', required: true, secret: false, description: 'JSON array of explicit account links: [{issuer, subject, localUserId, displayName?, permissions?}].' },
  { name: 'ARDENT_STUDIO_OATHWEAVE_TOKEN_URL', required: true, secret: false, description: 'Oathweave OAuth token endpoint for the client_credentials grant.' },
  { name: 'ARDENT_STUDIO_MAGNUS_URL', required: true, secret: false, description: 'Magnus control API base URL (the origin that serves /api/v1).' },
  { name: 'ARDENT_STUDIO_MAGNUS_CLIENT_ID', required: true, secret: false, description: 'Oathweave machine client whose tokens carry the audience magnus.' },
  { name: 'ARDENT_STUDIO_MAGNUS_CLIENT_SECRET', required: true, secret: true, description: 'Secret of the Magnus machine client.' },
  { name: 'ARDENT_STUDIO_MAGNUS_SCOPE', required: false, secret: false, description: 'Scope for Magnus service tokens. Default magnus:ardent.' },
  { name: 'ARDENT_STUDIO_HIVEMEM_URL', required: true, secret: false, description: 'HiveMem base URL (the origin that serves /v1).' },
  { name: 'ARDENT_STUDIO_HIVEMEM_CLIENT_ID', required: true, secret: false, description: 'Oathweave machine client whose tokens carry the audience hivemem.' },
  { name: 'ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET', required: true, secret: true, description: 'Secret of the HiveMem machine client.' },
  { name: 'ARDENT_STUDIO_HIVEMEM_SCOPE', required: false, secret: false, description: 'Scope for HiveMem service tokens. Default "hivemem:workspaces:write hivemem:memories:write".' },
  { name: 'ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL', required: false, secret: true, description: 'Optional ChatterMost incoming-webhook URL for one-way announcements. The URL contains its secret.' },
  { name: 'ARDENT_STUDIO_ALLOW_PLAINTEXT_SERVICES', required: false, secret: false, description: 'true allows http:// service URLs on non-loopback hosts (isolated container networks only). Default false.' },
];

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function urlIssue(value: string, options: { httpsOnly: boolean; allowPlaintext: boolean }): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return 'must be an absolute URL'; }
  if (url.username || url.password) return 'must not contain credentials';
  if (url.hash) return 'must not contain a fragment';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol !== 'http:') return 'must use https';
  if (options.httpsOnly) return 'must use https';
  if (LOOPBACK.has(url.hostname) || options.allowPlaintext) return undefined;
  return 'must use https (http is accepted only for loopback hosts or with ARDENT_STUDIO_ALLOW_PLAINTEXT_SERVICES=true)';
}

const integer = (min: number, max: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

/** Read and validate the environment. Throws ConfigError naming every problem; values are never echoed. */
export function loadConfig(env: Env = process.env): Config {
  const issues: Array<{ name: string; message: string }> = [];
  const value = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
  };
  const required = (name: string): string => {
    const raw = value(name);
    if (raw === undefined) issues.push({ name, message: 'is required' });
    return raw ?? '';
  };
  const numeric = (name: string, fallback: number, min: number, max: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = integer(min, max).safeParse(raw);
    if (!parsed.success) { issues.push({ name, message: `must be an integer from ${min} to ${max}` }); return fallback; }
    return parsed.data;
  };
  const allowPlaintext = value('ARDENT_STUDIO_ALLOW_PLAINTEXT_SERVICES') === 'true';
  const url = (name: string, httpsOnly: boolean, exact = false): string => {
    const raw = required(name);
    if (!raw) return raw;
    const problem = urlIssue(raw, { httpsOnly, allowPlaintext });
    if (problem) issues.push({ name, message: problem });
    return exact ? raw : trimTrailingSlashes(raw);
  };

  const dataRaw = required('ARDENT_STUDIO_DATA');
  if (dataRaw && !isAbsolute(dataRaw)) issues.push({ name: 'ARDENT_STUDIO_DATA', message: 'must be an absolute path' });
  const logLevel = value('ARDENT_STUDIO_LOG_LEVEL') ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) issues.push({ name: 'ARDENT_STUDIO_LOG_LEVEL', message: 'must be debug, info, warn or error' });

  const issuer = url('OATHWEAVE_ISSUER', true, true);
  const jwksUrl = url('OATHWEAVE_JWKS_URL', true);
  const userinfoUrl = url('OATHWEAVE_USERINFO_URL', true);
  const tokenUrl = url('ARDENT_STUDIO_OATHWEAVE_TOKEN_URL', false);
  let identities: IdentityLink[] = [];
  const identitiesRaw = required('ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON');
  if (identitiesRaw) {
    try {
      identities = parseIdentityLinks(identitiesRaw);
      // Compared exactly, as tokens carry it.
      if (issuer && identities.some(link => link.issuer !== issuer)) {
        issues.push({ name: 'ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON', message: 'every link issuer must exactly equal OATHWEAVE_ISSUER' });
      }
    } catch (error) {
      issues.push({ name: 'ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON', message: error instanceof Error && error.name === 'IdentityLinkError'
        ? error.message : 'must be a JSON array of {issuer, subject, localUserId, displayName?, permissions?}' });
    }
  }

  const defaultScopes = { MAGNUS: 'magnus:ardent', HIVEMEM: 'hivemem:workspaces:write hivemem:memories:write' } as const;
  const service = (prefix: 'MAGNUS' | 'HIVEMEM'): ServiceClientConfig => ({
    url: url(`ARDENT_STUDIO_${prefix}_URL`, false),
    clientId: required(`ARDENT_STUDIO_${prefix}_CLIENT_ID`),
    clientSecret: required(`ARDENT_STUDIO_${prefix}_CLIENT_SECRET`),
    scope: value(`ARDENT_STUDIO_${prefix}_SCOPE`) ?? defaultScopes[prefix],
  });
  const magnus = service('MAGNUS');
  const hivemem = service('HIVEMEM');
  for (const [name, id] of [['ARDENT_STUDIO_MAGNUS_CLIENT_ID', magnus.clientId], ['ARDENT_STUDIO_HIVEMEM_CLIENT_ID', hivemem.clientId]] as const) {
    if (id && !/^[A-Za-z0-9_-]{1,100}$/.test(id)) issues.push({ name, message: 'must be an Oathweave client ID ([A-Za-z0-9_-], at most 100)' });
  }

  let chattermost: Config['chattermost'];
  const webhook = value('ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL');
  if (webhook) {
    const problem = urlIssue(webhook, { httpsOnly: false, allowPlaintext });
    if (problem) issues.push({ name: 'ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL', message: problem });
    else if (!/\/hooks\/|\/webhooks\/incoming\//.test(new URL(webhook).pathname)) {
      issues.push({ name: 'ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL', message: 'must be an incoming-webhook URL' });
    } else chattermost = { webhookUrl: webhook };
  }

  const config: Config = {
    host: value('ARDENT_STUDIO_HOST') ?? '127.0.0.1',
    port: numeric('ARDENT_STUDIO_PORT', DEFAULT_PORT, 1, 65535),
    dataDir: dataRaw ? resolve(dataRaw) : '',
    maxBlobBytes: numeric('ARDENT_STUDIO_MAX_BLOB_BYTES', DEFAULT_MAX_BLOB_BYTES, 1024, 1024 * 1024 * 1024),
    eventRetentionDays: numeric('ARDENT_STUDIO_EVENT_RETENTION_DAYS', DEFAULT_EVENT_RETENTION_DAYS, 1, 3650),
    logLevel: logLevel as Config['logLevel'],
    oathweave: { issuer, jwksUrl, userinfoUrl, tokenUrl, identities },
    magnus,
    hivemem,
    chattermost,
  };
  if (issues.length) throw new ConfigError(issues);
  return config;
}
