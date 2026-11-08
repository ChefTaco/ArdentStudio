import { describe, expect, it } from 'vitest';
import { cycleMembers, validateTeam, type ValidationInput, type ValidationRole } from '../src/team/validation.js';

const role = (key: string, extra: Partial<ValidationRole> = {}): ValidationRole => ({ key, name: key.toUpperCase(), coordinator: false, deliverables: [], skills: [], agent_ref: `node~${key}`, ...extra });
const team = (extra: Partial<ValidationInput> = {}): ValidationInput => ({
  mode: 'assignment',
  roles: [role('lead', { coordinator: true }), role('writer', { deliverables: ['Report'] }), role('checker')],
  relationships: [{ from: 'writer', to: 'lead', type: 'reports_to' }, { from: 'checker', to: 'lead', type: 'reports_to' }],
  requestedDeliverables: [{ name: 'Report' }],
  agentFacts: new Map(['lead', 'writer', 'checker'].map(key => [`node~${key}`, { available: true, hivemem: 'ok', skillsEnabled: [] }])),
  ...extra,
});
const codes = (input: ValidationInput) => validateTeam(input).issues.map(issue => `${issue.severity}:${issue.code}`);

describe('team validation', () => {
  it('accepts a well-formed, fully bound team', () => {
    const result = validateTeam(team());
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ can_publish: true, can_start_room: true, agent_facts: 'complete' });
  });

  it('requires exactly one coordinator', () => {
    expect(codes(team({ roles: [role('a'), role('b', { deliverables: ['Report'] })], relationships: [] }))).toContain('error:coordinator_count');
    const two = validateTeam(team({ roles: [role('a', { coordinator: true }), role('b', { coordinator: true, deliverables: ['Report'] })], relationships: [] }));
    expect(two.can_publish).toBe(false);
    expect(two.issues.find(issue => issue.code === 'coordinator_count')?.message).toMatch(/2 are set/);
  });

  it('finds reporting cycles, multiple managers and a reporting coordinator', () => {
    const cyclic = team({ relationships: [{ from: 'writer', to: 'checker', type: 'reports_to' }, { from: 'checker', to: 'writer', type: 'reports_to' }] });
    expect(codes(cyclic)).toContain('error:reporting_cycle');
    expect(codes(team({ relationships: [{ from: 'writer', to: 'lead', type: 'reports_to' }, { from: 'writer', to: 'checker', type: 'reports_to' }, { from: 'checker', to: 'lead', type: 'reports_to' }] })))
      .toContain('error:multiple_managers');
    expect(codes(team({ relationships: [{ from: 'lead', to: 'writer', type: 'reports_to' }, { from: 'checker', to: 'lead', type: 'reports_to' }] })))
      .toContain('error:coordinator_reports');
  });

  it('allows a revise loop but not other hand-off cycles', () => {
    const base = team().relationships;
    const loop = [{ from: 'writer', to: 'checker', type: 'hands_off_to' as const }, { from: 'checker', to: 'writer', type: 'hands_off_to' as const, stage: 'revise' as const }];
    expect(codes(team({ relationships: [...base, ...loop] }))).toEqual([]);
    const cycle = [{ from: 'writer', to: 'checker', type: 'hands_off_to' as const }, { from: 'checker', to: 'writer', type: 'hands_off_to' as const }];
    expect(codes(team({ relationships: [...base, ...cycle] }))).toContain('error:workflow_cycle');
  });

  it('requires a producer for every requested deliverable', () => {
    expect(codes(team({ requestedDeliverables: [{ name: 'Map' }] }))).toContain('error:deliverable_without_producer');
    expect(codes(team({ requestedDeliverables: [{ name: 'Map', producer_role_key: 'checker' }] }))).not.toContain('error:deliverable_without_producer');
  });

  it('reports structural mistakes in relationships', () => {
    expect(codes(team({ relationships: [{ from: 'ghost', to: 'lead', type: 'reports_to' }] }))).toContain('error:unknown_role');
    expect(codes(team({ relationships: [{ from: 'lead', to: 'lead', type: 'delegates_to' }] }))).toContain('error:self_relationship');
    expect(codes(team({ roles: [...team().roles, role('lead')] }))).toContain('error:duplicate_role_key');
  });

  it('warns about unbound roles, roles outside the tree, and the same agent reviewing its only output', () => {
    expect(codes(team({ roles: [role('lead', { coordinator: true }), role('writer', { deliverables: ['Report'], agent_ref: null }), role('checker')] })))
      .toContain('warning:unbound_role');
    expect(codes(team({ relationships: [{ from: 'writer', to: 'lead', type: 'reports_to' }] }))).toContain('warning:outside_reporting_tree');
    const sameAgent = team({
      roles: [role('lead', { coordinator: true }), role('writer', { deliverables: ['Report'], agent_ref: 'node~shared' }), role('checker', { agent_ref: 'node~shared' })],
      relationships: [...team().relationships, { from: 'checker', to: 'writer', type: 'reviews' }],
      agentFacts: new Map([['node~lead', { available: true, hivemem: 'ok', skillsEnabled: [] }], ['node~shared', { available: true, hivemem: 'ok', skillsEnabled: [] }]]),
    });
    expect(codes(sameAgent)).toEqual(['warning:reviewer_is_only_producer']);
  });

  it('warns from agent facts, and never assumes unknown facts are fine', () => {
    const facts = new Map([
      ['node~lead', { available: false, hivemem: 'ok' as const, skillsEnabled: [] }],
      ['node~writer', { available: true, hivemem: 'missing' as const, skillsEnabled: ['research'] }],
      ['node~checker', { available: true, hivemem: 'ok' as const, skillsEnabled: [] }],
    ]);
    const roles = [role('lead', { coordinator: true }), role('writer', { deliverables: ['Report'], skills: [{ kind: 'local', ref: 'research' }, { kind: 'local', ref: 'drawing' }] }), role('checker')];
    const result = validateTeam(team({ roles, agentFacts: facts }));
    expect(result.issues.map(issue => issue.code)).toEqual(['agent_unavailable', 'agent_without_hivemem', 'skill_not_enabled']);
    expect(result.can_publish).toBe(true);
    expect(result.can_start_room).toBe(false);
    const unknown = validateTeam(team({ agentFacts: undefined }));
    expect(unknown.agent_facts).toBe('unavailable');
    expect(unknown.can_start_room).toBe(false);
    expect(unknown.issues.map(issue => issue.code)).toEqual(['agent_facts_unavailable']);
  });

  it('skips binding checks for templates', () => {
    const result = validateTeam({ mode: 'template', roles: [role('lead', { coordinator: true, agent_ref: null })], relationships: [] });
    expect(result.issues).toEqual([]);
    expect(result.can_start_room).toBe(false);
  });

  it('finds the members of a cycle', () => {
    expect(cycleMembers(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'b'], ['c', 'd']])).toEqual(['b', 'c']);
    expect(cycleMembers(['a', 'b'], [['a', 'b']])).toEqual([]);
  });
});
