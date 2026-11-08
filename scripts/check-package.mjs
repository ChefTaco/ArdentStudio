// Packs the package, checks the published file list against an allowlist, installs the
// tarball into a disposable prefix and runs the installed CLI and contract export.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'ardent-studio-package-check-'));
const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  execFile(command, args, { cwd: root, timeout: 180_000, maxBuffer: 64 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).slice(-2000) || error.message}`));
    else resolvePromise(String(stdout));
  });
});
try {
  await run('npm', ['run', 'build']);
  const listing = JSON.parse(await run('npm', ['pack', '--dry-run', '--json', '--silent'], { maxBuffer: 8 * 1024 * 1024 }));
  const files = listing[0].files.map(file => file.path);
  const allowed = [/^dist\/[A-Za-z0-9/._-]+\.(?:js|d\.ts)$/, /^docs\/openapi-browser\.json$/, /^README\.md$/, /^LICENSE$/, /^NOTICE$/, /^package\.json$/];
  const unexpected = files.filter(path => !allowed.some(pattern => pattern.test(path)));
  if (unexpected.length) throw new Error(`Unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of ['dist/main.js', 'dist/index.js', 'dist/index.d.ts', 'dist/shared/browser.js', 'dist/shared/browser.d.ts', 'docs/openapi-browser.json', 'README.md', 'LICENSE', 'NOTICE'])
    if (!files.includes(required)) throw new Error(`Packed file missing: ${required}`);
  const filename = (await run('npm', ['pack', '--pack-destination', temporary, '--silent'])).trim().split('\n').at(-1);
  if (!filename || !/^hivemagnus-ardent-studio-[0-9][A-Za-z0-9.-]*\.tgz$/.test(filename)) throw new Error('Pack did not produce the expected tarball');
  const install = join(temporary, 'install');
  await run('npm', ['install', '--prefix', install, '--omit=dev', '--no-audit', '--no-fund', '--no-save', join(temporary, filename)], { timeout: 5 * 60_000 });
  const packageDir = join(install, 'node_modules/@hivemagnus/ardent-studio');
  if (!(await realpath(packageDir)).startsWith(`${install}/`)) throw new Error('Installed package resolves outside the disposable prefix');
  const installed = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (installed.name !== source.name || installed.version !== source.version) throw new Error('Installed package identity differs');
  await run(process.execPath, ['-e', "const Database=require(process.argv[1]);new Database(':memory:').close()", join(install, 'node_modules/better-sqlite3')]);
  const cli = join(packageDir, 'dist/main.js');
  if ((await run(process.execPath, [cli, 'version'])).trim() !== source.version) throw new Error('Installed CLI reports a different version');
  if (!(await run(process.execPath, [cli, 'env'])).includes('ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON')) throw new Error('Installed CLI does not list its environment');
  const unconfigured = await run(process.execPath, [cli, 'serve'], { env: { PATH: process.env.PATH } }).then(() => 'started', error => error.message);
  if (!unconfigured.includes('ARDENT_STUDIO_DATA: is required')) throw new Error('Installed CLI did not fail fast without configuration');
  const browser = await run(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(join(packageDir, 'dist/shared/browser.js')).href)}); console.log(m.ardentStudioBrowserRoutes.length)`]);
  if (!(Number(browser.trim()) > 0)) throw new Error('Installed browser contract has no routes');
  console.log(JSON.stringify({ package: filename, files: files.length, version: installed.version, nativeSqlite: 'ok', installedCli: 'ok', browserRoutes: Number(browser.trim()) }));
} finally { await rm(temporary, { recursive: true, force: true }); }
