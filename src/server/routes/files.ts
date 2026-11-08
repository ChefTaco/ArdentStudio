import { Readable } from 'node:stream';
import type { z } from 'zod';
import { BlobTooLargeError } from '../../blobs/store.js';
import { fileIdSchema, sha256Schema, uploadMimeSchema, type listFilesQuerySchema, type uploadFileQuerySchema } from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

export function fileRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, blobs } = deps;

  register('POST', '/projects/{projectId}/files', async (c, { params, query, principal, idempotencyKey, idempotent }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const { name, purpose } = query as z.infer<typeof uploadFileQuerySchema>;
    const mime = uploadMimeSchema.safeParse((c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase());
    if (!mime.success) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'This file type cannot be uploaded', { allowed: uploadMimeSchema.options });
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > blobs.maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Files are limited to ${blobs.maxBytes} bytes`);
    const stream = c.req.raw.body;
    if (!stream) throw new ApiError(400, 'VALIDATION_ERROR', 'The request has no body');
    let blob;
    try {
      // Streamed to a temp file, fsynced, renamed and re-verified; never buffered whole in memory.
      blob = await blobs.put(Readable.fromWeb(stream as import('node:stream/web').ReadableStream<Uint8Array>), mime.data);
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Files are limited to ${blobs.maxBytes} bytes`);
      throw error;
    }
    if (blob.size === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'The file is empty');
    const actor = actorOf(principal);
    const reply = await idempotent([project.id, name, purpose, mime.data, blob.sha256].join('\u0000'), () => {
      const file = store.tx(() => {
        const created = store.files.create({ projectId: project.id, name, mime: mime.data, size: blob.size, sha256: blob.sha256, purpose, createdBy: actor.userId });
        store.emit(project.id, 'file.created', { file_id: created.id, name, purpose, knowledge: created.knowledge });
        store.record(actor, 'file.upload', { type: 'file', id: created.id }, { project_id: project.id, sha256: blob.sha256, size: blob.size, mime: mime.data, purpose }, idempotencyKey);
        return created;
      });
      return { status: 201, body: file };
    });
    if (purpose === 'reference') deps.knowledge.kick();
    return reply;
  });

  register('GET', '/projects/{projectId}/files', (_c, { params, query }) => {
    const project = requireProject(store, params.projectId);
    return { body: { files: store.files.list(project.id, (query as z.infer<typeof listFilesQuerySchema>).purpose) } };
  });

  register('GET', '/blobs/{sha256}', c => {
    const sha = sha256Schema.safeParse(c.req.param('sha256'));
    // Only blobs a project file references are served; other stored bytes stay private.
    const opened = sha.success && store.files.blobReferenced(sha.data) ? blobs.open(sha.data) : undefined;
    if (!opened) throw notFound('Blob');
    return new Response(Readable.toWeb(opened.stream) as ReadableStream, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(opened.record.size),
        'content-disposition': `attachment; filename="${opened.record.sha256}"`,
        'x-blob-mime': opened.record.mime,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${opened.record.sha256}"`,
      },
    });
  });

  register('POST', '/files/{fileId}/reindex', (_c, { params, principal, idempotencyKey }) => {
    const id = fileIdSchema.safeParse(params.fileId);
    const file = id.success ? store.files.get(id.data) : undefined;
    if (!file) throw notFound('File');
    requireActive(requireProject(store, file.project_id));
    if (file.purpose !== 'reference') throw new ApiError(409, 'NOT_A_REFERENCE', 'Only reference files are indexed');
    const actor = actorOf(principal);
    const queued = store.tx(() => {
      const updated = store.files.queueSync(file.id);
      store.emit(file.project_id, 'file.updated', { file_id: file.id, knowledge: updated.knowledge });
      store.record(actor, 'file.reindex', { type: 'file', id: file.id }, {}, idempotencyKey);
      return updated;
    });
    deps.knowledge.kick();
    return { body: queued };
  });
}
