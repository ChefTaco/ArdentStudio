import { describe, expect, it } from 'vitest';
import { effectivePermissions, linkFor, parseIdentityLinks } from '../src/auth/links.js';
import { AccessDenied, createAuthenticator, createOathweaveVerifier } from '../src/auth/oathweave.js';
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
    await expect(verify(await signToken(keys, { actorType: 'SERVICE_ACCOUNT' }))).rejects.toThrow(/identity/);
    await expect(verify(await signToken(keys, { sessionId: null }))).rejects.toThrow(/identity/);
    await expect(verify(await signToken(keys, { lifetime: 3600 }))).rejects.toThrow();
    await expect(verify(await signToken(keys, { iss: 'https://other.example.com' }))).rejects.toThrow();
  });

  it('refuses a token whose session was revoked', async () => {
    const token = await signToken(keys, { sub: 'subject-revoked' });
    revoked.add('subject-revoked');
    await expect(verify(token)).rejects.toThrow(/inactive/);
  });

  it('requires HTTPS endpoints', () => {
    expect(() => createOathweaveVerifier({ issuer: 'http://identity.example.com', jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL })).toThrow(/HTTPS/);
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
