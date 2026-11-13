/** One server-sent event. `id` is absent for events that are not resumable. */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Parse a text/event-stream body. Comments are skipped; a final unterminated event is dropped, as the spec says. */
export async function* parseSse(body: ReadableStream<Uint8Array>, maxEventBytes = 4 * 1024 * 1024): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  let size = 0;
  /** Complete lines of the buffer. A CR that ends it may be half of a CRLF, so it waits for more input unless the stream ended. */
  function* lines(ended: boolean): Generator<SseMessage> {
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
      if (!ended && newline === buffer.length - 1 && buffer.charCodeAt(newline) === 13) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
      if (line === '') {
        if (data.length) yield { event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) };
        event = ''; data = []; id = undefined; size = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      size += value.length;
      if (size > maxEventBytes) throw new Error('Server-sent event exceeds the size limit');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id' && !value.includes('\0')) id = value;
    }
  }
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* lines(false);
    if (buffer.length > maxEventBytes) throw new Error('Server-sent event exceeds the size limit');
  }
  yield* lines(true);
}
