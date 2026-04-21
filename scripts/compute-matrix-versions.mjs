#!/usr/bin/env node
// Pre-check step for the node-pty-prebuilds workflow. Reads the current state
// file, fetches the latest Node LTS list + latest node-pty upstream release,
// and emits JSON to stdout that the workflow consumes via GITHUB_OUTPUT.
//
// Exit codes:
//   0 — no changes, workflow should no-op
//   1 — changes detected, workflow should run matrix
//   2 — error (network failure, parse error, etc.)
//
// Writes the updated state file on detection. The workflow commits it back
// to the repo after a successful build.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', '.github', 'state', 'node-pty-prebuilds-state.json');

async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ws-scrcpy-web-prebuilds-check' } });
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    return res.json();
}

function abiForNodeMajor(major) {
    // Node ABI numbers don't change within a major. This table covers current
    // targets; extend when Node announces a new ABI for a new major.
    // Source: https://github.com/nodejs/node/blob/main/doc/abi_version_registry.json
    const table = { 18: '108', 20: '115', 22: '127', 24: '137', 26: '139' };
    return table[major] ?? String(major);
}

async function main() {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));

    // Node LTS list
    const releases = await fetchJson('https://nodejs.org/dist/index.json');
    const ltsReleases = releases.filter((r) => r.lts && r.lts !== false);
    // Deduplicate by major, keep newest of each
    const byMajor = new Map();
    for (const r of ltsReleases) {
        const major = parseInt(r.version.replace(/^v/, '').split('.')[0], 10);
        if (!byMajor.has(major)) byMajor.set(major, r);
    }
    const sortedMajors = Array.from(byMajor.keys()).sort((a, b) => b - a);
    const [currentMajor, priorMajor] = sortedMajors;
    const currentLts = byMajor.get(currentMajor);
    const priorLts = byMajor.get(priorMajor);

    // node-pty upstream latest
    const nodePtyRelease = await fetchJson('https://api.github.com/repos/microsoft/node-pty/releases/latest');
    const nodePtyVersion = nodePtyRelease.tag_name.replace(/^v/, '');

    const fresh = {
        nodePtyVersion,
        nodeCurrentLts: { version: currentLts.version, abi: abiForNodeMajor(currentMajor) },
        nodePriorLts: { version: priorLts.version, abi: abiForNodeMajor(priorMajor) },
        lastBuiltAt: new Date().toISOString(),
    };

    const changed =
        state.nodePtyVersion !== fresh.nodePtyVersion ||
        state.nodeCurrentLts?.version !== fresh.nodeCurrentLts.version ||
        state.nodePriorLts?.version !== fresh.nodePriorLts.version;

    console.log(JSON.stringify({
        changed,
        fresh,
        previous: state,
    }, null, 2));

    if (changed) {
        await writeFile(STATE_PATH, JSON.stringify(fresh, null, 2) + '\n');
        process.exit(1); // non-zero means "please run the matrix"
    }
    process.exit(0);
}

main().catch((err) => {
    console.error('compute-matrix-versions failed:', err);
    process.exit(2);
});
