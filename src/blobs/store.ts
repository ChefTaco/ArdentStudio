// Content-addressed blob store under <data>/blobs/aa/bb/<sha256>. Writes go to a temp file,
// are fsynced and renamed into place, and the stored file is hashed again before it is
// recorded, so a recorded blob always matches its address.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { open, rename, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Db } from '../db/database.js';
import type { Clock } from '../db/json.js';

export class BlobTooLargeError extends Error {
  override name = 'BlobTooLargeError';
  constructor(readonly limit: number) { super(`Blob exceeds the ${limit}-byte limit`); }
}
export class BlobIntegrityError extends Error {
  override name = 'BlobIntegrityError';
}

export interface BlobRecord {
  sha256: string;
  size: number;
  mime: string;
  path: string;
  created_at: string;
}

const SHA = /^[a-f0-9]{64}$/;

/** Stored bytes written or reused this recently are never swept: a write may still be recording its reference. */
export const BLOB_GC_GRACE_MS = 10 * 60_000;

/**
 * Every table that points at a blob, as one condition on `b.sha256`. A blob none of them names is
 * unreferenced. Update this when a table starts referencing blobs.
 */
const UNREFERENCED = `NOT EXISTS (SELECT 1 FROM files f WHERE f.sha256 = b.sha256)
  AND NOT EXISTS (SELECT 1 FROM deliverable_revisions r WHERE r.blob_sha256 = b.sha256)
  AND NOT EXISTS (SELECT 1 FROM deliverable_renditions d WHERE d.sha256 = b.sha256)
  AND NOT EXISTS (SELECT 1 FROM exports e WHERE e.blob_sha256 = b.sha256)
  AND NOT EXISTS (SELECT 1 FROM docx_documents x WHERE x.blob_sha256 = b.sha256 OR x.document_sha256 = b.sha256)
  AND NOT EXISTS (SELECT 1 FROM artifact_imports a WHERE a.sha256 = b.sha256)`;

export class BlobStore {
  readonly root: string;
  private readonly tmp: string;
  /** Ranged artifact imports in progress, one file per import id. They survive a restart so a transfer can resume. */
  readonly partialDir: string;

  constructor(private readonly db: Db, dataDir: string, readonly maxBytes: number, private readonly clock: Clock) {
    this.root = join(dataDir, 'blobs');
    this.tmp = join(this.root, 'tmp');
    this.partialDir = join(this.root, '.partial');
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
    mkdirSync(this.partialDir, { recursive: true, mode: 0o700 });
  }

  /** The partial file of a ranged import. Never recorded: it becomes a blob only through adopt(). */
  partialPath(importId: number): string {
    if (!Number.isSafeInteger(importId) || importId < 1) throw new Error('Invalid import id');
    return join(this.partialDir, String(importId));
  }

  /** Import ids that have a partial file. */
  partialImports(): number[] {
    return readdirSync(this.partialDir).filter(name => /^[1-9]\d{0,15}$/.test(name)).map(Number);
  }

  async removePartial(importId: number): Promise<void> {
    await rm(this.partialPath(importId), { force: true });
  }

