// Content-addressed blob store under <data>/blobs/aa/bb/<sha256>. Writes go to a temp file,
// are fsynced and renamed into place, and the stored file is hashed again before it is
// recorded, so a recorded blob always matches its address.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, rename, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
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

export class BlobStore {
  readonly root: string;
  private readonly tmp: string;

  constructor(private readonly db: Db, dataDir: string, readonly maxBytes: number, private readonly clock: Clock) {
    this.root = join(dataDir, 'blobs');
    this.tmp = join(this.root, 'tmp');
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
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

  /** Stream bytes into the store. Throws BlobTooLargeError past the cap and BlobIntegrityError on a digest mismatch. */
  async put(source: AsyncIterable<Uint8Array> | Readable, mime: string, expectedSha256?: string): Promise<BlobRecord> {
    if (expectedSha256 !== undefined && !SHA.test(expectedSha256)) throw new BlobIntegrityError('Expected digest is not a SHA-256 hex string');
    const temp = join(this.tmp, `${randomBytes(12).toString('hex')}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(temp, 'wx', 0o600);
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
      const relative = this.relativePath(sha256);
      const target = join(this.root, relative);
      const existing = this.get(sha256);
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
      this.db.prepare('INSERT INTO blobs (sha256, size, mime, path, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING')
        .run(record.sha256, record.size, record.mime, record.path, record.created_at);
      return this.get(sha256) ?? record;
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** A read stream for a recorded blob, or undefined when it is not recorded. */
  open(sha256: string): { record: BlobRecord; stream: Readable } | undefined {
    const record = this.get(sha256);
    if (!record) return undefined;
    return { record, stream: createReadStream(join(this.root, record.path)) };
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
