// Relays Magnus New Agent operations to the project that started them. Magnus runs the
// operation (profile, identity, HiveMem, model, skills, start, ready probe); Studio only mirrors
// its step receipts as `agent.operation.updated` events, from Magnus's operation stream, or by
// polling when the stream fails. Running operations are picked up again after a restart.
import { setTimeout as delay } from 'node:timers/promises';
import { agentOperationSchema, type MagnusAgentOperation, type MagnusClient } from '../clients/magnus.js';
import type { AgentOperationRecord } from '../db/repos/agents.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';

export type OperationMagnus = Pick<MagnusClient, 'agentOperation' | 'streamAgentOperation'>;

/** An operation as the browser sees it. */
export function operationView(record: AgentOperationRecord, operation: MagnusAgentOperation | undefined) {
  return {
    id: record.id, agent_ref: record.agent_ref, project_id: record.project_id, role_key: record.role_key,
    kind: operation?.kind ?? 'deploy', status: operation?.status ?? record.status,
    steps: (operation?.steps ?? []).map(step => ({ name: step.name, status: step.status, started_at: step.startedAt, finished_at: step.finishedAt, receipt: step.receipt, error: step.error })),
    error: operation?.error ?? null, attempts: operation?.attempts ?? 0, created_by: record.created_by,
    created_at: record.created_at, updated_at: operation?.updatedAt ?? record.updated_at, completed_at: operation?.completedAt ?? null,
  };
}

export class OperationRelay {
  private readonly running = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly store: Store, private readonly magnus: OperationMagnus, private readonly logger: Logger,
    private readonly options: { pollMs?: number; maxPolls?: number } = {}) {}

  start(): void {
    this.stopped = false;
    for (const record of this.store.agents.runningOperations()) this.follow(record.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  follow(id: string): void {
    if (this.stopped || this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    void this.run(id, controller.signal).catch(error => this.logger.warn('Agent operation relay stopped', { operation_id: id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }))
      .finally(() => { if (this.running.get(id) === controller) this.running.delete(id); });
  }

  /** Store and publish Magnus's view of an operation. True once it has finished. */
  apply(id: string, operation: MagnusAgentOperation): boolean {
    const record = this.store.agents.operation(id);
    if (!record) return true;
    this.store.tx(() => {
      if (!this.store.agents.updateOperation(id, operation.status, operation as Record<string, unknown>)) return;
      const updated = this.store.agents.operation(id)!;
      if (updated.project_id) this.store.emit(updated.project_id, 'agent.operation.updated', { operation: operationView(updated, operation) });
    });
    return operation.status !== 'running';
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    let polls = 0;
    while (!signal.aborted && polls < (this.options.maxPolls ?? 720)) {
      try {
        for await (const message of this.magnus.streamAgentOperation(id, { signal })) {
          if (message.event !== 'operation' && message.event !== 'done') continue;
          const parsed = agentOperationSchema.safeParse(JSON.parse(message.data) as unknown);
          if (parsed.success && this.apply(id, parsed.data)) return;
        }
      } catch {
        if (signal.aborted) return;
      }
      // The stream ended or failed before the operation finished: read it, then try again.
      try {
        if (this.apply(id, await this.magnus.agentOperation(id, { signal }))) return;
      } catch { /* Magnus unreachable: keep the last known state and retry. */ }
      polls++;
      await delay(this.options.pollMs ?? 5_000, undefined, { signal }).catch(() => undefined);
    }
  }
}
