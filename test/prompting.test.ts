import { describe, expect, it } from 'vitest';
import { ardentTeamMissionSchema } from '../src/clients/magnus.js';
import { addressees, mentionedRoles } from '../src/conductor/addressing.js';
import { ardentIdempotencyKey } from '../src/conductor/conductor.js';
import { buildMission, composeTurn, missionResources, PROMPT_LIMIT, type TurnInput } from '../src/conductor/prompting.js';
import type { Message } from '../src/db/repos/room.js';
import { teamRole } from './helpers.js';

const roles = [
  { ...teamRole('lead', 'Story Lead', 'node1~lead', { coordinator: true }), binding_id: 'bnd_01JABCDEFGHJKMNPQRSTVWXYZ0' },
  { ...teamRole('writer', 'Worldbuilder', 'node1~scout'), binding_id: 'bnd_01JABCDEFGHJKMNPQRSTVWXYZ1' },
  { ...teamRole('mapper', 'Cartographer', null), binding_id: null },
];
const relationships = [{ from: 'lead', to: 'writer', type: 'delegates_to' as const }, { from: 'writer', to: 'lead', type: 'reports_to' as const }];

let seq = 0;
const message = (body: string, author: Message['author'] = { kind: 'user', user_id: 'operator' }): Message => ({
  id: `msg_${String(++seq).padStart(26, '0')}`, project_id: 'prj_x', conversation_id: 'cnv_x', seq, author, addressees: [], reply_to: null, thread_root: null,
  kind: 'message', body_md: body, attachments: [], links: {}, ardent: null, state: 'complete', created_at: '', updated_at: '',
});

const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  project: { id: 'prj_x', name: 'Emberfall', brief_md: 'A drowned valley.', audience: 'Players', constraints: ['Short'], deliverables: [] },
  team: { roles, relationships }, role: roles[0]!, task: { id: 'tsk_x', mode: 'turn', title: 'Outline', instructions_md: '', source: {} },
  firstTurn: true, unseen: [], trigger: message('Outline it.'),
  names: { author: item => item.author.kind === 'user' ? item.author.user_id : 'Worldbuilder', role: key => roles.find(role => role.key === key)?.name ?? key },
  attachments: [], ...overrides,
});

describe('prompting', () => {
  it('gives role instructions every turn and the brief and roster on the first turn only', () => {
    const first = composeTurn(input());
    expect(first.objective).toContain('You are Story Lead (role key "lead"), the team coordinator.');
    expect(first.objective).toContain('Brief:\nA drowned valley.');
    expect(first.objective).toContain('- Cartographer ("mapper") (no agent bound)');
    expect(first.objective).toContain('- Story Lead delegates to Worldbuilder');
    const later = composeTurn(input({ firstTurn: false, unseen: [message('Fenmarch it is.', { kind: 'agent', binding_id: 'bnd_x', role_key: 'writer' })] }));
    expect(later.objective).toContain('Story Lead project instructions.');
    expect(later.objective).not.toContain('A drowned valley.');
    expect(later.objective).toContain('Room messages since your last turn:\n[Worldbuilder] Fenmarch it is.');
    expect(later.contextItems).toEqual([]);
  });

  it('moves large material into context items for a mission and shortens it for a plain prompt', () => {
    const brief = 'Valley lore. '.repeat(1_000);
    const unseen = Array.from({ length: 50 }, (_, index) => message(`Note ${index}: ${'detail '.repeat(60)}`));
    const turn = composeTurn(input({ project: { ...input().project, brief_md: brief }, unseen, attachments: [{ name: 'style.md', mime: 'text/markdown', text: '# Style' }, { name: 'map.png', mime: 'image/png', text: null }] }));
    expect(turn.contextItems.map(item => item.title)).toEqual(['Project brief', 'Room messages since your last turn', 'Attachment: style.md']);
    expect(turn.objective).toContain('(in the context item "Project brief")');
    expect(turn.objective).toContain('- map.png (image/png; not included as text)');
    expect(turn.objective.length).toBeLessThanOrEqual(PROMPT_LIMIT);
    expect(turn.prompt.length).toBeLessThanOrEqual(PROMPT_LIMIT);
    expect(turn.prompt).toContain('[…earlier messages left out]');
    expect(turn.prompt).toContain('Note 49:');
    expect(turn.prompt).toContain('Message for you from operator:\nOutline it.');
  });

  it('builds a valid TeamMission with the hand-off tool only for roles that can hand off', () => {
    const mission = buildMission({ task: { id: 'tsk_01JABCDEFGHJKMNPQRSTVWXYZ0', mode: 'assignment', title: 'Draw the map', assignment_revision: 3 },
      project: { name: 'Emberfall', constraints: ['x'.repeat(3_000)], deliverables: [{ id: 'req_x', name: 'Region Map', kind: 'map', formats: ['svg'], stage: null, producer_role_key: 'writer' }] },
      team: { relationships }, role: roles[1]!, hivememProjectId: 'prj_x', now: new Date('2026-11-08T00:00:00Z') });
    expect(ardentTeamMissionSchema.parse(mission)).toEqual(mission);
    expect(mission).toMatchObject({ revision: 3, acceptance_criteria: ['Complete: Draw the map'], expected_artifacts: ['Region Map'], deadline: Date.parse('2026-11-08T00:00:00Z') / 1000 + 6 * 3600 });
    expect(mission.resources).not.toContain('tool:team_handoff');
    expect(missionResources({ team: { relationships }, role: roles[0]!, hivememProjectId: 'p' })[0]).toBe('tool:team_handoff');
  });

  it('addresses Team to the coordinator, mentions and roles in order, and refuses unbound roles', () => {
    const team = { kind: 'team' as const, role_key: null };
    expect(mentionedRoles('@writer then @lead, again @writer; not an@email or @unknown', roles)).toEqual(['writer', 'lead']);
    expect(addressees({ conversation: team, to: { kind: 'team' }, body: 'Plan it', roles })).toMatchObject({ roles: [{ key: 'lead' }] });
    expect(addressees({ conversation: team, to: { kind: 'coordinator' }, body: '@writer go', roles })).toMatchObject({ roles: [{ key: 'writer' }] });
    expect(addressees({ conversation: team, to: { kind: 'roles', roles: ['writer'] }, body: 'and @lead', roles })).toMatchObject({ roles: [{ key: 'writer' }, { key: 'lead' }] });
    expect(addressees({ conversation: team, to: { kind: 'roles', roles: ['mapper'] }, body: 'x', roles })).toEqual({ error: 'These roles have no bound agent', details: { roles: ['mapper'] } });
    expect(addressees({ conversation: { kind: 'direct', role_key: 'writer' }, to: { kind: 'team' }, body: '@lead', roles })).toMatchObject({ roles: [{ key: 'writer' }] });
    expect(addressees({ conversation: { kind: 'discussion', role_key: null }, to: { kind: 'team' }, body: 'x', roles })).toEqual({ roles: [] });
  });

  it('derives a stable UUID idempotency key per Studio task', () => {
    const key = ardentIdempotencyKey('tsk_01JABCDEFGHJKMNPQRSTVWXYZ0');
    expect(key).toBe(ardentIdempotencyKey('tsk_01JABCDEFGHJKMNPQRSTVWXYZ0'));
    expect(key).not.toBe(ardentIdempotencyKey('tsk_01JABCDEFGHJKMNPQRSTVWXYZ1'));
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
