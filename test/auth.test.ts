import { createRequestContext, runWithRequestContext } from '@hivemagnus/hive-common/context';
import { runOathweaveConformance } from '@hivemagnus/hive-common/oathweave/conformance';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { effectivePermissions, linkFor, parseIdentityLinks } from '../src/auth/links.js';
import { AccessDenied, createAuthenticator, createOathweaveVerifier } from '../src/auth/authenticator.js';
import { createLogger } from '../src/logger.js';
import { authenticateRequest } from '../src/server/routing.js';
import { ISSUER, JWKS_URL, LINKS, makeKeys, signToken, USERINFO_URL, userinfoFetch } from './helpers.js';

describe('Oathweave verification', async () => {
  const keys = await makeKeys();
  const revoked = new Set<string>();
  const verify = createOathweaveVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL }, { keys: keys.jwks, fetch: userinfoFetch(revoked) });
  const authenticate = createAuthenticator(verify, LINKS);

  it('accepts a valid user token for the ardentstudio audience', async () => {
    const identity = await verify(await signToken(keys));
    expect(identity.subject).toBe('subject-operator');
    expect(identity.displayName).toBe('Name of subject-operator');
  });

  it('refuses other audiences, service actors, missing sessions and long lifetimes', async () => {
    await expect(verify(await signToken(keys, { aud: 'magnus' }))).rejects.toThrow();
    await expect(verify(await signToken(keys, { actorType: 'SERVICE_ACCOUNT' }))).rejects.toMatchObject({ reason: 'invalid_claims' });
    await expect(verify(await signToken(keys, { sessionId: null }))).rejects.toMatchObject({ reason: 'invalid_claims' });
    await expect(verify(await signToken(keys, { lifetime: 3600 }))).rejects.toThrow();
    await expect(verify(await signToken(keys, { iss: 'https://other.example.com' }))).rejects.toThrow();
  });

  it('refuses a token whose session was revoked', async () => {
    const token = await signToken(keys, { sub: 'subject-revoked' });
    revoked.add('subject-revoked');
    await expect(verify(token)).rejects.toMatchObject({ reason: 'session_inactive' });
  });

  it('requires HTTPS endpoints', () => {
    expect(() => createOathweaveVerifier({ issuer: 'http://identity.example.com', jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL })).toThrow(/https/);
  });

  it('maps a person through exactly one link and narrows permissions to its ceiling', async () => {
    const operator = await authenticate(await signToken(keys));
    expect(operator.userId).toBe('operator');
    expect(operator.permissions).toContain('ardentstudio:agents:admin');
    const viewer = await authenticate(await signToken(keys, { sub: 'subject-viewer' }));
    expect(viewer.permissions).toEqual(['ardentstudio:projects:read', 'ardentstudio:templates:read']);
    await expect(authenticate(await signToken(keys, { sub: 'subject-unlinked' }))).rejects.toBeInstanceOf(AccessDenied);
  });

  it('drops permissions a token does not carry, and unknown permission strings', async () => {
    const principal = await authenticate(await signToken(keys, { permissions: ['ardentstudio:projects:read', 'magnus:admin'] }));
    expect(principal.permissions).toEqual(['ardentstudio:projects:read']);
  });
});

describe('Oathweave conformance', () => {
  it('meets the shared Oathweave conformance vectors', async () => {
    const report = await runOathweaveConformance((token, ctx) => {
      const verify = createOathweaveVerifier(
        { issuer: ctx.issuer, audience: ctx.audience, jwksUrl: ctx.jwksUrl, userinfoUrl: ctx.userinfoUrl, nativeIssuers: ctx.nativeIssuers },
        { fetch: ctx.fetch, now: () => ctx.nowMs },
      );
      // Service tokens are verified the way the audit export does (accept 'any'); every other
      // route verifies people only and refuses them (see 'refuses a service token').
      return ctx.principal === 'service' ? verify(token, { accept: 'any' }) : verify(token);
    }, { strictReasons: true });
    expect(report.failed).toBe(0);
  });
});

