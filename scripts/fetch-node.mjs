#!/usr/bin/env node
// scripts/fetch-node.mjs
//
// Download + verify + extract a Node.js binary into seed/ for vpk
// packaging. Pinned version + hashes; any drift fails fast.
//
// Why this exists: the Rust launcher is a small supervisor that spawns
// `node dist/index.js`. The Node backend is what handles ADB / scrcpy /
// node-pty downloads via DependencyManager.autoInstallMissing(). But
// the launcher needs an actual Node binary to spawn before any of that
// can happen — chicken-and-egg.
//
// The seed/ directory ships ONE bootstrap Node binary inside the
// installer payload, so first-run works without any network. After
// first-run, DependencyManager keeps Node up to date in dependencies/
// (a sibling of the Velopack-managed current/).
//
// Run standalone:
//   node scripts/fetch-node.mjs
// Wired into:
//   .github/workflows/release.yml (Windows + Linux jobs)
//   scripts/stage-publish.mjs (which then copies seed/ into publish/)
//
// Cache: dependencies/node-bootstrap/<version>/ holds the verified
// archive AND the extracted node binary across runs, mirroring the
// fetch-servy.mjs pattern.

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

// ---- Pinned constants (update together if Node is bumped) ------------------
const NODE_VERSION = 'v24.15.0';
const NODE_DIST_BASE = `https://nodejs.org/dist/${NODE_VERSION}`;

// Windows: ZIP archive, contains node.exe at <root>/node.exe
const WIN_ARCHIVE_NAME = `node-${NODE_VERSION}-win-x64.zip`;
const WIN_ARCHIVE_SHA256 =
    'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62';
const WIN_INNER_NODE_REL = path.join(`node-${NODE_VERSION}-win-x64`, 'node.exe');

// Linux: tar.xz archive, contains node at <root>/bin/node
const LINUX_ARCHIVE_NAME = `node-${NODE_VERSION}-linux-x64.tar.xz`;
const LINUX_ARCHIVE_SHA256 =
    '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6';
const LINUX_INNER_NODE_REL = path.join(`node-${NODE_VERSION}-linux-x64`, 'bin', 'node');

const SEED_DIR = path.join(REPO_ROOT, 'seed', 'node');
const CACHE_DIR = path.join(REPO_ROOT, 'dependencies', 'node-bootstrap', NODE_VERSION);
// Windows bsdtar handles both .zip and .tar.xz; git-bash GNU tar can't read .zip.
const WINDOWS_TAR = 'C:\\Windows\\System32\\tar.exe';
const DOWNLOAD_TIMEOUT_MS = 120_000;

function log(msg) {
    console.log(`[fetch-node] ${msg}`);
}

function err(msg) {
    console.error(`[fetch-node] ${msg}`);
}

function sha256OfFile(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifyHash(filePath, expected, label) {
    const actual = sha256OfFile(filePath);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(
            `${label} sha256 mismatch:\n  expected ${expected}\n  got      ${actual}`,
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

/** Extract via the right tar for the host platform. */
function extract(archivePath, outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    if (process.platform === 'win32') {
        if (!fs.existsSync(WINDOWS_TAR)) {
            throw new Error(
                `expected bsdtar at ${WINDOWS_TAR} (git-bash GNU tar can't read .zip).`,
            );
        }
        log(`extracting via ${WINDOWS_TAR}`);
        execFileSync(WINDOWS_TAR, ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' });
    } else {
        log(`extracting via tar`);
        execFileSync('tar', ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' });
    }
}

function platformConfig() {
    if (process.platform === 'win32') {
        return {
            archiveName: WIN_ARCHIVE_NAME,
            archiveSha256: WIN_ARCHIVE_SHA256,
            innerRel: WIN_INNER_NODE_REL,
            seedNodeName: 'node.exe',
        };
    }
    if (process.platform === 'linux') {
        return {
            archiveName: LINUX_ARCHIVE_NAME,
            archiveSha256: LINUX_ARCHIVE_SHA256,
            innerRel: LINUX_INNER_NODE_REL,
            seedNodeName: 'node',
        };
    }
    throw new Error(
        `Unsupported platform: ${process.platform}. ` +
            'Node bootstrap fetch is implemented for win32 and linux only ' +
            '(those are the platforms we ship installers for).',
    );
}

async function main() {
    const cfg = platformConfig();
    const archivePath = path.join(CACHE_DIR, cfg.archiveName);
    const cachedNodePath = path.join(CACHE_DIR, cfg.seedNodeName);
    const seedNodePath = path.join(SEED_DIR, cfg.seedNodeName);

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.mkdirSync(SEED_DIR, { recursive: true });

    // Step 1: cached node binary hit — fast path.
    // (We don't pin a sha256 for the binary itself; trust the archive
    // verification + the extraction to produce a consistent file.)
    if (fs.existsSync(cachedNodePath)) {
        fs.copyFileSync(cachedNodePath, seedNodePath);
        if (process.platform !== 'win32') fs.chmodSync(seedNodePath, 0o755);
        const stats = fs.statSync(seedNodePath);
        log(`Node ${NODE_VERSION} -> ${seedNodePath} (${stats.size} bytes) [cache hit]`);
        return;
    }

    // Step 2: cached archive hit — re-extract.
    let needArchiveDownload = true;
    if (fs.existsSync(archivePath)) {
        try {
            verifyHash(archivePath, cfg.archiveSha256, 'cached archive');
            needArchiveDownload = false;
        } catch (e) {
            err(`cached archive failed verification, redownloading: ${e.message}`);
            try { fs.rmSync(archivePath, { force: true }); } catch {}
        }
    }

    if (needArchiveDownload) {
        await downloadTo(`${NODE_DIST_BASE}/${cfg.archiveName}`, archivePath);
        verifyHash(archivePath, cfg.archiveSha256, 'archive');
    }

    // Step 3: extract into a temp dir, copy node binary into the cache.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-node-'));
    try {
        extract(archivePath, tempDir);
        const innerPath = path.join(tempDir, cfg.innerRel);
        if (!fs.existsSync(innerPath)) {
            throw new Error(
                `expected ${cfg.innerRel} inside archive; not found after extract.`,
            );
        }
        fs.copyFileSync(innerPath, cachedNodePath);
        if (process.platform !== 'win32') fs.chmodSync(cachedNodePath, 0o755);
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }

    // Step 4: place into seed/.
    fs.copyFileSync(cachedNodePath, seedNodePath);
    if (process.platform !== 'win32') fs.chmodSync(seedNodePath, 0o755);
    const stats = fs.statSync(seedNodePath);
    log(`Node ${NODE_VERSION} -> ${seedNodePath} (${stats.size} bytes)`);
}

main().catch((e) => {
    err(`unexpected error: ${e.message}`);
    process.exit(1);
});
