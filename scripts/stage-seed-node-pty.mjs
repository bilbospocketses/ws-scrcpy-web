#!/usr/bin/env node
// scripts/stage-seed-node-pty.mjs
//
// Idempotently stage seed/node-pty-pkg/node_modules/{node-pty,node-addon-api}
// from node_modules/. Used by `npm start` (dev) via the `prestart` hook.
//
// Why this exists:
//   - NodePtyResolver loads node-pty by copying seed/node-pty-pkg/node_modules/
//     into <dataRoot>/dependencies/node-pty/<v-host>/ on first launch. The
//     copy is anchored on `seedPackageRoot()` returning a path that exists.
//   - In a packaged install, scripts/stage-publish.mjs MOVES node-pty out of
//     publish/node_modules/ into publish/seed/node-pty-pkg/node_modules/ as
//     part of the publish/ assembly, before vpk pack bundles dist/ + seed/.
//   - In dev mode (`npm run build && node dist/index.js`), nothing creates
//     seed/node-pty-pkg/. The resolver short-circuits with reason
//     "no-seed-package" and the shell button greys out client-side.
//
// This script bridges that gap: copy node_modules/node-pty (and node-addon-api)
// into the seed location so dev-mode mirrors the packaged-install layout.
// Runs idempotently — re-invocations no-op when the seed pty.node is present.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const SEED_DIR = join(REPO_ROOT, 'seed', 'node-pty-pkg', 'node_modules');
const SEED_NODE_PTY = join(SEED_DIR, 'node-pty');
const SEED_NODE_ADDON_API = join(SEED_DIR, 'node-addon-api');
const SEED_PTY_BINARY = join(SEED_NODE_PTY, 'build', 'Release', 'pty.node');

const SRC_NODE_PTY = join(REPO_ROOT, 'node_modules', 'node-pty');
const SRC_NODE_ADDON_API = join(REPO_ROOT, 'node_modules', 'node-addon-api');

if (existsSync(SEED_PTY_BINARY)) {
    console.log('[stage-seed-node-pty] seed already staged, skipping');
    process.exit(0);
}

if (!existsSync(SRC_NODE_PTY)) {
    console.error(`[stage-seed-node-pty] node_modules/node-pty not found at ${SRC_NODE_PTY}`);
    console.error('[stage-seed-node-pty] run `npm install` (or `node scripts/fetch-prebuilts.mjs`) first');
    process.exit(1);
}

mkdirSync(SEED_DIR, { recursive: true });
cpSync(SRC_NODE_PTY, SEED_NODE_PTY, { recursive: true });

if (existsSync(SRC_NODE_ADDON_API)) {
    cpSync(SRC_NODE_ADDON_API, SEED_NODE_ADDON_API, { recursive: true });
}

console.log(`[stage-seed-node-pty] staged seed → ${SEED_DIR}`);
