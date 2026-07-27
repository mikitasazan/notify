#!/usr/bin/env node
// Who consumes this package, and at what version? Reads consumers.json,
// compares each consumer's resolved/vendored version with ours, exits 1 on
// drift. CANONICAL COPY lives in the package-ops skill; keep repo copies
// byte-identical.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const consumers = JSON.parse(readFileSync(join(root, 'consumers.json'), 'utf8'));

let drift = false;
for (const c of consumers) {
  const repo = c.repo.replace(/^~/, homedir());
  const manifest = JSON.parse(readFileSync(join(repo, c.manifest ?? 'package.json'), 'utf8'));
  const spec =
    { ...manifest.dependencies, ...manifest.devDependencies }[own.name] ?? '(absent)';
  let got = spec;
  let bad = false;

  if (c.via === 'tarball') {
    got = (spec.match(/(\d+\.\d+\.\d+)\.tgz$/) ?? [])[1] ?? spec;
    bad = got !== own.version;
  } else if (c.via === 'npm') {
    const npmLock = join(repo, 'package-lock.json');
    const pnpmLock = join(repo, 'pnpm-lock.yaml');
    if (existsSync(npmLock)) {
      const lock = JSON.parse(readFileSync(npmLock, 'utf8'));
      got = lock.packages?.[`node_modules/${own.name}`]?.version ?? spec;
      bad = got !== own.version;
    } else if (existsSync(pnpmLock)) {
      // ponytail: regex over the yaml instead of a parser — enough to read one version
      const m = readFileSync(pnpmLock, 'utf8').match(
        new RegExp(`${own.name.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+)`)
      );
      got = m?.[1] ?? spec;
      bad = m ? got !== own.version : false;
    }
  }
  // via 'action' (floating major tag): consumers always get the tag's tip — nothing to compare.

  drift ||= bad;
  console.log(`${bad ? '⚠' : ' '} ${c.repo} [${c.via}] ${got}${bad ? ` ← latest is ${own.version}` : ''}`);
}
console.log(`\n${own.name}@${own.version}`);
process.exit(drift ? 1 : 0);
