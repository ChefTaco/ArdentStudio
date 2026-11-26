import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupError, backupDataDir } from '../src/backup.js';
import { openDatabase } from '../src/db/database.js';
import { createProject, createTestContext, type TestContext } from './helpers.js';

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
