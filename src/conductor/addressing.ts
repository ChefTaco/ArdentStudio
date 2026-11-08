// Who a room message starts turns for (§4.4): Team or Coordinator → the coordinator; a role or
// an @mention → one turn per addressee, in order. Pure, so routes and tests share it.
import type { Conversation } from '../db/repos/room.js';
import type { TeamRole } from './prompting.js';

export type Recipient = { kind: 'team' } | { kind: 'coordinator' } | { kind: 'roles'; roles: string[] };

const MENTION = /(^|[\s(,;])@([a-z][a-z0-9_-]{0,47})(?![a-z0-9_-])/g;

/** Role keys @mentioned in a message, in order of first mention. Unknown keys are ignored. */
export function mentionedRoles(body: string, roles: readonly Pick<TeamRole, 'key'>[]): string[] {
  const known = new Set(roles.map(role => role.key));
  const found: string[] = [];
  for (const match of body.matchAll(MENTION)) {
    const key = match[2]!;
    if (known.has(key) && !found.includes(key)) found.push(key);
  }
  return found;
}

export type Addressing = { roles: TeamRole[] } | { error: string; details: Record<string, unknown> };

export function addressees(input: { conversation: Pick<Conversation, 'kind' | 'role_key'>; to: Recipient; body: string; roles: readonly TeamRole[] }): Addressing {
  const { conversation, roles } = input;
  if (conversation.kind === 'discussion') return { roles: [] };
  let keys: string[];
  if (conversation.kind === 'direct') {
    keys = conversation.role_key ? [conversation.role_key] : [];
  } else {
    const mentions = mentionedRoles(input.body, roles);
    if (input.to.kind === 'roles') keys = [...new Set([...input.to.roles, ...mentions])];
    else if (mentions.length) keys = mentions;
    else {
      const coordinator = roles.find(role => role.coordinator);
      if (!coordinator) return { error: 'The team has no coordinator', details: {} };
      keys = [coordinator.key];
    }
  }
  const unknown = keys.filter(key => !roles.some(role => role.key === key));
  if (unknown.length) return { error: 'The message names roles that are not in the published team', details: { roles: unknown } };
  const chosen = keys.map(key => roles.find(role => role.key === key)!);
  const unbound = chosen.filter(role => !role.agent_ref).map(role => role.key);
  if (unbound.length) return { error: 'These roles have no bound agent', details: { roles: unbound } };
  return { roles: chosen };
}