  /**
   * Record a complete partial file whose digest the caller verified: it is fsynced, renamed into the
   * store and hashed again before it is recorded. Throws BlobIntegrityError when it is not those bytes.
   */
  async adoptPartial(importId: number, mime: string, sha256: string, size: number): Promise<BlobRecord> {
    if (!SHA.test(sha256)) throw new BlobIntegrityError('Expected digest is not a SHA-256 hex string');
    if (size > this.maxBytes) throw new BlobTooLargeError(this.maxBytes);
    const source = this.partialPath(importId);
    const handle = await open(source, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    try {
      return await this.commit(source, sha256, size, mime);
    } catch (error) {
      await rm(source, { force: true });
      throw error;
    }
  }

  /** Remove temp files a crash left behind. Recorded blobs are never touched. */
  recoverPartialWrites(): number {
    let removed = 0;
    for (const name of readdirSync(this.tmp)) {
      rmSync(join(this.tmp, name), { force: true });
      removed++;
    }
    return removed;
  }

  relativePath(sha256: string): string {
    return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  get(sha256: string): BlobRecord | undefined {
    if (!SHA.test(sha256)) return undefined;
    return this.db.prepare('SELECT * FROM blobs WHERE sha256 = ?').get(sha256) as BlobRecord | undefined;
  }

  async putBytes(bytes: Uint8Array, mime: string, expectedSha256?: string): Promise<BlobRecord> {
    return this.put((async function* () { yield bytes; })(), mime, expectedSha256);
  }

  /**
   * Stream bytes into the store. Throws BlobTooLargeError past the cap and BlobIntegrityError on a digest mismatch.
   *
   * Pass a web `ReadableStream` as it is, not wrapped in `Readable.fromWeb()`: a wrapper made before
   * this method starts reading has no error listener while the temp file opens, so an abort or an
   * upstream error in that window is an uncaught exception that ends the process. A source that is
   * never read (an early refusal) is released.
   */
  async put(source: AsyncIterable<Uint8Array> | Readable | ReadableStream<Uint8Array>, mime: string, expectedSha256?: string): Promise<BlobRecord> {
    let handle: Awaited<ReturnType<typeof open>>;
    const temp = join(this.tmp, `${randomBytes(12).toString('hex')}.part`);
    try {
      if (expectedSha256 !== undefined && !SHA.test(expectedSha256)) throw new BlobIntegrityError('Expected digest is not a SHA-256 hex string');
      handle = await open(temp, 'wx', 0o600);
    } catch (error) {
      await release(source);
      throw error;
    }
    const hash = createHash('sha256');
    let size = 0;
    try {
      try {
        for await (const chunk of source as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > this.maxBytes) throw new BlobTooLargeError(this.maxBytes);
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sha256 = hash.digest('hex');
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw new BlobIntegrityError('Content does not match the expected SHA-256');
      return await this.commit(temp, sha256, size, mime);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** Rename a written, fsynced file into its address, hash it again and record it. */
  private async commit(temp: string, sha256: string, size: number, mime: string): Promise<BlobRecord> {
    const relative = this.relativePath(sha256);
    const target = join(this.root, relative);
    const existing = this.get(sha256);
    // Mark reused bytes before anything is awaited, so a sweep running meanwhile leaves them alone.
    if (existing) this.db.prepare('UPDATE blobs SET used_at = ? WHERE sha256 = ?').run(this.clock.now().toISOString(), sha256);
    if (existing && await this.fileMatches(target, sha256, size)) {
      await rm(temp, { force: true });
      return existing;
    }
    await mkdir(join(this.root, sha256.slice(0, 2), sha256.slice(2, 4)), { recursive: true, mode: 0o700 });
    await rename(temp, target);
    await this.syncDirectory(join(this.root, sha256.slice(0, 2), sha256.slice(2, 4)));
    if (!await this.fileMatches(target, sha256, size)) {
      await rm(target, { force: true });
      throw new BlobIntegrityError('Stored blob failed verification');
    }
    const record: BlobRecord = { sha256, size, mime, path: relative, created_at: this.clock.now().toISOString() };
    this.db.prepare('INSERT INTO blobs (sha256, size, mime, path, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO UPDATE SET used_at = excluded.used_at')
      .run(record.sha256, record.size, record.mime, record.path, record.created_at, record.created_at);
    return this.get(sha256) ?? record;
  }

  /** A read stream for a recorded blob (or one inclusive byte range of it), or undefined when it is not recorded. */
  open(sha256: string, range?: { start: number; end: number }): { record: BlobRecord; stream: Readable } | undefined {
    const record = this.get(sha256);
    if (!record) return undefined;
    return { record, stream: createReadStream(join(this.root, record.path), range ? { start: range.start, end: range.end } : {}) };
  }

  async readBytes(sha256: string): Promise<Uint8Array> {
    const opened = this.open(sha256);
    if (!opened) throw new BlobIntegrityError('Blob is not recorded');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new BlobIntegrityError('Stored blob does not match its address');
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** A small recorded blob as UTF-8 text, verified against its address. */
  readTextSync(sha256: string): string {
    const record = this.get(sha256);
    if (!record) throw new BlobIntegrityError('Blob is not recorded');
    const bytes = readFileSync(join(this.root, record.path));
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new BlobIntegrityError('Stored blob does not match its address');
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  /**
   * Remove recorded blobs that nothing references and that were not written or reused within `graceMs`,
   * at most `limit` of them. Each row is deleted and its file unlinked synchronously, so no write can
   * interleave: a write that reuses the bytes either marks them first (and they stay) or finds them gone
   * (and writes them again).
   */
  sweepUnreferenced(graceMs = BLOB_GC_GRACE_MS, limit = 500): number {
    const cutoff = new Date(this.clock.now().getTime() - graceMs).toISOString();
    const rows = this.db.prepare(`SELECT b.sha256 FROM blobs b WHERE COALESCE(b.used_at, b.created_at) < ? AND ${UNREFERENCED} LIMIT ?`)
      .all(cutoff, limit) as Array<{ sha256: string }>;
    let removed = 0;
    for (const row of rows) if (this.removeIfUnreferenced(row.sha256, graceMs)) removed++;
    return removed;
  }

  /** Remove one blob when nothing references it and it was not written or reused within `graceMs`. */
  removeIfUnreferenced(sha256: string, graceMs = BLOB_GC_GRACE_MS): boolean {
    if (!SHA.test(sha256)) return false;
    const cutoff = new Date(this.clock.now().getTime() - graceMs).toISOString();
    const row = this.db.prepare(`DELETE FROM blobs AS b WHERE b.sha256 = ? AND COALESCE(b.used_at, b.created_at) < ? AND ${UNREFERENCED} RETURNING path`)
      .get(sha256, cutoff) as { path: string } | undefined;
    if (!row) return false;
    rmSync(join(this.root, row.path), { force: true });
    return true;
  }

  /** Re-hash a recorded blob. */
  async verify(sha256: string): Promise<boolean> {
    const record = this.get(sha256);
    return record ? this.fileMatches(join(this.root, record.path), sha256, record.size) : false;
  }

  private async fileMatches(path: string, sha256: string, size: number): Promise<boolean> {
    try {
      if ((await stat(path)).size !== size) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      return hash.digest('hex') === sha256;
    } catch {
      return false;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

/** End a source that will not be read, so its producer stops and its error, if any, is consumed. */
async function release(source: AsyncIterable<Uint8Array> | Readable | ReadableStream<Uint8Array>): Promise<void> {
  try {
    if (source instanceof Readable) source.destroy();
    else if (typeof (source as ReadableStream<Uint8Array>).cancel === 'function') await (source as ReadableStream<Uint8Array>).cancel();
    else await (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]().return?.();
  } catch { /* the source was already errored: nothing to release */ }
}
