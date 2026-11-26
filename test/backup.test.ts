import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupError, backupDataDir } from '../src/backup.js';
import { openDatabase } from '../src/db/database.js';
import { createProject, createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
const dirs: string[] = [];
afterEach(async () => { await ctx?.close(); ctx = undefined; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'ardent-studio-backup-')); dirs.push(dir); return dir; };

describe('ardent-studio backup', () => {
  it('copies a live database consistently and every blob it records, verified', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const upload = await ctx.call('POST', `/projects/${project.id}/files?name=notes.md`, { raw: '# Notes', headers: { 'content-type': 'text/markdown' } });
    expect(upload.status).toBe(201);
    const target = join(scratch(), 'backup');

    const result = await backupDataDir(ctx.dir, target);
    expect(result).toMatchObject({ blobs: 1, bytes: 7 });
    const copy = openDatabase(join(target, 'studio.sqlite'));
    try {
      expect(copy.prepare('SELECT name FROM projects').all()).toEqual([{ name: project.name }]);
      const blob = copy.prepare('SELECT path FROM blobs').get() as { path: string };
      expect(readFileSync(join(target, 'blobs', blob.path), 'utf8')).toBe('# Notes');
    } finally { copy.close(); }
    expect(JSON.parse(readFileSync(join(target, 'backup.json'), 'utf8'))).toMatchObject({ product: 'ardent-studio', blobs: 1, bytes: 7 });
  });

  it('copies the database again when a file is deleted and its bytes removed during the backup', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const kept = await json(await ctx.call('POST', `/projects/${project.id}/files?name=keep.md&purpose=attachment`, { raw: '# Keep', headers: { 'content-type': 'text/markdown' } }));
    const doomed = await json(await ctx.call('POST', `/projects/${project.id}/files?name=drop.md&purpose=attachment`, { raw: '# Drop me', headers: { 'content-type': 'text/markdown' } }));
    const target = join(scratch(), 'backup');
    const snapshots: number[] = [];

    const result = await backupDataDir(ctx.dir, target, {
      onSnapshot: async attempt => {
        snapshots.push(attempt);
        if (attempt !== 1) return;
        expect((await ctx!.call('DELETE', `/files/${doomed.id}`)).status).toBe(200);
        expect(ctx!.blobs.sweepUnreferenced(0)).toBe(1);
      },
    });
    expect(snapshots).toEqual([1, 2]);
    expect(result).toMatchObject({ blobs: 1, bytes: 6 });
    const copy = openDatabase(join(target, 'studio.sqlite'));
    try {
      expect(copy.prepare('SELECT id FROM files').all()).toEqual([{ id: kept.id }]);
      expect(copy.prepare('SELECT sha256 FROM blobs').all()).toEqual([{ sha256: kept.sha256 }]);
    } finally { copy.close(); }
    expect(existsSync(join(target, 'blobs', ctx.blobs.relativePath(kept.sha256)))).toBe(true);
    expect(existsSync(join(target, 'blobs', ctx.blobs.relativePath(doomed.sha256)))).toBe(false);
  });

  it('gives up when blobs keep being removed', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const add = async (name: string) => json(await ctx!.call('POST', `/projects/${project.id}/files?name=${name}.md&purpose=attachment`, { raw: `# ${name}`, headers: { 'content-type': 'text/markdown' } }));
    let latest = await add('first');
    // Each copy records a file that is deleted (and its bytes swept) before its blob is copied.
    await expect(backupDataDir(ctx.dir, join(scratch(), 'b'), {
      maxSnapshots: 2,
      onSnapshot: async attempt => {
        expect((await ctx!.call('DELETE', `/files/${latest.id}`)).status).toBe(200);
        expect(ctx!.blobs.sweepUnreferenced(0)).toBe(1);
        latest = await add(`next-${attempt}`);
      },
    })).rejects.toThrow(/kept being removed/);
  });

  it('refuses a non-empty target, a target inside the data directory and a missing or corrupted blob', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await ctx.call('POST', `/projects/${project.id}/files?name=notes.md`, { raw: '# Notes', headers: { 'content-type': 'text/markdown' } });
    const used = scratch();
    writeFileSync(join(used, 'other'), 'x');
    await expect(backupDataDir(ctx.dir, used)).rejects.toThrow(/not empty/);
    await expect(backupDataDir(ctx.dir, join(ctx.dir, 'backup'))).rejects.toThrow(BackupError);
    await expect(backupDataDir('relative/data', join(scratch(), 'b'))).rejects.toThrow(/absolute/);
    await expect(backupDataDir(scratch(), join(scratch(), 'b'))).rejects.toThrow(/No studio.sqlite/);

    const path = (ctx.store.db.prepare('SELECT path FROM blobs').get() as { path: string }).path;
    writeFileSync(join(ctx.dir, 'blobs', path), 'tampered');
    await expect(backupDataDir(ctx.dir, join(scratch(), 'b'))).rejects.toThrow(/does not match its digest/);
    rmSync(join(ctx.dir, 'blobs', path));
    await expect(backupDataDir(ctx.dir, join(scratch(), 'c'))).rejects.toThrow(/missing/);
  });
});
