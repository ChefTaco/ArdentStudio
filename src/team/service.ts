import type { z } from 'zod';
import type { AgentDirectory } from '../agents/directory.js';
import type { CallContext } from '../clients/magnus.js';
import type { Project } from '../db/repos/projects.js';
import type { TeamBody } from '../db/repos/team.js';
import type { Store } from '../db/store.js';
import type { teamStateSchema } from '../shared/browser.js';
import { validateTeam, type ValidationResult } from './validation.js';

export type TeamState = z.infer<typeof teamStateSchema>;

/** Validate an assignment body against the project's requested deliverables and live agent facts. */
export async function validateAssignment(project: Project, body: TeamBody, agents: AgentDirectory, context: CallContext): Promise<ValidationResult> {
  const refs = body.roles.flatMap(role => role.agent_ref ? [role.agent_ref] : []);
  const facts = await agents.facts(refs, context);
  return validateTeam({ mode: 'assignment', roles: body.roles, relationships: body.relationships, requestedDeliverables: project.deliverables, agentFacts: facts });
}

export async function teamState(store: Store, project: Project, agents: AgentDirectory, context: CallContext): Promise<TeamState> {
  const current = store.team.current(project.id) ?? null;
  const draft = store.team.draft(project.id) ?? null;
  const subject = draft ?? current;
  return { current, draft, validation: subject ? await validateAssignment(project, subject.body, agents, context) : null };
}
