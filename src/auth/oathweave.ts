// Oathweave resource-token verification for ArdentStudio, following the suite pattern
// (Magnus and HiveMem): RS256 only, exact issuer and audience, at most fifteen minutes,
// USER actor with a session, and an online session check through userinfo. Failure is closed.
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ARDENT_STUDIO_AUDIENCE, type ArdentStudioPermission } from '../shared/browser.js';
import { effectivePermissions, linkFor, type IdentityLink } from './links.js';

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience?: string;
}

export interface OathweaveIdentity {
  subject: string;
  issuer: string;
  sessionId: string;
  permissions: string[];
  displayName: string;
  issuedAt: number;
  expiresAt: number;
}

export type OathweaveVerifier = (token: string) => Promise<OathweaveIdentity>;

/** A verified, linked caller. */
export interface Principal {
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
export const SESSION_CACHE_TTL_MS = 10_000;
/** How often an open stream re-checks its token. */
export const STREAM_RECHECK_MS = 5_000;
const FAILED_CHECK_TTL_MS = 2_000;
const SESSION_CACHE_MAX = 5_000;
const REQUEST_TIMEOUT_MS = 3_000;

export function isHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function createOathweaveVerifier(
  options: OathweaveOptions,
  overrides: { keys?: JWTVerifyGetKey; fetch?: typeof fetch; now?: () => number } = {},
): OathweaveVerifier {
  for (const value of [options.issuer, options.jwksUrl, options.userinfoUrl]) {
    if (!isHttpsEndpoint(value)) throw new Error('Oathweave endpoints require verified HTTPS');
  }
  const audience = options.audience ?? ARDENT_STUDIO_AUDIENCE;
  const request: typeof fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const now = overrides.now ?? (() => Date.now());
  const keys = overrides.keys ?? createRemoteJWKSet(new URL(options.jwksUrl), {
    [customFetch]: (url, init) => request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  });
  // Holds only tokens whose signature verified, so garbage can neither fill it nor reach userinfo.
  const sessions = new Map<string, { expiresAt: number; displayName: Promise<string> }>();

  async function fetchDisplayName(token: string, subject: string): Promise<string> {
    const result = await request(options.userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!result.ok) throw new Error('Identity session is inactive');
    const user: unknown = await result.json();
    if (!user || typeof user !== 'object' || (user as { sub?: unknown }).sub !== subject) throw new Error('Identity subject mismatch');
    return 'name' in user && typeof user.name === 'string' && user.name ? user.name : subject;
  }

  function sessionCheck(token: string, subject: string): Promise<string> {
    const key = createHash('sha256').update(token).digest('hex');
    const startedAt = now();
    const current = sessions.get(key);
    if (current && startedAt < current.expiresAt) return current.displayName;
    sessions.delete(key);
    if (sessions.size >= SESSION_CACHE_MAX) {
      for (const [entryKey, entry] of sessions) if (entry.expiresAt <= startedAt) sessions.delete(entryKey);
      if (sessions.size >= SESSION_CACHE_MAX) sessions.delete(sessions.keys().next().value as string);
    }
    const check = { expiresAt: startedAt + SESSION_CACHE_TTL_MS, displayName: fetchDisplayName(token, subject) };
    check.displayName.catch(() => { check.expiresAt = Math.min(check.expiresAt, now() + FAILED_CHECK_TTL_MS); });
    sessions.set(key, check);
    return check.displayName;
  }

  return async (token: string): Promise<OathweaveIdentity> => {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: options.issuer,
      audience,
      requiredClaims: ['sub', 'iat', 'exp', 'jti'],
      maxTokenAge: '15m',
      currentDate: new Date(now()),
    });
    if (payload.aud !== audience || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.exp <= payload.iat || payload.exp - payload.iat > 900) {
      throw new Error('Invalid resource token audience or lifetime');
    }
    const claims = payload as Record<string, unknown>;
    if (claims['actorType'] !== 'USER'
      || typeof payload.sub !== 'string' || !payload.sub
      || typeof payload.jti !== 'string' || !payload.jti
      || typeof claims['sessionId'] !== 'string' || !claims['sessionId']
      || typeof claims['clientId'] !== 'string'
      || !Array.isArray(claims['permissions']) || !claims['permissions'].every(value => typeof value === 'string')) {
      throw new Error('Invalid resource identity');
    }
    const displayName = await sessionCheck(token, payload.sub);
    return {
      subject: payload.sub,
      issuer: options.issuer,
      sessionId: claims['sessionId'],
      permissions: claims['permissions'] as string[],
      displayName,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  };
}

export type Authenticator = (token: string) => Promise<Principal>;

/** Verify a bearer token and map it through its one explicit identity link. */
export function createAuthenticator(verify: OathweaveVerifier, links: readonly IdentityLink[]): Authenticator {
  return async token => {
    const identity = await verify(token);
    const link = linkFor(links, identity.issuer, identity.subject);
    if (!link) throw new AccessDenied('An explicit unique account link is required');
    return {
      userId: link.localUserId,
      subject: identity.subject,
      issuer: identity.issuer,
      displayName: link.displayName ?? identity.displayName,
      permissions: effectivePermissions(link, identity.permissions),
      expiresAt: identity.expiresAt,
    };
  };
}
