import type { RouteDeps } from '../deps.js';
import type { createRouter } from '../routing.js';

export function agentRoutes(register: ReturnType<typeof createRouter>, deps: RouteDeps): void {
  // The person's subject travels with the request so Magnus can authorize and audit it.
  register('GET', '/agents', async (_c, { principal }) => {
    const list = await deps.agents.list({ actingSubject: principal?.subject });
    // An agent's roles name their projects: keep those the caller can see.
    const roleOf = principal ? deps.access.roles(principal) : () => null;
    const visible = new Map<string, boolean>();
    const sees = (projectId: string) => {
      let seen = visible.get(projectId);
      if (seen === undefined) {
        const project = deps.store.projects.get(projectId);
        seen = project ? roleOf(projectId, project.created_by) !== null : false;
        visible.set(projectId, seen);
      }
      return seen;
    };
    return { body: { ...list, agents: list.agents.map(agent => ({ ...agent, roles: agent.roles.filter(role => sees(role.project_id)) })) } };
  });
}
