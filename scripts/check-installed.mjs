// Fails fast, with the fix, when node_modules does not match package-lock.json (for example after a
// pull that moved the lock without an `npm ci`). Without it the gates fail later with confusing errors
// such as `"./execution" is not exported`. Checks every package the lock installs, so a stale
// transitive dependency is caught too.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function staleInstalls(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || entry.link || entry.optional || entry.peer) continue;
    const manifest = join(root, path, 'package.json');
    if (!existsSync(manifest)) {
      problems.push(`${path.slice('node_modules/'.length)}: missing (lock ${entry.version})`);
      continue;
    }
    const installed = JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (installed !== entry.version) problems.push(`${path.slice('node_modules/'.length)}: installed ${installed}, lock ${entry.version}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (!existsSync(join(root, 'node_modules'))) {
    console.error('node_modules is missing: run `npm ci` first.');
    process.exit(1);
  }
  const problems = staleInstalls(root);
  if (problems.length) {
    console.error(`node_modules does not match package-lock.json (${problems.length} package${problems.length === 1 ? '' : 's'}); run \`npm ci\`:`);
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
    process.exit(1);
  }
}
