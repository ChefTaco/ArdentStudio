import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import type { BusMessage } from '../../events/bus.js';
import type { streamQuerySchema } from '../../shared/browser.js';
import { STREAM_RECHECK_MS } from '../../auth/authenticator.js';
import { requireProject, type AppDeps } from '../deps.js';
import { bearerToken, type createRouter } from '../routing.js';

export const HEARTBEAT_MS = 15_000;
const REPLAY_PAGE = 500;

export function streamRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, bus } = deps;

  register('GET', '/projects/{projectId}/stream', (c, { params, query, principal }) => {
    const projectId = requireProject(store, params.projectId).id;
    const { after } = query as z.infer<typeof streamQuerySchema>;
    const token = bearerToken(c);
    c.header('cache-control', 'no-store');
    c.header('x-accel-buffering', 'no');

    return streamSSE(c, async stream => {
      const queue: BusMessage[] = [];
      let wake: (() => void) | undefined;
      const notify = () => { const resume = wake; wake = undefined; resume?.(); };
      // Subscribe before replaying so nothing committed in between is missed; seq removes duplicates.
      const unsubscribe = bus.subscribe(projectId, message => { queue.push(message); notify(); });
      let closed = false;
      const close = () => { closed = true; notify(); };
      stream.onAbort(close);
      const expiry = setTimeout(close, Math.max(0, (principal?.expiresAt ?? 0) * 1000 - Date.now()));
      const heartbeat = setInterval(() => { queue.push({ kind: 'ephemeral', type: 'heartbeat', payload: {} }); notify(); }, deps.heartbeatMs ?? HEARTBEAT_MS);
      // A stream must not outlive logout: re-check the token while it is open.
      const recheck = setInterval(() => {
        if (!token) { close(); return; }
        deps.authenticate(token).then(current => {
          if (!current.permissions.includes('ardentstudio:projects:read')) close();
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
        const snapshot = deps.live.snapshot(projectId);
        for (let index = queue.length - 1; index >= 0; index--) {
          const queued = queue[index]!;
          if (queued.kind === 'ephemeral' && queued.type === 'message.delta') queue.splice(index, 1);
        }
        for (const live of snapshot) {
          await stream.writeSSE({ event: 'message.delta', data: JSON.stringify({ message_id: live.message_id, text: live.text, mode: 'replace', step: live.step }) });
        }

        while (!closed) {
          if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
          for (const message of queue.splice(0)) {
            if (closed) break;
            if (message.kind === 'event') {
              if (message.event.seq <= last) continue;
              // A gap means events arrived out of order: read them from the log instead.
              last = message.event.seq === last + 1
                ? (await stream.writeSSE({ event: message.event.type, id: String(message.event.seq), data: JSON.stringify(message.event) }), message.event.seq)
                : await sendEvents(last);
            } else if (message.type === 'heartbeat') {
              await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ seq: last, at: new Date().toISOString() }) });
            } else {
              await stream.writeSSE({ event: message.type, data: JSON.stringify(message.payload) });
            }
          }
        }
      } finally {
        unsubscribe();
        clearTimeout(expiry);
        clearInterval(heartbeat);
        clearInterval(recheck);
      }
    });
  });
}
