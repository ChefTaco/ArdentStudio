// Oathweave resource-token verification for ArdentStudio, using the suite's shared verifier
// (@hivemagnus/hive-common/oathweave): RS256 only, exact issuer and audience, at most fifteen
// minutes, USER actor with a session, and an online session check through userinfo.
// Failure is closed. Studio accepts people only; service tokens are refused everywhere except on
// routes that opt in (the audit export), where a service gets only SERVICE_PERMISSIONS.
import {
  createOathweaveVerifier as createSharedVerifier,
  OATHWEAVE_SESSION_CACHE_TTL_MS,
  OATHWEAVE_STREAM_RECHECK_MS,
} from '@hivemagnus/hive-common/oathweave';
import type { JWTVerifyGetKey } from 'jose';
import { ARDENT_STUDIO_AUDIENCE, type ArdentStudioPermission } from '../shared/browser.js';
import { effectivePermissions, linkFor, type IdentityLink } from './links.js';

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience?: string;
}

export interface OathweaveIdentity {
  kind: 'user' | 'service';
  subject: string;
  issuer: string;
  sessionId: string;
  permissions: string[];
  displayName: string;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifyOptions {
  /** `any` also accepts service (client-credentials) tokens. The default is people only. */
  accept?: 'user' | 'any';
}

export type OathweaveVerifier = (token: string, options?: VerifyOptions) => Promise<OathweaveIdentity>;

/** The only permissions a service token can carry into Studio. */
export const SERVICE_PERMISSIONS: readonly ArdentStudioPermission[] = ['ardentstudio:audit:read'];

/** A verified, linked caller, or a verified service on a route that accepts services. */
export interface Principal {
  /** Absent means a person, as before services were accepted anywhere. */
  kind?: 'user' | 'service';
  /** The linked Studio user, or `service:<client id>` for a service. */
  userId: string;
  subject: string;
  issuer: string;
  displayName: string;
  permissions: ArdentStudioPermission[];
  /** Token expiry in epoch seconds. Streams close at this time. */
  expiresAt: number;
}

/** The token is valid but its subject has no explicit link, so the person has no Studio access. */
export class AccessDenied extends Error {
  override name = 'AccessDenied';
}

/** How long a userinfo answer is reused, measured from when the request started. */
export const SESSION_CACHE_TTL_MS = OATHWEAVE_SESSION_CACHE_TTL_MS;
/** How often an open stream re-checks its token. */
export const STREAM_RECHECK_MS = OATHWEAVE_STREAM_RECHECK_MS;
/**
 * Studio has always checked token times exactly; the shared verifier would allow 30 s of skew.
 * Kept at zero so this change does not widen what Studio accepts.
 */
export const CLOCK_TOLERANCE_SEC = 0;

/**
 * Build Studio's verifier on the shared one. Every refusal is an OathweaveError with a stable
 * `reason`; the router maps all of them (including an unreachable JWKS or userinfo) to 401.
 */
export function createOathweaveVerifier(
  options: OathweaveOptions,
  overrides: { keys?: JWTVerifyGetKey; fetch?: typeof fetch; now?: () => number } = {},
): OathweaveVerifier {
  const verifier = createSharedVerifier({
    issuer: options.issuer,
    audience: options.audience ?? ARDENT_STUDIO_AUDIENCE,
    jwksUrl: options.jwksUrl,
    userinfoUrl: options.userinfoUrl,
    accept: 'user',
    clockToleranceSec: CLOCK_TOLERANCE_SEC,
    ...(overrides.keys ? { keys: overrides.keys } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return async (token, verifyOptions = {}) => {
    const principal = verifyOptions.accept === 'any' ? await verifier.verify(token, { accept: 'any' }) : await verifier.verifyUser(token);
    return {
      kind: principal.kind,
      subject: principal.subject,
      issuer: principal.issuer,
      sessionId: principal.kind === 'user' ? principal.sessionId : '',
      permissions: [...principal.permissions],
      displayName: principal.kind === 'user' ? principal.displayName : principal.subject,
      issuedAt: principal.issuedAt,
      expiresAt: principal.expiresAt,
    };
  };
}

export type Authenticator = (token: string, options?: VerifyOptions) => Promise<Principal>;

/**
 * Verify a bearer token and map a person through their one explicit identity link. A service
 * (only with `accept: 'any'`) needs no link and keeps only SERVICE_PERMISSIONS.
 */
export function createAuthenticator(verify: OathweaveVerifier, links: readonly IdentityLink[]): Authenticator {
  return async (token, options = {}) => {
    const identity = await verify(token, options);
    if (identity.kind === 'service') {
      if (options.accept !== 'any') throw new Error('Service tokens are not accepted here');
      return {
        kind: 'service',
        userId: `service:${identity.subject}`,
        subject: identity.subject,
        issuer: identity.issuer,
        displayName: identity.subject,
        permissions: SERVICE_PERMISSIONS.filter(permission => identity.permissions.includes(permission)),
        expiresAt: identity.expiresAt,
      };
    }
    const link = linkFor(links, identity.issuer, identity.subject);
    if (!link) throw new AccessDenied('An explicit unique account link is required');
    return {
      kind: 'user',
      userId: link.localUserId,
      subject: identity.subject,
      issuer: identity.issuer,
      displayName: link.displayName ?? identity.displayName,
      permissions: effectivePermissions(link, identity.permissions),
      expiresAt: identity.expiresAt,
    };
  };
}
