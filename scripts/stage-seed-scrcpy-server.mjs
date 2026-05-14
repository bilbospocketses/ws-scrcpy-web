#!/usr/bin/env node
// Stage the vendored scrcpy-server JAR into <repo>/seed/scrcpy-server/ so
// dev-mode DependencyManager.promoteSeedScrcpyServer can promote it into
// <dataRoot>/dependencies/scrcpy-server/scrcpy-server on first launch.
// Mirrors scripts/stage-publish.mjs:194-203, which does the same staging
// into publish/seed/scrcpy-server/ for MSI packaging.
//
// Runs from `prestart` (see package.json). Unconditional copy — matches
// install-side. Idempotent in the sense that two runs produce identical
// state; cost is one 90KB file copy per `npm start`, which is trivial.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SOURCE = join(REPO_ROOT, 'assets', 'scrcpy-server');
const SEED_DIR = join(REPO_ROOT, 'seed', 'scrcpy-server');
const DEST = join(SEED_DIR, 'scrcpy-server');

if (!existsSync(SOURCE)) {
    console.error(`[stage-seed-scrcpy-server] FATAL: ${SOURCE} missing`);
    process.exit(1);
}
const srcStat = statSync(SOURCE);
if (srcStat.size === 0) {
    console.error(`[stage-seed-scrcpy-server] FATAL: ${SOURCE} is zero-length`);
    process.exit(1);
}

mkdirSync(SEED_DIR, { recursive: true });
copyFileSync(SOURCE, DEST);
console.log(`[stage-seed-scrcpy-server] staged seed → ${SEED_DIR}`);
