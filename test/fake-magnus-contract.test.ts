// The fake Magnus checks what it receives and serves against the published magnus-contracts schemas,
// so a test can only pass on shapes real Magnus accepts and sends.
import { afterEach, describe, expect, it } from 'vitest';
import { MagnusClient } from '../src/clients/magnus.js';
import { contractFor, fakeProfile, FakeMagnusServer } from './fake-magnus.js';

let fake: FakeMagnusServer | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

async function start() {
  fake = await new FakeMagnusServer().start();
  const client = new MagnusClient({ baseUrl: fake.url, tokens: { token: async () => 'fixture-service-token', invalidate: () => undefined }, timeoutMs: 5_000 });
  return { fake, client };
}

describe('fake Magnus contract checks', () => {
  it('maps requests to the contract routes and their answer schemas', () => {
    expect(contractFor('GET', '/api/v1/ardent/profiles', undefined)).toMatchObject({ where: 'GET /api/v1/ardent/profiles' });
    expect(contractFor('GET', '/api/v1/ardent/profiles', undefined).requestError).toBeUndefined();
    expect(contractFor('GET', '/api/v1/ardent/installations/node1/profiles/lead/identity/soul', undefined).data).toBeDefined();
    expect(contractFor('GET', '/api/v1/ardent/installations/node1/profiles/lead/tasks', undefined).data).toBeUndefined();
    expect(contractFor('POST', '/api/v1/ardent/installations/node1/profiles/lead/action', { action: 'task-pause', target: '0'.repeat(36) }).data).toBeDefined();
    expect(contractFor('GET', '/api/v1/ardent/installations/node1/profiles/lead/tasks/x/stream', undefined).events).toHaveProperty('task.done');
    expect(contractFor('DELETE', '/api/v1/ardent/profiles', undefined).requestError).toMatch(/not a route/);
    expect(contractFor('POST', '/api/v1/ardent/installations/node1/profiles/lead/action', { action: 'service-restart' }).requestError).toBeDefined();
  });

  it('records an answer real Magnus would never send', async () => {
    const { fake, client } = await start();
    fake.profiles = [{ ...fakeProfile('node1', 'lead'), backend: 'other' as never }];
    await expect(client.listProfiles()).rejects.toThrow();
    expect(() => fake.assertContract()).toThrow(/GET \/api\/v1\/ardent\/profiles answer/);
  });

  it('records a request real Magnus would refuse', async () => {
    const { fake, client } = await start();
    await expect(client.action('node1~lead', 'service-restart', {})).rejects.toThrow(/not allowed/);
    expect(fake.contractViolations.join('\n')).toMatch(/action request/);
    fake.contractViolations = [];
    fake.assertContract();
  });

  it('checks stream events against the route\'s event schemas', async () => {
    const { fake, client } = await start();
    const admission = await client.submitTask('node1~lead', { prompt: 'Map the coast', idempotency_key: crypto.randomUUID() });
    fake.text(admission.task_id, 1, 42 as unknown as string);
    fake.streamLimitMs = 50;
    for await (const _message of client.streamTask('node1~lead', admission.task_id)) { /* drain */ }
    expect(() => fake.assertContract()).toThrow(/stream event task\.text/);
    fake.contractViolations = [];
  });

  it('accepts what the fake serves by default', async () => {
    const { fake, client } = await start();
    fake.enableRuntime('node1~lead');
    await client.listProfiles();
    await client.listInstallations().catch(() => undefined);
    await client.getInstallation('node1');
    await client.identity('node1~lead', 'soul');
    fake.assertContract();
  });
});
