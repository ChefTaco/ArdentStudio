import { Readable } from 'node:stream';
import type { z } from 'zod';
import { ContentMismatchError, inspected } from '../../blobs/content.js';
import { BlobTooLargeError } from '../../blobs/store.js';
import { fileIdSchema, sha256Schema, uploadMimeSchema, type blobQuerySchema, type listFilesQuerySchema, type uploadFileQuerySchema } from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

/** Types a preview (disposition=inline) is served as: raster images, which the CSP sandbox and nosniff keep inert. */
const PREVIEW_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * One `bytes=` range of a blob of `size` bytes: the inclusive byte offsets, 'unsatisfiable', or
 * undefined to answer the whole blob (a malformed header or several ranges, which may be ignored).
 */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (match[2] && Number(match[2]) < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

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
      // Checked against its type as it streams to a temp file, fsynced, renamed and re-verified; never buffered whole
      // in memory. Bytes that are not what Content-Type says are refused before anything is stored.
      blob = await blobs.put(inspected(stream as ReadableStream<Uint8Array>, mime.data), mime.data);
    } catch (error) {
      if (error instanceof BlobTooLargeError) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Files are limited to ${blobs.maxBytes} bytes`);
      if (error instanceof ContentMismatchError) throw new ApiError(422, 'CONTENT_MISMATCH', error.message);
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

  register('GET', '/blobs/{sha256}', (c, { query }) => {
    const sha = sha256Schema.safeParse(c.req.param('sha256'));
    // Only blobs a project file, a revision, a rendition or an export references are served; other stored bytes (DOCX conversions) stay private.
    const record = sha.success && (store.files.blobReferenced(sha.data) || store.review.blobReferenced(sha.data)) ? blobs.get(sha.data) : undefined;
    if (!record) throw notFound('Blob');
    const { disposition } = query as z.infer<typeof blobQuerySchema>;
    const etag = `"${record.sha256}"`;
    const inline = disposition === 'inline';
    const headers: Record<string, string> = {
      // Previews get the real type of raster images only; everything else stays an opaque download.
      'content-type': inline && PREVIEW_MIME.has(record.mime) ? record.mime : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${record.sha256}"`,
      'accept-ranges': 'bytes',
      'x-blob-mime': record.mime,
      'x-content-sha256': record.sha256,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
    };
    const ifRange = c.req.header('if-range');
    const range = c.req.header('range') !== undefined && (ifRange === undefined || ifRange === etag) ? parseRange(c.req.header('range')!, record.size) : undefined;
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${record.size}`, 'content-length': '0' } });
    }
    const opened = blobs.open(record.sha256, range ?? undefined);
    if (!opened) throw notFound('Blob');
    if (range) {
      return new Response(Readable.toWeb(opened.stream) as ReadableStream, { status: 206,
        headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${record.size}`, 'content-length': String(range.end - range.start + 1) } });
    }
    return new Response(Readable.toWeb(opened.stream) as ReadableStream, { status: 200, headers: { ...headers, 'content-length': String(record.size) } });
  });

  const requireFile = (fileId: string | undefined) => {
    const id = fileIdSchema.safeParse(fileId);
    const file = id.success ? store.files.get(id.data) : undefined;
    if (!file) throw notFound('File');
    return file;
  };

  register('POST', '/files/{fileId}/reindex', (_c, { params, principal, idempotencyKey }) => {
    const file = requireFile(params.fileId);
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

  register('DELETE', '/files/{fileId}', (_c, { params, principal, idempotencyKey }) => {
    const file = requireFile(params.fileId);
    const project = requireActive(requireProject(store, file.project_id));
    // A portrait or a team role that names the file must stop naming it first.
    const agents = store.files.avatarUses(file.id);
    const roles = [store.team.current(project.id), store.team.draft(project.id)].flatMap(revision =>
      (revision?.body.roles ?? []).filter(role => role.knowledge.includes(file.id)).map(role => role.key));
    if (agents.length || roles.length) {
      throw new ApiError(409, 'FILE_IN_USE', 'Remove the file from the agent portraits and team roles that use it first', { agents, roles: [...new Set(roles)] });
    }
    const actor = actorOf(principal);
    const result = store.tx(() => {
      const { retire } = store.files.delete(file.id, actor.userId);
      const deletedAt = store.clock.now().toISOString();
      store.emit(project.id, 'file.deleted', { file_id: file.id, name: file.name, purpose: file.purpose, knowledge: retire ? 'retiring' : 'none' });
      store.record(actor, 'file.delete', { type: 'file', id: file.id }, {
        project_id: project.id, name: file.name, sha256: file.sha256, size: file.size, mime: file.mime, purpose: file.purpose, knowledge_retired: retire,
      }, idempotencyKey);
      return { file, deleted_at: deletedAt, knowledge: retire ? 'retiring' as const : 'none' as const };
    });
    if (result.knowledge === 'retiring') deps.knowledge.kick();
    else blobs.removeIfUnreferenced(file.sha256);
    return { body: result };
  });

  register('POST', '/projects/{projectId}/reindex', (_c, { params, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const actor = actorOf(principal);
    const queued = store.tx(() => {
      const files = store.files.list(project.id, 'reference').map(file => store.files.queueSync(file.id));
      for (const file of files) store.emit(project.id, 'file.updated', { file_id: file.id, knowledge: file.knowledge });
      const links = store.links.list(project.id).map(link => store.links.queueSync(link.id));
      for (const link of links) store.emit(project.id, 'link.updated', { link });
      store.record(actor, 'project.reindex', { type: 'project', id: project.id }, { files: files.length, links: links.length }, idempotencyKey);
      return { files: files.length, links: links.length };
    });
    deps.knowledge.kick();
    return { body: queued };
  });
}
