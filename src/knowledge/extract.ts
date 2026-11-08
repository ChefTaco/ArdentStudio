// Text for project knowledge. Markdown, text, CSV, JSON and SVG are read as UTF-8; PDF text
// comes from pdf.js (legacy build, no font loading). DOCX waits for the canvas codec package.
import { chunkHash, HIVEMEM_MAX_CHUNK_BYTES, HIVEMEM_MAX_CHUNKS, HIVEMEM_MAX_SYNC_BYTES, type KnowledgeChunk } from '../clients/hivemem.js';

export type Extraction = { kind: 'text'; text: string } | { kind: 'unsupported'; reason: string };

const UTF8_TYPES = new Set(['text/markdown', 'text/plain', 'text/csv', 'application/json', 'image/svg+xml']);

export async function extractText(mime: string, bytes: Uint8Array): Promise<Extraction> {
  if (UTF8_TYPES.has(mime)) {
    try {
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '') };
    } catch {
      return { kind: 'unsupported', reason: 'The file is not valid UTF-8 text' };
    }
  }
  if (mime === 'application/pdf') return { kind: 'text', text: await pdfText(bytes) };
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return { kind: 'unsupported', reason: 'DOCX text extraction is not available yet; the file is stored and can be downloaded' };
  }
  return { kind: 'unsupported', reason: 'This file type is stored but has no text to index' };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js may transfer the buffer it is given, so pass a copy.
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+\n/g, '\n').trim();
      if (text) pages.push(`[Page ${number}]\n${text}`);
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

export class KnowledgeTooLargeError extends Error {
  override name = 'KnowledgeTooLargeError';
}

/**
 * Split text into HiveMem source chunks along Markdown headings and paragraphs. Keys are
 * positional (c0001, …) so an edit supersedes the chunks that changed and retires the rest.
 */
export function chunkText(text: string, maxChars = 4_000): KnowledgeChunk[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const chunks: Array<{ heading: string | null; content: string }> = [];
  let heading: string | null = null;
  let current = '';
  const flush = () => { if (current.trim()) chunks.push({ heading, content: current.trim() }); current = ''; };
  for (const block of blocks) {
    const match = /^#{1,6}\s+(.+)$/m.exec(block.split('\n')[0] ?? '');
    if (match) { flush(); heading = match[1]!.trim().slice(0, 200); }
    for (let start = 0; start < block.length; start += maxChars) {
      const piece = block.slice(start, start + maxChars);
      if (current && current.length + piece.length + 2 > maxChars) flush();
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  flush();
  if (chunks.length > HIVEMEM_MAX_CHUNKS) throw new KnowledgeTooLargeError(`The text needs ${chunks.length} chunks; HiveMem accepts at most ${HIVEMEM_MAX_CHUNKS} per source`);
  let total = 0;
  return chunks.map((chunk, index) => {
    const bytes = Buffer.byteLength(chunk.content);
    if (bytes > HIVEMEM_MAX_CHUNK_BYTES) throw new KnowledgeTooLargeError('A chunk exceeds the HiveMem chunk limit');
    total += bytes;
    if (total > HIVEMEM_MAX_SYNC_BYTES) throw new KnowledgeTooLargeError('The text exceeds the 4 MiB HiveMem source limit');
    return { chunk_key: `c${String(index + 1).padStart(4, '0')}`, content: chunk.content, content_hash: chunkHash(chunk.content), heading: chunk.heading };
  });
}
