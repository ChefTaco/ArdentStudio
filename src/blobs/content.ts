// Uploaded bytes must be what their declared media type says, checked as they stream in and before
// anything is stored, with the rules Ardent applies to its artifacts: images, PDF and DOCX by their
// magic bytes, JSON must parse, SVG must contain an <svg> element. Plain text, Markdown and CSV stay
// free of encoding rules (exports in legacy encodings are common) but must not be binary.
import type { UPLOAD_MIME_TYPES } from '../shared/browser.js';

export type UploadMime = typeof UPLOAD_MIME_TYPES[number];

export class ContentMismatchError extends Error {
  override name = 'ContentMismatchError';
  constructor(readonly mime: string) { super(`The file content is not valid ${mime}`); }
}

/** JSON uploads are parsed whole up to this size; larger ones are only checked to be UTF-8. */
export const JSON_PARSE_LIMIT = 8 * 1024 * 1024;
/** How much of a text upload is checked for NUL bytes, the mark of binary content. */
const TEXT_PROBE_BYTES = 8192;

const MAGIC: Partial<Record<UploadMime, (head: Uint8Array) => boolean>> = {
  'image/png': head => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': head => startsWith(head, [0xff, 0xd8, 0xff]),
  'image/gif': head => latin1(head, 0, 6) === 'GIF87a' || latin1(head, 0, 6) === 'GIF89a',
  'image/webp': head => latin1(head, 0, 4) === 'RIFF' && latin1(head, 8, 12) === 'WEBP',
  'application/pdf': head => latin1(head, 0, 5) === '%PDF-',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': head => startsWith(head, [0x50, 0x4b, 0x03, 0x04]),
};

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}
function latin1(bytes: Uint8Array, start: number, end: number): string {
  return bytes.byteLength >= end ? String.fromCharCode(...bytes.subarray(start, end)) : '';
}

/** A check fed the upload chunk by chunk; write() and end() throw ContentMismatchError. */
export interface ContentInspector { write(chunk: Uint8Array): void; end(): void }

export function contentInspector(mime: UploadMime): ContentInspector {
  const fail = (): never => { throw new ContentMismatchError(mime); };
  const magic = MAGIC[mime];
  if (magic) {
    let head = new Uint8Array(0);
    return {
      write(chunk) {
        if (head.byteLength >= 16) return;
        const next = new Uint8Array(Math.min(16, head.byteLength + chunk.byteLength));
        next.set(head);
        next.set(chunk.subarray(0, next.byteLength - head.byteLength), head.byteLength);
        head = next;
      },
      end() { if (!magic(head)) fail(); },
    };
  }
  if (mime === 'application/json' || mime === 'image/svg+xml') {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let length = 0;
    const keep = mime === 'application/json' ? JSON_PARSE_LIMIT : 4096;
    return {
      write(chunk) {
        length += chunk.byteLength;
        let decoded = '';
        try { decoded = decoder.decode(chunk, { stream: true }); } catch { fail(); }
        if (text.length < keep) text += decoded.slice(0, keep - text.length);
      },
      end() {
        try { text += decoder.decode().slice(0, Math.max(0, keep - text.length)); } catch { fail(); }
        if (mime === 'image/svg+xml') { if (!/<svg[\s>]/iu.test(text)) fail(); return; }
        if (length <= JSON_PARSE_LIMIT) { try { JSON.parse(text); } catch { fail(); } }
      },
    };
  }
  // text/plain, text/markdown, text/csv
  let probed = 0;
  return {
    write(chunk) {
      if (probed >= TEXT_PROBE_BYTES) return;
      const part = chunk.subarray(0, TEXT_PROBE_BYTES - probed);
      probed += part.byteLength;
      if (part.includes(0)) fail();
    },
    end() { /* checked as it arrived */ },
  };
}

/** The upload body passed through the inspector: the stream errors with ContentMismatchError on a mismatch. */
export function inspected(body: ReadableStream<Uint8Array>, mime: UploadMime): ReadableStream<Uint8Array> {
  const inspector = contentInspector(mime);
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { inspector.write(chunk); controller.enqueue(chunk); },
    flush() { inspector.end(); },
  }));
}
