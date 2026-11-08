// Follows one Ardent task through Magnus: one SSE subscription (journal events and live reply
// text) resumed after the last handled journal sequence. Ardent ends a stream after 60 seconds,
// so a clean end reconnects. When the stream fails, the follower polls the journal and the task
// every 1 to 5 seconds, then tries the stream again.
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ardentTaskDoneEventSchema, ardentTaskEventSchema, ardentTaskTextEventSchema, MagnusError, type ArdentTaskEvent, type MagnusClient } from '../clients/magnus.js';
import type { Logger } from '../logger.js';

export type FollowerMagnus = Pick<MagnusClient, 'streamTask' | 'taskEvents' | 'task'>;
export type DoneRecord = z.infer<typeof ardentTaskDoneEventSchema>;

/** Ardent states after which a task's turn is over. Ardent keeps `input_required` out of its stream's done set, so it is listed here. */
export const ARDENT_FINISHED = ['completed', 'partial', 'failed', 'cancelled', 'unknown', 'input_required'] as const;

export interface FollowerHooks {
  /** The journal sequence already handled. */
  cursor(): number;
  text(step: number, text: string, mode: 'replace' | 'append'): void;
  /** Handle and persist one journal event. Returns true when the event ends the turn. */
  event(event: ArdentTaskEvent): Promise<boolean> | boolean;
  done(record: DoneRecord): Promise<void>;
}

export interface FollowerOptions {
  pollMinMs?: number;
  pollMaxMs?: number;
  /** How long to poll before trying the stream again. */
  pollWindowMs?: number;
  /** Pause between a clean stream end and the reconnect. */
  reconnectMs?: number;
}

export class TaskFollower {
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;
  private readonly pollMin: number;
  private readonly pollMax: number;
  private readonly pollWindow: number;
  private readonly reconnect: number;
  /** How the follower currently reads the task: for tests and diagnostics. */
  mode: 'stream' | 'poll' | 'done' = 'stream';

  constructor(private readonly magnus: FollowerMagnus, private readonly agentRef: string, private readonly ardentTaskId: string,
    private readonly hooks: FollowerHooks, private readonly logger: Logger, options: FollowerOptions = {}) {
    this.pollMin = options.pollMinMs ?? 1_000;
    this.pollMax = options.pollMaxMs ?? 5_000;
    this.pollWindow = options.pollWindowMs ?? 30_000;
    this.reconnect = options.reconnectMs ?? 250;
  }

  start(): Promise<void> {
    this.running ??= this.loop().catch(error => {
      this.logger.error('Task follower stopped unexpectedly', { task_id: this.ardentTaskId, error: error instanceof Error ? error.message : 'unknown' });
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }

  private get stopped(): boolean { return this.abort.signal.aborted; }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.mode = 'stream';
      let failed = false;
      try {
        if (await this.stream()) { this.mode = 'done'; return; }
      } catch (error) {
        if (this.stopped) return;
        failed = true;
        this.logger.warn('Task stream failed; polling', { task_id: this.ardentTaskId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      }
      if (this.stopped) return;
      if (failed) {
        this.mode = 'poll';
        if (await this.poll()) { this.mode = 'done'; return; }
      } else {
        await this.sleep(this.reconnect);
      }
    }
  }

  /** One SSE subscription. True when the task finished. */
  private async stream(): Promise<boolean> {
    for await (const message of this.magnus.streamTask(this.agentRef, this.ardentTaskId, { after: this.hooks.cursor(), signal: this.abort.signal })) {
      if (this.stopped) return false;
      if (message.event === 'task.text' || message.event === 'task.delta') {
        const parsed = ardentTaskTextEventSchema.safeParse(parseJson(message.data));
        if (parsed.success) this.hooks.text(parsed.data.step, parsed.data.text, message.event === 'task.text' ? 'replace' : 'append');
      } else if (message.event === 'task.event') {
        const parsed = ardentTaskEventSchema.safeParse(parseJson(message.data));
        if (!parsed.success) continue;
        if (await this.hooks.event(parsed.data)) return true;
      } else if (message.event === 'task.done') {
        const parsed = ardentTaskDoneEventSchema.safeParse(parseJson(message.data));
        await this.hooks.done(parsed.success ? parsed.data : { id: this.ardentTaskId, state: 'unknown', error: 'Ardent sent an unreadable final task record' });
        return true;
      }
    }
    return false;
  }

  /** Poll the journal and the task. True when the task finished; false to try the stream again. */
  private async poll(): Promise<boolean> {
    const until = Date.now() + this.pollWindow;
    let interval = this.pollMin;
    while (!this.stopped && Date.now() < until) {
      try {
        // A journal page Magnus cannot relay (an error, or a page over its size limit) must not
        // hide that the task finished: the task record is read either way.
        let events: Awaited<ReturnType<FollowerMagnus['taskEvents']>> = [];
        let unreadable: unknown;
        try { events = await this.magnus.taskEvents(this.agentRef, this.ardentTaskId, this.hooks.cursor(), { signal: this.abort.signal }); }
        catch (error) {
          if (error instanceof MagnusError && error.status === 404) throw error;
          unreadable = error;
        }
        for (const event of events) if (await this.hooks.event(event)) return true;
        const task = await this.magnus.task(this.agentRef, this.ardentTaskId, { signal: this.abort.signal });
        if ((ARDENT_FINISHED as readonly string[]).includes(task.state)) {
          await this.hooks.done(task);
          return true;
        }
        if (unreadable !== undefined) throw unreadable;
        interval = events.length ? this.pollMin : Math.min(this.pollMax, interval * 2);
      } catch (error) {
        if (this.stopped) return false;
        if (error instanceof MagnusError && error.status === 404) {
          await this.hooks.done({ id: this.ardentTaskId, state: 'unknown', error: 'Ardent has no record of this task' });
          return true;
        }
        interval = this.pollMax;
      }
      await this.sleep(interval);
    }
    return false;
  }

  private async sleep(ms: number): Promise<void> {
    await delay(ms, undefined, { signal: this.abort.signal }).catch(() => undefined);
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
