#!/usr/bin/env node
// scripts/fetch-tini.mjs
//
// Downloads the pinned static tini for THIS process's architecture and verifies
// its sha256 before placing it. Mirrors fetch-node.mjs deliberately: same pin
// shape, same verify-then-place order, same failure mode.
//
// Runs inside the Docker build stage, where process.arch is the TARGET arch
// (buildx executes each platform leg in that platform's rootfs), so no
// TARGETARCH plumbing is required and no case statement can drift from the
// pin table below.
//
// Why not `ADD --checksum=`: the checksum differs per architecture and a
// Dockerfile cannot resolve an ARG name dynamically, so the alternatives are a
// shell case statement (a second place for the pins to live) or this. Why not
// curl: node:24-bookworm-slim's inclusion of curl is not something this build
// should depend on, and Node's own fetch is guaranteed present.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TINI_VERSION = 'v0.19.0';

// From https://github.com/krallin/tini/releases/download/v0.19.0/<asset>.sha256sum
// read 2026-09-01, re-verified 2026-09-03. Release published 2020-04-19; tini
// has not moved since.
const PINS = {
    x64: {
        asset: 'tini-static-amd64',
        sha256: 'c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee',
    },
    arm64: {
        asset: 'tini-static-arm64',
        sha256: 'eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9',
    },
};

const dest = process.argv[2];
if (!dest) {
    console.error('[fetch-tini] usage: node scripts/fetch-tini.mjs <dest-path>');
    process.exit(1);
}

const pin = PINS[process.arch];
if (!pin) {
    // Loud, not a fallback. An unpinned arch must fail the BUILD, not ship an
    // unverified PID 1.
    console.error(`[fetch-tini] no pin for arch "${process.arch}" — add one to PINS`);
    process.exit(1);
}

const url = `https://github.com/krallin/tini/releases/download/${TINI_VERSION}/${pin.asset}`;
console.log(`[fetch-tini] downloading ${url}`);
const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
if (!res.ok) {
    console.error(`[fetch-tini] HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());

const actual = createHash('sha256').update(buf).digest('hex');
if (actual !== pin.sha256) {
    console.error(`[fetch-tini] sha256 mismatch\n  expected ${pin.sha256}\n  got      ${actual}`);
    process.exit(1);
}
console.log(`[fetch-tini] sha256 OK (${pin.sha256.slice(0, 12)}...) ${buf.length} bytes`);

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, buf);
chmodSync(dest, 0o755);
console.log(`[fetch-tini] placed ${pin.asset} -> ${dest}`);
