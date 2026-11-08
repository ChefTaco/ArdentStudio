// DOCX review. ArdentStudio converts a DOCX with the headless canvas Word codec
// (@hivemagnus/canvas-word-codec, `importDocx(bytes) → { document, … }`) into the neutral
// exchange document plus a canvas-editor value, which the browser renders read-only. The codec
// gives paragraphs new random ids on every import, so a conversion is made once per file or
// revision and stored (`docx_documents`, the document itself as a blob); anchored comments use
// the stored paragraph ids. Until the codec package is published no converter is configured and
// the conversion routes answer 501.
import type { BlobStore } from '../blobs/store.js';
import type { DocxDocument } from '../db/repos/review.js';
import type { Store } from '../db/store.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What ArdentStudio needs from the codec: the converted document and its paragraph index. */
export interface DocxConverter {
  name: string;
  version: string;
  convert(bytes: Uint8Array): Promise<{ document: unknown; paragraphs: Array<{ id: string; text: string }> }>;
}

export class DocxUnavailableError extends Error {
  override name = 'DocxUnavailableError';
  constructor() { super('DOCX conversion is not available yet: it needs the canvas Word codec package (@hivemagnus/canvas-word-codec)'); }
}

/** The stored conversion of a file or revision, converting it once when a converter is configured. */
export async function docxDocument(store: Store, blobs: BlobStore, converter: DocxConverter | undefined, source: { kind: 'file' | 'revision'; id: string; sha256: string })
  : Promise<{ record: DocxDocument; document: unknown }> {
  const stored = store.review.docxDocument(source.kind, source.id);
  if (stored) return { record: stored, document: JSON.parse(new TextDecoder().decode(await blobs.readBytes(stored.document_sha256))) as unknown };
  if (!converter) throw new DocxUnavailableError();
  const converted = await converter.convert(await blobs.readBytes(source.sha256));
  const blob = await blobs.putBytes(new TextEncoder().encode(JSON.stringify(converted.document)), 'application/json');
  // A concurrent conversion may have stored first: keep the first, so ids never change.
  const record = store.review.saveDocxDocument({ source_kind: source.kind, source_id: source.id, blob_sha256: source.sha256, codec: converter.name,
    codec_version: converter.version, document_sha256: blob.sha256, paragraphs: converted.paragraphs });
  if (record.document_sha256 !== blob.sha256) return docxDocument(store, blobs, converter, source);
  return { record, document: converted.document };
}
