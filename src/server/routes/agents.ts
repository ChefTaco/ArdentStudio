import type { AppDeps } from '../deps.js';
import type { createRouter } from '../routing.js';

export function agentRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  // The person's subject travels with the request so Magnus can authorize and audit it.
  register('GET', '/agents', async (_c, { principal }) => ({ body: await deps.agents.list({ actingSubject: principal?.subject }) }));
}
