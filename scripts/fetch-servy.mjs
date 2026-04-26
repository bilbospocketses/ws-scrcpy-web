#!/usr/bin/env node
// scripts/fetch-servy.mjs
//
// Download + verify + extract Servy v8.2 (servy-cli.exe) into publish/ for
// vpk packaging. Pinned version + hashes; any drift fails fast.
//
// Why dedicated: Servy ships as a 7z archive, which Node's built-in zlib /
// tar can't unpack. We delegate extraction to Windows' built-in
// C:\Windows\System32\tar.exe (bsdtar), which understands 7z. Git-bash's GNU
// tar does NOT — explicit System32 path matters.
//
// Run standalone:
//   node scripts/fetch-servy.mjs
// Wired into:
//   scripts/stage-publish.mjs (invoked before vpk pack)
//
// On non-Windows hosts: log + exit 0 (CI release builds run on Windows runners
// per the SP3 packaging plan).

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

// ---- Pinned constants (update together if Servy is bumped) ------------------
const SERVY_VERSION = '8.2';
const SERVY_ARCHIVE_URL =
    'https://github.com/aelassas/servy/releases/download/v8.2/servy-8.2-x64-portable.7z';
const SERVY_ARCHIVE_SHA256 =
    '70373DE2F9CCCE9AD49301CDF7106D7F0695305FC76A5B1F5C757A7F573E686B';
const SERVY_CLI_SHA256 =
    '185217312C2A690BDFCF5164B97CDF110025507BBB7F45AFD1425A6CC03C3BAA';
// Path inside the archive where servy-cli.exe lives.
const SERVY_INNER_PATH = path.join('servy-8.2-x64-portable', 'servy-cli.exe');
// Output location consumed by stage-publish.mjs.
const PUBLISH_DIR = path.join(REPO_ROOT, 'publish');
const SERVY_CACHE_DIR = path.join(REPO_ROOT, 'dependencies', 'servy', `v${SERVY_VERSION}`);
const SERVY_CACHE_ARCHIVE = path.join(SERVY_CACHE_DIR, 'servy-portable.7z');
const SERVY_CACHE_CLI = path.join(SERVY_CACHE_DIR, 'servy-cli.exe');
// Windows bsdtar — explicit because git-bash's `tar` is GNU tar and can't 7z.
const WINDOWS_TAR = 'C:\\Windows\\System32\\tar.exe';
const DOWNLOAD_TIMEOUT_MS = 60_000;

function log(msg) {
    console.log(`[fetch-servy] ${msg}`);
}

function err(msg) {
    console.error(`[fetch-servy] ${msg}`);
}

function sha256OfFile(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function verifyHash(filePath, expected, label) {
    const actual = sha256OfFile(filePath);
    if (actual !== expected.toUpperCase()) {
        throw new Error(
            `${label} sha256 mismatch:\n  expected ${expected.toUpperCase()}\n  got      ${actual}`,
        );
    }
    log(`${label} sha256 OK (${expected.slice(0, 12)}...)`);
}

async function downloadTo(url, destPath) {
    log(`downloading ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    log(`saved ${buf.length} bytes -> ${destPath}`);
}

function extractWithSystemTar(archivePath, outDir) {
    if (!fs.existsSync(WINDOWS_TAR)) {
        throw new Error(
            `expected bsdtar at ${WINDOWS_TAR} (Git-bash's GNU tar can't read 7z).`,
        );
    }
    fs.mkdirSync(outDir, { recursive: true });
    log(`extracting via ${WINDOWS_TAR}`);
    execFileSync(WINDOWS_TAR, ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' });
}

async function main() {
    if (process.platform !== 'win32') {
        log('Servy fetch is Windows-only; skipping (CI release builds run on Windows).');
        return;
    }

    fs.mkdirSync(SERVY_CACHE_DIR, { recursive: true });
    fs.mkdirSync(PUBLISH_DIR, { recursive: true });

    // Step 1: cached CLI hits — fast path.
    if (fs.existsSync(SERVY_CACHE_CLI)) {
        try {
            verifyHash(SERVY_CACHE_CLI, SERVY_CLI_SHA256, 'cached servy-cli.exe');
            const dest = path.join(PUBLISH_DIR, 'servy-cli.exe');
            fs.copyFileSync(SERVY_CACHE_CLI, dest);
            const stats = fs.statSync(dest);
            log(`Servy v${SERVY_VERSION} -> ${dest} (${stats.size} bytes) [cache hit]`);
            return;
        } catch (e) {
            err(`cached servy-cli.exe failed verification, refetching: ${e.message}`);
            try { fs.rmSync(SERVY_CACHE_CLI, { force: true }); } catch {}
        }
    }

    // Step 2: cached archive hits — re-extract.
    let needArchiveDownload = true;
    if (fs.existsSync(SERVY_CACHE_ARCHIVE)) {
        try {
            verifyHash(SERVY_CACHE_ARCHIVE, SERVY_ARCHIVE_SHA256, 'cached archive');
            needArchiveDownload = false;
        } catch (e) {
            err(`cached archive failed verification, redownloading: ${e.message}`);
            try { fs.rmSync(SERVY_CACHE_ARCHIVE, { force: true }); } catch {}
        }
    }

    if (needArchiveDownload) {
        await downloadTo(SERVY_ARCHIVE_URL, SERVY_CACHE_ARCHIVE);
        verifyHash(SERVY_CACHE_ARCHIVE, SERVY_ARCHIVE_SHA256, 'archive');
    }

    // Step 3: extract into a temp dir, then move servy-cli.exe into the cache.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-servy-'));
    try {
        extractWithSystemTar(SERVY_CACHE_ARCHIVE, tempDir);
        const innerPath = path.join(tempDir, SERVY_INNER_PATH);
        if (!fs.existsSync(innerPath)) {
            throw new Error(
                `expected ${SERVY_INNER_PATH} inside archive; not found after extract.`,
            );
        }
        verifyHash(innerPath, SERVY_CLI_SHA256, 'extracted servy-cli.exe');
        fs.copyFileSync(innerPath, SERVY_CACHE_CLI);
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }

    // Step 4: place into publish/.
    const dest = path.join(PUBLISH_DIR, 'servy-cli.exe');
    fs.copyFileSync(SERVY_CACHE_CLI, dest);
    const stats = fs.statSync(dest);
    log(`Servy v${SERVY_VERSION} -> ${dest} (${stats.size} bytes)`);
}

main().catch((e) => {
    err(`unexpected error: ${e.message}`);
    process.exit(1);
});
