// Live reply text of messages that are still streaming. It is a view only: never persisted,
// never replayed, replaced by the stored message when the task finishes. A reconnecting
// project stream gets the current text of each streaming message as one `replace` delta.
import type { EventBus } from '../events/bus.js';

export interface LiveEntry { projectId: string; step: number; text: string }

export class LiveText {
  private readonly entries = new Map<string, LiveEntry>();

  constructor(private readonly bus: EventBus) {}

  /** A step started or a stream (re)connected: the text is the whole current step. */
  replace(projectId: string, messageId: string, step: number, text: string): void {
    this.entries.set(messageId, { projectId, step, text });
    this.bus.publishEphemeral(projectId, 'message.delta', { message_id: messageId, text, mode: 'replace', step });
  }

  /** More text for the current step. A delta for another step starts that step. */
  append(projectId: string, messageId: string, step: number, text: string): void {
    const current = this.entries.get(messageId);
    if (current && current.step !== step) { this.replace(projectId, messageId, step, text); return; }
    this.entries.set(messageId, { projectId, step, text: (current?.text ?? '') + text });
    this.bus.publishEphemeral(projectId, 'message.delta', { message_id: messageId, text, mode: 'append', step });
  }

  get(messageId: string): LiveEntry | undefined {
    return this.entries.get(messageId);
  }

  clear(messageId: string): void {
    this.entries.delete(messageId);
  }

  /** Current text of every streaming message in a project. */
  snapshot(projectId: string): Array<{ message_id: string; step: number; text: string }> {
    return [...this.entries].filter(([, entry]) => entry.projectId === projectId).map(([id, entry]) => ({ message_id: id, step: entry.step, text: entry.text }));
  }
}
