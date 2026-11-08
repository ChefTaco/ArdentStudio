import type { ProjectEventRecord } from '../db/repos/events.js';

export type BusMessage =
  | { kind: 'event'; event: ProjectEventRecord }
  /** Live-only data such as message.delta: never persisted, never replayed, no seq. */
  | { kind: 'ephemeral'; type: string; payload: Record<string, unknown> };

type Listener = (message: BusMessage) => void;

/** In-process fan-out of committed project events to open streams. */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(projectId: string, listener: Listener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) { set = new Set(); this.listeners.set(projectId, set); }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(projectId);
    };
  }

  publish(projectId: string, message: BusMessage): void {
    for (const listener of this.listeners.get(projectId) ?? []) {
      try { listener(message); } catch { /* a broken stream must not stop the others */ }
    }
  }

  publishEphemeral(projectId: string, type: string, payload: Record<string, unknown>): void {
    this.publish(projectId, { kind: 'ephemeral', type, payload });
  }

  subscriberCount(projectId: string): number {
    return this.listeners.get(projectId)?.size ?? 0;
  }
}
