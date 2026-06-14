#!/usr/bin/env node
// scripts/swap-appimage-runtime.mjs
//
// Replace the AppImage runtime stub at the front of a Velopack-produced
// .AppImage with the upstream static-fuse runtime from
// AppImage/type2-runtime. The static runtime statically links libfuse,
// so the AppImage runs on any Linux host without `libfuse2` /
// `libfuse3` installed.
//
// Velopack ships an older fuse2-linked runtime by default, which fails
// on fresh Ubuntu 24+ / Fedora 40+ / Arch installs that no longer
// install libfuse2 by default. Swapping in the static runtime makes
// the AppImage truly portable: chmod +x and run, on any glibc-based
// Linux from the last 18 years.
//
// Inputs:
//   <appimage-path>          — positional. The .AppImage to swap.
//
// Output:
//   The same .AppImage path, with its runtime portion replaced.
//
// Env var:
//   SKIP_APPIMAGE_RUNTIME_SWAP=1   — leave the original runtime in
//                                    place. Useful for offline / dev
//                                    builds that don't need portability.
//
// Run standalone (Linux or any OS — script is platform-agnostic):
//   node scripts/swap-appimage-runtime.mjs Releases/WsScrcpyWeb-linux.AppImage

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    createReadStream,
    createWriteStream,
    existsSync,
    statSync,
} from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// Pin to a known-good URL. The continuous channel is built from main and
// updates frequently. If reproducibility ever matters, swap to a tagged
// release URL.
const RUNTIME_URL =
    'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64';

// SHA-256 of the known-good runtime, verified before it is embedded into the
// shipped .AppImage — this binary is the first code that runs on launch. The
// continuous channel is rebuilt from main; when intentionally adopting a newer
// runtime, download it from a trusted source, verify it, and update this
// digest. The build refuses any runtime whose hash does not match.
const RUNTIME_SHA256 =
    'a2419dce47568395ae79c01ffa9a5a341dd339581352ff104d073527543177e5';

/**
 * Verify downloaded runtime bytes against an expected SHA-256, throwing on
 * mismatch. Returns the buffer unchanged on success.
 */
export function verifyRuntimeBytes(buf, expectedSha = RUNTIME_SHA256) {
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== expectedSha) {
        throw new Error(
            `runtime SHA-256 mismatch: expected ${expectedSha}, got ${actual}. ` +
                'Refusing to embed an unverified runtime. If the upstream runtime ' +
                'was intentionally updated, re-pin RUNTIME_SHA256 after verifying ' +
                'the new binary from a trusted source.',
        );
    }
    return buf;
}

const SKIP = process.env.SKIP_APPIMAGE_RUNTIME_SWAP === '1';

function log(msg) {
    console.log(`[swap-runtime] ${msg}`);
}

function err(msg) {
    console.error(`[swap-runtime] ${msg}`);
}

/**
 * Get the squashfs offset of an AppImage.
 *
 * Strategy 1: invoke the AppImage with `--appimage-offset`. The standard
 * AppImage type-2 runtime (which Velopack ships) intercepts this flag
 * before any FUSE work and prints the offset to stdout. Works without
 * libfuse on the host.
 *
 * Strategy 2 (fallback): scan the file for the squashfs magic bytes
 * (`hsqs` = 0x68 0x73 0x71 0x73) at 4-byte-aligned positions. The
 * squashfs filesystem always begins with that magic, and AppImage type
 * 2 places the squashfs immediately after the runtime.
 */