describe('verifier rules kept from the Studio verifier', async () => {
  const keys = await makeKeys();
  const verify = createOathweaveVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL }, { keys: keys.jwks, fetch: userinfoFetch() });

  async function sign(claims: Record<string, unknown>, times: { iat: number; exp: number }): Promise<string> {
    return new SignJWT({ actorType: 'USER', clientId: 'hivexui-ardentstudio', sessionId: 'fixture-session', permissions: [], ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(ISSUER).setAudience('ardentstudio').setSubject('subject-operator').setJti(crypto.randomUUID())
      .setIssuedAt(times.iat).setExpirationTime(times.exp)
      .sign(keys.privateKey);
  }

  it('allows no clock skew', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(await sign({}, { iat: now - 600, exp: now - 5 }))).rejects.toMatchObject({ reason: 'expired' });
    await expect(verify(await sign({}, { iat: now + 10, exp: now + 600 }))).rejects.toMatchObject({ reason: 'not_yet_valid' });
  });

  it('accepts a token without a roles claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(await sign({}, { iat: now, exp: now + 600 }))).resolves.toMatchObject({ subject: 'subject-operator' });
  });

  it('refuses a service token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ actorType: 'SERVICE_ACCOUNT', clientId: 'subject-operator', sessionId: undefined, token_type: 'access' }, { iat: now, exp: now + 600 });
    await expect(verify(token)).rejects.toMatchObject({ reason: 'wrong_principal_kind' });
  });

  it('accepts native-issuer service tokens only where services are accepted, and never native-issuer people', async () => {
    const native = createOathweaveVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL, nativeIssuers: ['hive-iam'] },
      { keys: keys.jwks, fetch: userinfoFetch() });
    const now = Math.floor(Date.now() / 1000);
    const signAs = (iss: string, claims: Record<string, unknown>, sub: string) => new SignJWT({ permissions: ['ardentstudio:audit:read'], roles: [], ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuer(iss).setAudience('ardentstudio').setSubject(sub).setJti(crypto.randomUUID())
      .setIssuedAt(now).setExpirationTime(now + 600)
      .sign(keys.privateKey);
    const service = await signAs('hive-iam', { actorType: 'SERVICE_ACCOUNT', clientId: 'collector', token_type: 'access' }, 'collector');
    await expect(native(service, { accept: 'any' })).resolves.toMatchObject({ kind: 'service', subject: 'collector', issuer: 'hive-iam' });
    await expect(native(service)).rejects.toBeDefined();
    const person = await signAs('hive-iam', { actorType: 'USER', clientId: 'hivexui-ardentstudio', sessionId: 'fixture-session' }, 'subject-operator');
    await expect(native(person, { accept: 'any' })).rejects.toMatchObject({ reason: 'invalid_issuer' });
    // Without the setting a native issuer is never accepted.
    await expect(verify(service, { accept: 'any' })).rejects.toMatchObject({ reason: 'invalid_issuer' });
    const principal = await createAuthenticator(native, LINKS)(service, { accept: 'any' });
    expect(principal).toMatchObject({ kind: 'service', userId: 'service:collector', permissions: ['ardentstudio:audit:read'] });
  });

  it('fails closed when the identity provider is unreachable', async () => {
    const offline = createOathweaveVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL },
      { keys: keys.jwks, fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch });
    await expect(offline(await signToken(keys))).rejects.toMatchObject({ reason: 'identity_unavailable' });
    // The router keeps answering 401 UNAUTHENTICATED, as before the shared verifier.
    const token = await signToken(keys);
    const c = { req: { header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined) } } as unknown as Parameters<typeof authenticateRequest>[0];
    await expect(authenticateRequest(c, createAuthenticator(offline, LINKS), [])).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});

describe('identity links', () => {
  it('treats ambiguous links as no link', () => {
    const links = [{ issuer: ISSUER, subject: 's', localUserId: 'a' }, { issuer: ISSUER, subject: 's', localUserId: 'b' }];
    expect(linkFor(links, ISSUER, 's')).toBeUndefined();
    expect(() => parseIdentityLinks(JSON.stringify(links))).toThrow(/unique/);
  });

  it('applies the link ceiling', () => {
    expect(effectivePermissions({ issuer: ISSUER, subject: 's', localUserId: 'a', permissions: ['ardentstudio:projects:read'] },
      ['ardentstudio:projects:read', 'ardentstudio:projects:write'])).toEqual(['ardentstudio:projects:read']);
  });
});

describe('logging', () => {
  it('adds the request ID to log lines written inside a request', () => {
    const lines: string[] = [];
    const log = createLogger('info', line => lines.push(line));
    runWithRequestContext(createRequestContext({ 'x-request-id': 'req-log-1' }), () => log.info('inside'));
    log.info('outside');
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: 'inside', requestId: 'req-log-1' });
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('requestId');
  });
});
