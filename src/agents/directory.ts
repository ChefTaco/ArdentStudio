// What Studio knows about agents comes from Magnus, with Studio presentation layered on top.
// Nothing here is invented: an agent Magnus does not report is not listed, and a fact Magnus
// could not answer stays unknown.
import type { z } from 'zod';
import { agentRef, type CallContext, type MagnusArdentProfile, type MagnusClient } from '../clients/magnus.js';
import type { Store } from '../db/store.js';
import type { agentSchema, listAgentsResponseSchema } from '../shared/browser.js';
import type { AgentFacts } from '../team/validation.js';

export type StudioAgent = z.infer<typeof agentSchema>;
export type AgentList = z.infer<typeof listAgentsResponseSchema>;
export type MagnusAgentApi = Pick<MagnusClient, 'listProfiles' | 'memoryStatus' | 'skills'>;

const PROFILE_CACHE_MS = 10_000;
const FACT_TIMEOUT_MS = 4_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);
}

export class AgentDirectory {
  private cache: { at: number; profiles: MagnusArdentProfile[] } | undefined;

  private readonly now: () => number;
  private readonly cacheMs: number;

  constructor(private readonly magnus: MagnusAgentApi, private readonly store: Store, options: { now?: () => number; cacheMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? PROFILE_CACHE_MS;
  }

  /** Magnus profiles, cached briefly so one page load does not ask Magnus repeatedly. */
  async profiles(context: CallContext = {}): Promise<MagnusArdentProfile[]> {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.profiles;
    const profiles = await this.magnus.listProfiles(context);
    this.cache = { at: this.now(), profiles };
    return profiles;
  }

  async list(context: CallContext = {}): Promise<AgentList> {
    let profiles: MagnusArdentProfile[];
    try {
      profiles = await this.profiles(context);
    } catch (error) {
      return { agents: [], available_count: 0, magnus: { state: 'unavailable', error: error instanceof Error ? error.message.slice(0, 300) : 'Magnus unavailable' } };
    }
    const presentations = new Map(this.store.agents.presentations().map(item => [item.agent_ref, item]));
    const bindings = new Map(this.store.team.bindings().map(item => [item.agent_ref, item]));
    const roles = this.store.team.rolesForAgents();
    const agents = profiles.map((profile): StudioAgent => {
      const ref = agentRef(profile.nodeId, profile.id);
      const presentation = presentations.get(ref);
      const binding = bindings.get(ref);
      return {
        agent_ref: ref,
        node_id: profile.nodeId,
        node_name: profile.nodeName,
        profile: profile.id,
        backend: profile.backend,
        running: profile.running,
        reachable: profile.reachable,
        available: isAvailable(profile),
        installation_version: profile.installationVersion,
        error: profile.error,
        display_name: presentation?.display_name ?? binding?.display_name ?? profile.id,
        portrait: presentation?.portrait ?? null,
        binding_id: binding?.id ?? null,
        roles: roles.filter(role => role.agent_ref === ref).map(({ agent_ref: _ref, ...role }) => role),
      };
    });
    return { agents, available_count: agents.filter(agent => agent.available).length, magnus: { state: 'ok', error: null } };
  }

  /** Facts for team validation. Undefined when Magnus cannot list profiles at all. */
  async facts(refs: readonly string[], context: CallContext = {}): Promise<Map<string, AgentFacts> | undefined> {
    if (!refs.length) return new Map();
    let profiles: MagnusArdentProfile[];
    try { profiles = await this.profiles(context); } catch { return undefined; }
    const byRef = new Map(profiles.map(profile => [agentRef(profile.nodeId, profile.id), profile]));
    const entries = await Promise.all([...new Set(refs)].map(async (ref): Promise<[string, AgentFacts]> => {
      const profile = byRef.get(ref);
      if (!profile) return [ref, { available: false, hivemem: 'unknown', skillsEnabled: null }];
      const available = isAvailable(profile);
      if (!available) return [ref, { available, hivemem: 'unknown', skillsEnabled: null }];
      const [memory, skills] = await Promise.allSettled([
        withTimeout(this.magnus.memoryStatus(ref, context), FACT_TIMEOUT_MS),
        withTimeout(this.magnus.skills(ref, context), FACT_TIMEOUT_MS),
      ]);
      return [ref, {
        available,
        hivemem: memory.status === 'fulfilled' ? (memory.value.status === 'ready' ? 'ok' : 'missing') : 'unknown',
        skillsEnabled: skills.status === 'fulfilled' ? skills.value.filter(skill => skill.enabled).map(skill => skill.name) : null,
      }];
    }));
    return new Map(entries);
  }
}

export function isAvailable(profile: MagnusArdentProfile): boolean {
  return profile.reachable && profile.running && !profile.error;
}