async function getSquashfsOffset(appimagePath) {
    // Strategy 1
    try {
        const out = execFileSync(appimagePath, ['--appimage-offset'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const offset = parseInt(out.trim(), 10);
        if (Number.isFinite(offset) && offset > 0) {
            return offset;
        }
    } catch {
        // fall through to strategy 2
    }

    // Strategy 2: scan for 'hsqs' magic. Squashfs starts at a 4-byte
    // aligned offset; AppImage type 2 runtimes are typically 200KB-1MB.
    // Search up to 4 MB to be safe.
    const fh = await open(appimagePath, 'r');
    try {
        const SCAN_LIMIT = 4 * 1024 * 1024;
        const fileSize = statSync(appimagePath).size;
        const scan = Math.min(SCAN_LIMIT, fileSize);
        const buf = Buffer.alloc(scan);
        await fh.read(buf, 0, scan, 0);
        // 'hsqs' = 0x68 0x73 0x71 0x73 (squashfs little-endian magic)
        for (let i = 0; i < scan - 4; i += 4) {
            if (
                buf[i] === 0x68 &&
                buf[i + 1] === 0x73 &&
                buf[i + 2] === 0x71 &&
                buf[i + 3] === 0x73
            ) {
                return i;
            }
        }
    } finally {
        await fh.close();
    }

    throw new Error(
        `Could not determine squashfs offset for ${appimagePath}. ` +
            'The AppImage may be malformed or the runtime may not support ' +
            '--appimage-offset.',
    );
}

/** Download a URL to a local path, verify ELF magic, return the path. */
async function downloadRuntime(url, destPath) {
    log(`fetching static runtime from ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
        throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    // Supply-chain integrity: verify the pinned SHA-256 before trusting the
    // runtime. The ELF magic check below is only a secondary sanity check —
    // any attacker-supplied binary would satisfy the magic bytes.
    verifyRuntimeBytes(buf);
    // Sanity check: verify ELF magic (0x7F 'E' 'L' 'F').
    if (
        buf.length < 4 ||
        buf[0] !== 0x7f ||
        buf[1] !== 0x45 ||
        buf[2] !== 0x4c ||
        buf[3] !== 0x46
    ) {
        throw new Error(
            `downloaded runtime is not an ELF binary (first bytes: ` +
                `${buf.subarray(0, 4).toString('hex')}). Refusing to swap.`,
        );
    }
    await writeFile(destPath, buf);
    log(`downloaded runtime: ${buf.length} bytes`);
    return destPath;
}

/**
 * Concatenate `runtimePath` + the tail of `appimagePath` from `offset`
 * onward, writing to `outputPath`. Streamed to avoid loading the full
 * .AppImage into memory.
 */
async function composeAppImage(runtimePath, appimagePath, offset, outputPath) {
    // 1. Write the new runtime first
    const out = createWriteStream(outputPath);
    await pipeline(createReadStream(runtimePath), out, { end: false });

    // 2. Append the original squashfs portion (skip the old runtime)
    await pipeline(createReadStream(appimagePath, { start: offset }), out);
}

async function main() {
    const appimagePath = process.argv[2];
    if (!appimagePath) {
        err('usage: swap-appimage-runtime.mjs <path-to-.AppImage>');
        process.exit(2);
    }
    if (!existsSync(appimagePath)) {
        throw new Error(`AppImage not found: ${appimagePath}`);
    }
    if (SKIP) {
        log('SKIP_APPIMAGE_RUNTIME_SWAP=1 — leaving original runtime in place.');
        return;
    }

    log(`input:  ${appimagePath}`);
    const originalSize = statSync(appimagePath).size;
    log(`original size: ${originalSize} bytes`);

    const offset = await getSquashfsOffset(appimagePath);
    log(`squashfs offset: ${offset} (current runtime is ${offset} bytes)`);

    const runtimeTmp = join(tmpdir(), `appimage-runtime-${process.pid}.bin`);
    const outputTmp = join(tmpdir(), `appimage-swapped-${process.pid}-${basename(appimagePath)}`);

    try {
        await downloadRuntime(RUNTIME_URL, runtimeTmp);
        const newRuntimeSize = statSync(runtimeTmp).size;
        log(`new runtime size: ${newRuntimeSize} bytes`);

        await composeAppImage(runtimeTmp, appimagePath, offset, outputTmp);

        const newSize = statSync(outputTmp).size;
        const expected = newRuntimeSize + (originalSize - offset);
        if (newSize !== expected) {
            throw new Error(
                `size mismatch after compose: got ${newSize}, expected ${expected}`,
            );
        }
        log(`swapped output size: ${newSize} bytes (delta ${newSize - originalSize >= 0 ? '+' : ''}${newSize - originalSize})`);

        // Replace original. rename within tmpdir-to-target may cross filesystems
        // on Linux runners; fall back to copy + delete if rename fails.
        try {
            await rename(outputTmp, appimagePath);
        } catch (e) {
            if (e.code === 'EXDEV') {
                // cross-device rename — copy + unlink
                await pipeline(
                    createReadStream(outputTmp),
                    createWriteStream(appimagePath),
                );
                await unlink(outputTmp);
            } else {
                throw e;
            }
        }
        chmodSync(appimagePath, 0o755);
        log(`runtime swap complete: ${appimagePath}`);
    } finally {
        for (const p of [runtimeTmp, outputTmp]) {
            try {
                await unlink(p);
            } catch {
                /* ok if already gone */
            }
        }
    }
}

// Only run when invoked directly, so the module can be imported in tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await main();
    } catch (e) {
        err(`unexpected error: ${e.message}`);
        process.exit(1);
    }
}
