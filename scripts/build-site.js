#!/usr/bin/env node
// scripts/build-site.js
//
// Vercel's build step. Copies the public site into dist/ and nothing else — no
// bundling, no transforms: what is served is byte-for-byte what is in the repo.
//
// Why a build step for a site that needs none: the repo root now also holds
// package.json, the tests and these scripts. With a package.json but no build,
// Vercel's static builder throws; and serving the repo root would publish every
// file in it, test code included. Copying only the site into dist/ makes both
// deterministic. It uses Node built-ins only, so vercel.json skips npm install.
//
//   node scripts/build-site.js            -> ./dist
//   node scripts/build-site.js <outDir>   -> <outDir>   (used by the tests)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Everything a visitor's browser may request. Nothing outside this list ships. */
export const SITE = ['index.html', 'staff.html', 'css', 'js', 'assets'];

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function countFiles(dir) {
  return readdirSync(dir).reduce((n, name) => {
    const p = join(dir, name);
    return n + (statSync(p).isDirectory() ? countFiles(p) : 1);
  }, 0);
}

export function buildSite(outDir = join(ROOT, 'dist')) {
  const out = resolve(outDir);

  // The output folder is wiped first, so never let it be the repo or above it.
  if (out === ROOT || (ROOT + sep).startsWith(out + sep)) {
    throw new Error(`refusing to build into ${out}: it would wipe the repository`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const entry of SITE) {
    const src = join(ROOT, entry);
    if (!existsSync(src)) throw new Error(`site file missing: ${entry}`);
    cpSync(src, join(out, entry), { recursive: true });
  }
  return { out, files: countFiles(out) };
}

// Run directly — but not when the tests import this file.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { out, files } = buildSite(process.argv[2]);
  console.log(`built ${files} files into ${out}`);
}
