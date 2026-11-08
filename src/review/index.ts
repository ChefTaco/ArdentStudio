import type { BlobStore } from '../blobs/store.js';
import type { Conductor } from '../conductor/conductor.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';
import { revisionContext } from './context.js';
import { ArtifactImporter, type ImporterMagnus, type ImporterOptions } from './importer.js';

/** Connect Deliverable Review to the conductor: artifact imports and revision-task context. */
export function attachReview(options: { store: Store; blobs: BlobStore; magnus: ImporterMagnus; conductor: Conductor; logger: Logger } & Partial<Pick<ImporterOptions, 'retryMs' | 'maxAttempts'>>): ArtifactImporter {
  options.conductor.addContextProvider(revisionContext(options.store, options.blobs));
  return new ArtifactImporter(options);
}
