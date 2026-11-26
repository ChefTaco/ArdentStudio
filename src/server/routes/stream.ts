import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import type { BusMessage } from '../../events/bus.js';
import type { streamQuerySchema } from '../../shared/browser.js';
import { STREAM_RECHECK_MS } from '../../auth/authenticator.js';
import { requireProject, type RouteDeps } from '../deps.js';
import { bearerToken, type createRouter } from '../routing.js';

export const HEARTBEAT_MS = 15_000;
const REPLAY_PAGE = 500;
/**
 * Messages one subscriber may have waiting. A slower consumer never grows the queue past this: queued
 * events are dropped and read from the event log instead, and queued live deltas become one replace
 * delta per streaming message.
 */
export const STREAM_QUEUE_MAX = 1_000;
const CURSOR = /^\d{1,15}$/;

export function streamRoutes(register: ReturnType<typeof createRouter>, deps: RouteDeps): void {
  const { store, bus } = deps;

  register('GET', '/projects/{projectId}/stream', (c, { params, query, principal }) => {
    const projectId = requireProject(store, params.projectId).id;
    // ?after= wins; otherwise the Last-Event-ID a reconnecting EventSource sends (the last seq it received).
    const lastEventId = c.req.header('last-event-id')?.trim();
    const after = (query as z.infer<typeof streamQuerySchema>).after ?? (lastEventId && CURSOR.test(lastEventId) ? lastEventId : undefined);
    const token = bearerToken(c);
    c.header('cache-control', 'no-store');
    c.header('x-accel-buffering', 'no');

    return streamSSE(c, async stream => {
      const queue: BusMessage[] = [];
      /** Events were dropped from the queue: read them from the log. */
      let backlog = false;
      /** Live deltas were dropped from the queue: send each streaming message's current text. */
      let relive = false;
      let wake: (() => void) | undefined;
      const notify = () => { const resume = wake; wake = undefined; resume?.(); };
      const enqueue = (message: BusMessage) => {
        if (queue.length >= STREAM_QUEUE_MAX) {
          const kept = queue.filter(item => !(item.kind === 'event' || item.type === 'message.delta' || item.type === 'heartbeat'));
          backlog ||= queue.some(item => item.kind === 'event');
          relive ||= queue.some(item => item.kind === 'ephemeral' && item.type === 'message.delta');
          queue.splice(0, queue.length, ...kept.slice(-(STREAM_QUEUE_MAX / 2)));
        }
        if (message.kind === 'event' && backlog) { notify(); return; }
        if (message.kind === 'ephemeral' && message.type === 'message.delta' && relive) { notify(); return; }
        queue.push(message);
        notify();
      };
      // Subscribe before replaying so nothing committed in between is missed; seq removes duplicates.
      const unsubscribe = bus.subscribe(projectId, enqueue);
      let closed = false;
      const close = () => { closed = true; notify(); };
      stream.onAbort(close);
      // On shutdown the stream ends; the client reconnects with its cursor to the next instance.
      if (deps.closing?.aborted) close(); else deps.closing?.addEventListener('abort', close, { once: true });
      const expiry = setTimeout(close, Math.max(0, (principal?.expiresAt ?? 0) * 1000 - Date.now()));
      const heartbeat = setInterval(() => enqueue({ kind: 'ephemeral', type: 'heartbeat', payload: {} }), deps.heartbeatMs ?? HEARTBEAT_MS);
      // A stream must not outlive logout or the caller's place in the project: re-check both while it is open.
      const recheck = setInterval(() => {
        if (!token) { close(); return; }
        deps.authenticate(token).then(current => {
          if (!current.permissions.includes('ardentstudio:projects:read') || deps.access.roleIn(current, projectId) === null) close();
        }, close);
      }, deps.streamRecheckMs ?? STREAM_RECHECK_MS);

      let last: number;
      const sendEvents = async (from: number) => {
        for (;;) {
          const page = store.events.after(projectId, from, REPLAY_PAGE);
          for (const event of page) {
            await stream.writeSSE({ event: event.type, id: String(event.seq), data: JSON.stringify(event) });
            from = event.seq;
          }
          if (page.length < REPLAY_PAGE) return from;
        }
      };

      try {
        const cursor = store.events.cursor(projectId);
        const requested = after === undefined ? undefined : Number(after);
        if (requested === undefined) {
          last = cursor.lastSeq;
        } else if (requested < cursor.compactedThrough || requested > cursor.lastSeq) {
          await stream.writeSSE({ event: 'reset', data: JSON.stringify({ seq: cursor.lastSeq, reason: requested > cursor.lastSeq ? 'cursor_ahead' : 'cursor_expired' }) });
          last = cursor.lastSeq;
        } else {
          last = await sendEvents(requested);
        }
        // Live reply text is never replayed: give each streaming message its current text once.
        // Deltas queued before this snapshot are already part of it.
        const sendLive = async () => {
          relive = false;
          const snapshot = deps.live.snapshot(projectId);
          for (let index = queue.length - 1; index >= 0; index--) {
            const queued = queue[index]!;
            if (queued.kind === 'ephemeral' && queued.type === 'message.delta') queue.splice(index, 1);
          }
          for (const live of snapshot) {
            await stream.writeSSE({ event: 'message.delta', data: JSON.stringify({ message_id: live.message_id, text: live.text, mode: 'replace', step: live.step }) });
          }
        };
        await sendLive();

        while (!closed) {
          if (!queue.length && !backlog && !relive) await new Promise<void>(resolve => { wake = resolve; });
          if (closed) break;
          if (backlog) {
            backlog = false;
            last = await sendEvents(last);
          }
          if (relive) await sendLive();
          for (const message of queue.splice(0)) {
            if (closed) break;
            if (message.kind === 'event') {
              if (message.event.seq <= last) continue;
              // A membership change takes effect at once for someone it removes, not at the next re-check.
              if (message.event.type === 'project.members.updated' && principal && deps.access.roleIn(principal, projectId) === null) { close(); break; }
              // A gap means events arrived out of order: read them from the log instead.
              last = message.event.seq === last + 1
                ? (await stream.writeSSE({ event: message.event.type, id: String(message.event.seq), data: JSON.stringify(message.event) }), message.event.seq)
                : await sendEvents(last);
            } else if (message.type === 'project.purged') {
              // The project is gone; nothing follows.
              await stream.writeSSE({ event: message.type, data: JSON.stringify(message.payload) });
              close();
            } else if (message.type === 'heartbeat') {
              await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ seq: last, at: new Date().toISOString() }) });
            } else {
              await stream.writeSSE({ event: message.type, data: JSON.stringify(message.payload) });
            }
          }
        }
      } finally {
        unsubscribe();
        deps.closing?.removeEventListener('abort', close);
        clearTimeout(expiry);
        clearInterval(heartbeat);
        clearInterval(recheck);
      }
    });
  });
}
