// Comment anchors (§3.5): each kind must fit the revision's type, and a text anchor must quote
// the revision exactly, so a comment always points at what the reviewer saw.
import type { z } from 'zod';
import type { BlobStore } from '../blobs/store.js';
import type { DeliverableRevision } from '../db/repos/review.js';
import type { Store } from '../db/store.js';
import type { commentAnchorSchema } from '../shared/browser.js';
import { DOCX_MIME } from './docx.js';

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

export const TEXT_MIMES = ['text/markdown', 'text/plain', 'text/csv', 'application/json', 'image/svg+xml'];
/** Largest revision whose text anchors are checked against the bytes. */
const TEXT_CHECK_LIMIT = 8 * 1024 * 1024;

export class AnchorError extends Error {
  override name = 'AnchorError';
  constructor(readonly status: 409 | 422, readonly code: string, message: string) { super(message); }
}

export async function checkAnchor(store: Store, blobs: BlobStore, revision: DeliverableRevision, anchor: CommentAnchor): Promise<void> {
  const fits: Record<CommentAnchor['kind'], boolean> = {
    file: true,
    text: TEXT_MIMES.includes(revision.mime),
    docx: revision.mime === DOCX_MIME,
    pdf: revision.mime === 'application/pdf',
    image: revision.mime.startsWith('image/'),
  };
  if (!fits[anchor.kind]) throw new AnchorError(422, 'ANCHOR_KIND', `A ${anchor.kind} anchor does not fit a ${revision.mime} revision`);
  if (anchor.kind === 'image') {
    if (anchor.x + anchor.w > 1 || anchor.y + anchor.h > 1 || anchor.w === 0 || anchor.h === 0) throw new AnchorError(422, 'ANCHOR_RANGE', 'The region must be inside the image and not empty');
  }
  if (anchor.kind === 'pdf' && anchor.rect && (anchor.rect.x + anchor.rect.w > 1 || anchor.rect.y + anchor.rect.h > 1)) {
    throw new AnchorError(422, 'ANCHOR_RANGE', 'The rectangle must be inside the page');
  }
  if (anchor.kind === 'text') {
    if (anchor.end < anchor.start) throw new AnchorError(422, 'ANCHOR_RANGE', 'end must not be before start');
    if (anchor.source_sha256 !== revision.blob_sha256) throw new AnchorError(409, 'ANCHOR_STALE', 'The anchor was made on different content than this revision');
    if (revision.size > TEXT_CHECK_LIMIT) return;
    const text = new TextDecoder().decode(await blobs.readBytes(revision.blob_sha256));
    if (anchor.end > text.length || text.slice(anchor.start, anchor.end) !== anchor.quote) {
      throw new AnchorError(422, 'ANCHOR_MISMATCH', 'The quote does not match the revision text at these offsets');
    }
  }
  if (anchor.kind === 'docx') {
    if (anchor.end < anchor.start) throw new AnchorError(422, 'ANCHOR_RANGE', 'end must not be before start');
    const converted = store.review.docxDocument('revision', revision.id);
    if (!converted) throw new AnchorError(409, 'DOCX_NOT_CONVERTED', 'This DOCX has no stored conversion yet; comment on the whole file');
    const paragraph = converted.paragraphs.find(item => item.id === anchor.paragraph_id);
    if (!paragraph) throw new AnchorError(422, 'ANCHOR_MISMATCH', 'The paragraph is not in this revision');
    if (anchor.end > paragraph.text.length || paragraph.text.slice(anchor.start, anchor.end) !== anchor.quote) {
      throw new AnchorError(422, 'ANCHOR_MISMATCH', 'The quote does not match the paragraph text at these offsets');
    }
  }
}

/** A short description of where a comment points, for agents and exports. */
export function describeAnchor(anchor: CommentAnchor, paragraphText?: string): string {
  switch (anchor.kind) {
    case 'text': return `Text at characters ${anchor.start}-${anchor.end}: "${anchor.quote}"`;
    case 'docx': return `Paragraph ${anchor.paragraph_id}, characters ${anchor.start}-${anchor.end}: "${anchor.quote}"${paragraphText ? `\nWhole paragraph: ${paragraphText}` : ''}`;
    case 'pdf': return `Page ${anchor.page}${anchor.rect ? ` at x ${anchor.rect.x}, y ${anchor.rect.y}, width ${anchor.rect.w}, height ${anchor.rect.h} (fractions of the page)` : ''}${anchor.quote ? `: "${anchor.quote}"` : ''}`;
    case 'image': return `Region at x ${anchor.x}, y ${anchor.y}, width ${anchor.w}, height ${anchor.h} (fractions of the image)${anchor.viewbox ? `; SVG viewBox coordinates x ${anchor.viewbox.x}, y ${anchor.viewbox.y}, width ${anchor.viewbox.w}, height ${anchor.viewbox.h}` : ''}`;
    case 'file': return 'The whole file';
  }
}
