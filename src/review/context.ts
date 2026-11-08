// What a revision task is given: the anchored comments it was asked to address and, for text
// files, the current revision itself. Each comment says exactly where it points.
import type { BlobStore } from '../blobs/store.js';
import type { ContextProvider } from '../conductor/conductor.js';
import type { Store } from '../db/store.js';
import { describeAnchor, TEXT_MIMES, type CommentAnchor } from './anchors.js';

const INLINE_REVISION_LIMIT = 48 * 1024;

export function revisionContext(store: Store, blobs: BlobStore): ContextProvider {
  return task => {
    if (task.mode !== 'revision' || !Array.isArray(task.source.comment_ids)) return [];
    const items: Array<{ title: string; text: string; mime?: string }> = [];
    const revisionId = typeof task.source.revision_id === 'string' ? task.source.revision_id : undefined;
    const current = revisionId ? store.review.revision(revisionId) : undefined;
    const deliverable = current ? store.review.deliverable(current.deliverable_id) : undefined;
    for (const [index, id] of (task.source.comment_ids as unknown[]).entries()) {
      const comment = typeof id === 'string' ? store.review.comment(id) : undefined;
      if (!comment) continue;
      const on = store.review.revision(comment.revision_id);
      const anchor = comment.anchor as CommentAnchor;
      const paragraph = anchor.kind === 'docx' ? store.review.docxDocument('revision', comment.revision_id)?.paragraphs.find(item => item.id === anchor.paragraph_id)?.text : undefined;
      items.push({ title: `Comment ${index + 1} on ${deliverable?.name ?? 'the deliverable'} r${on?.revision ?? '?'}`,
        text: `${describeAnchor(anchor, paragraph)}\n\nComment by ${comment.author}:\n${comment.body_md}` });
    }
    if (current && deliverable && TEXT_MIMES.includes(current.mime) && current.size <= INLINE_REVISION_LIMIT) {
      try {
        items.push({ title: `Current ${deliverable.name} r${current.revision}`, text: blobs.readTextSync(current.blob_sha256), mime: current.mime === 'image/svg+xml' ? 'text/plain' : current.mime });
      } catch { /* The comments still go; the file can be named instead. */ }
    }
    return items;
  };
}
