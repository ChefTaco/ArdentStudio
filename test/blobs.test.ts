import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobIntegrityError, BlobStore, BlobTooLargeError } from '../src/blobs/store.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { systemClock } from '../src/db/json.js';

let dir: string;
let db: Db;
let store: BlobStore;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ardent-studio-blobs-'));
  db = openDatabase(join(dir, 'studio.sqlite'));
  store = new BlobStore(db, dir, 1024, systemClock);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

async function* chunks(...parts: string[]) { for (const part of parts) yield Buffer.from(part); }

describe('blob store', () => {
  it('stores content under its SHA-256 address and records it', async () => {
    const record = await store.put(chunks('hello ', 'world'), 'text/plain');
    expect(record.sha256).toBe(sha('hello world'));
    expect(record.path).toBe(join(record.sha256.slice(0, 2), record.sha256.slice(2, 4), record.sha256));
    expect(existsSync(join(dir, 'blobs', record.path))).toBe(true);
    expect(Buffer.from(await store.readBytes(record.sha256)).toString()).toBe('hello world');
    expect(await store.verify(record.sha256)).toBe(true);
    expect(readdirSync(join(dir, 'blobs', 'tmp'))).toEqual([]);
  });

  it('deduplicates identical content', async () => {
    const first = await store.putBytes(Buffer.from('same'), 'text/plain');
    const second = await store.putBytes(Buffer.from('same'), 'text/markdown');
    expect(second).toEqual(first);
    expect((db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(1);
  });

  it('refuses content over the cap and leaves no partial file', async () => {
    await expect(store.put(chunks('a'.repeat(600), 'b'.repeat(600)), 'text/plain')).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(readdirSync(join(dir, 'blobs', 'tmp'))).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(0);
  });

  it('refuses content that does not match an expected digest', async () => {
    await expect(store.putBytes(Buffer.from('content'), 'text/plain', sha('other'))).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(store.get(sha('content'))).toBeUndefined();
    expect(readdirSync(join(dir, 'blobs', 'tmp'))).toEqual([]);
  });

  it('detects a corrupted stored file and repairs it on the next write of the same content', async () => {
    const record = await store.putBytes(Buffer.from('original'), 'text/plain');
    writeFileSync(join(dir, 'blobs', record.path), 'tampered');
    expect(await store.verify(record.sha256)).toBe(false);
    await expect(store.readBytes(record.sha256)).rejects.toBeInstanceOf(BlobIntegrityError);
    await store.putBytes(Buffer.from('original'), 'text/plain');
    expect(await store.verify(record.sha256)).toBe(true);
  });

  it('removes temp files left by an interrupted write on recovery', () => {
    writeFileSync(join(dir, 'blobs', 'tmp', 'interrupted.part'), 'partial');
    expect(store.recoverPartialWrites()).toBe(1);
    expect(readdirSync(join(dir, 'blobs', 'tmp'))).toEqual([]);
  });

  it('only serves recorded, well-formed addresses', () => {
    expect(store.open('../../etc/passwd')).toBeUndefined();
    expect(store.open(sha('missing'))).toBeUndefined();
  });
});
