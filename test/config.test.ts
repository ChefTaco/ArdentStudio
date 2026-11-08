import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_MAX_BLOB_BYTES, ENV_CATALOG, loadConfig } from '../src/config.js';

const base = {
  ARDENT_STUDIO_DATA: '/var/lib/ardent-studio',
  OATHWEAVE_ISSUER: 'https://identity.example.com',
  OATHWEAVE_JWKS_URL: 'https://identity.example.com/jwks',
  OATHWEAVE_USERINFO_URL: 'https://identity.example.com/userinfo',
  ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ issuer: 'https://identity.example.com', subject: 'subject-1', localUserId: 'operator' }]),
  ARDENT_STUDIO_OATHWEAVE_TOKEN_URL: 'https://identity.example.com/api/v1/oauth/token',
  ARDENT_STUDIO_MAGNUS_URL: 'https://magnus.example.com/',
  ARDENT_STUDIO_MAGNUS_CLIENT_ID: 'ardentstudio-magnus',
  ARDENT_STUDIO_MAGNUS_CLIENT_SECRET: 'fixture-magnus-secret',
  ARDENT_STUDIO_HIVEMEM_URL: 'https://hivemem.example.com',
  ARDENT_STUDIO_HIVEMEM_CLIENT_ID: 'ardentstudio-hivemem',
  ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET: 'fixture-hivemem-secret',
};

function issues(env: Record<string, string | undefined>): string[] {
  try { loadConfig(env); } catch (error) { if (error instanceof ConfigError) return error.issues.map(issue => issue.name); throw error; }
  return [];
}

describe('configuration', () => {
  it('loads a complete environment with defaults and no personal values', () => {
    const config = loadConfig(base);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8097);
    expect(config.maxBlobBytes).toBe(DEFAULT_MAX_BLOB_BYTES);
    expect(config.eventRetentionDays).toBe(30);
    expect(config.magnus.url).toBe('https://magnus.example.com');
    expect(config.oathweave.identities).toHaveLength(1);
    expect(config.chattermost).toBeUndefined();
  });

  it('fails fast naming every missing required variable', () => {
    const required = ENV_CATALOG.filter(entry => entry.required).map(entry => entry.name);
    expect(issues({}).sort()).toEqual([...required].sort());
  });

  it('never echoes secret values in errors', () => {
    try {
      loadConfig({ ...base, ARDENT_STUDIO_MAGNUS_URL: 'https://user:fixture-password@magnus.example.com' });
      expect.fail('should throw');
    } catch (error) {
      expect(String(error)).not.toContain('fixture-password');
      expect(String(error)).toContain('ARDENT_STUDIO_MAGNUS_URL');
    }
  });

  it('requires HTTPS for Oathweave and allows plain HTTP only on loopback or by explicit opt-in', () => {
    expect(issues({ ...base, OATHWEAVE_JWKS_URL: 'http://identity.example.com/jwks' })).toEqual(['OATHWEAVE_JWKS_URL']);
    expect(issues({ ...base, ARDENT_STUDIO_MAGNUS_URL: 'http://magnus.internal.example.com' })).toEqual(['ARDENT_STUDIO_MAGNUS_URL']);
    expect(issues({ ...base, ARDENT_STUDIO_MAGNUS_URL: 'http://127.0.0.1:4000' })).toEqual([]);
    expect(issues({ ...base, ARDENT_STUDIO_MAGNUS_URL: 'http://magnus:4000', ARDENT_STUDIO_ALLOW_PLAINTEXT_SERVICES: 'true' })).toEqual([]);
    expect(issues({ ...base, OATHWEAVE_ISSUER: 'http://127.0.0.1' })).toContain('OATHWEAVE_ISSUER');
  });

  it('validates identity links against the issuer and rejects duplicates', () => {
    expect(issues({ ...base, ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: '[{"issuer":"https://other.example.com","subject":"s","localUserId":"u"}]' }))
      .toEqual(['ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON']);
    const link = { issuer: 'https://identity.example.com', subject: 's', localUserId: 'u' };
    expect(issues({ ...base, ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([link, link]) })).toEqual(['ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON']);
    expect(issues({ ...base, ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ ...link, localUserId: 'service:x' }]) })).toEqual(['ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON']);
    expect(issues({ ...base, ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: JSON.stringify([{ ...link, permissions: ['magnus:admin'] }]) })).toEqual(['ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON']);
    expect(issues({ ...base, ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: 'not json' })).toEqual(['ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON']);
  });

  it('checks numbers, paths and the optional webhook', () => {
    expect(issues({ ...base, ARDENT_STUDIO_PORT: 'eighty' })).toEqual(['ARDENT_STUDIO_PORT']);
    expect(issues({ ...base, ARDENT_STUDIO_DATA: 'relative/data' })).toEqual(['ARDENT_STUDIO_DATA']);
    expect(issues({ ...base, ARDENT_STUDIO_MAX_BLOB_BYTES: '10' })).toEqual(['ARDENT_STUDIO_MAX_BLOB_BYTES']);
    expect(issues({ ...base, ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL: 'https://chat.example.com/api/v4/posts' })).toEqual(['ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL']);
    expect(loadConfig({ ...base, ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL: 'https://chat.example.com/api/v4/webhooks/incoming/id/fixture-secret' }).chattermost).toBeDefined();
    expect(loadConfig({ ...base, ARDENT_STUDIO_MAX_BLOB_BYTES: '1048576' }).maxBlobBytes).toBe(1048576);
  });

  it('documents every variable it reads', () => {
    const source = loadConfig.toString();
    for (const match of source.matchAll(/'((?:ARDENT_STUDIO|OATHWEAVE)_[A-Z_]+)'/g)) {
      expect(ENV_CATALOG.some(entry => entry.name === match[1])).toBe(true);
    }
    expect(ENV_CATALOG.filter(entry => entry.secret).map(entry => entry.name).sort())
      .toEqual(['ARDENT_STUDIO_CHATTERMOST_WEBHOOK_URL', 'ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET', 'ARDENT_STUDIO_MAGNUS_CLIENT_SECRET']);
  });
});
