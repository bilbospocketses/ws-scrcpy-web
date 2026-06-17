#!/usr/bin/env node
// Standalone CLI that downloads our prebuilt node-pty binary for the current
// host and places it into node_modules/node-pty/build/Release/. Pure JS, no
// TypeScript compile step needed.
//
// Invoked by:
//   - `npm run fetch-prebuilts` (explicit, air-gapped setups)
//   - vitest.globalSetup.ts (before test runs)
//
// NodePtyResolver (the server-boot path) does NOT use this script — it has its
// own download routine (downloadAndOverlayPtyNode) with a non-overridable URL
// base and a seed-derived version. This script intentionally duplicates the
// download logic rather than importing it, so it works on a fresh clone before
// `npm run build`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_TIMEOUT_MS = 30_000;

export const DEFAULT_RELEASE_URL_BASE =
    'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';

/**
 * Resolve the release URL base for prebuilt downloads. WSSCRCPY_RELEASE_URL_BASE
 * redirects the source of a NATIVE-BINARY download, so it is honored ONLY when
 * the operator also sets the explicit opt-in WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE=1
 * (air-gapped mirror setups). Without the opt-in any value is ignored and the
 * canonical GitHub releases URL is used — a stray/injected env var cannot
 * silently point the download at an attacker-controlled host.
 */
export function resolveReleaseUrlBase(env = process.env) {
    const override = env.WSSCRCPY_RELEASE_URL_BASE;
    const optedIn = env.WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE === '1';
    if (override && optedIn) {
        return { base: override, overridden: true, ignoredOverride: false };
    }
    return {
        base: DEFAULT_RELEASE_URL_BASE,
        overridden: false,
        ignoredOverride: Boolean(override),
    };
}

/**
 * The node-pty version to fetch a prebuilt for, pinned to the lockfile-controlled
 * copy installed in node_modules — NOT taken from the network manifest. The
 * manifest's upstreamVersion tracks the LATEST upstream node-pty (a weekly cron)
 * and can legitimately run ahead of this repo's pinned dependency, so trusting it
 * could fetch a binary for a different node-pty than the JS we ship. Anchoring to
 * the installed package.json keeps the download tied to a repo-controlled value.
 */
export function readInstalledNodePtyVersion(repoRoot) {
    const pkgJsonPath = path.join(repoRoot, 'node_modules', 'node-pty', 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
        throw new Error(`node-pty is not installed at ${pkgJsonPath}; run \`npm install\` first`);
    }
    const json = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (!json.version) {
        throw new Error('installed node-pty package.json has no "version" field');
    }
    return json.version;
}

function detectLibc() {
    if (process.platform !== 'linux') return 'glibc';
    try {
        const report = process.report?.getReport?.();
        if (report?.header?.glibcVersionRuntime) return 'glibc';
    } catch {}
    if (fs.existsSync('/etc/alpine-release')) return 'musl';
    try {
        const out = execFileSync('ldd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        if (/musl/i.test(out)) return 'musl';
    } catch (err) {
        const msg = String(err.stderr ?? '');
        if (/musl/i.test(msg)) return 'musl';
    }
    return 'glibc';
}

function getHostInfo() {
    const platform = process.platform === 'win32' ? 'win32' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return { platform, arch, libc: detectLibc(), nodeAbi: process.versions.modules };
}

function composePrebuiltKey(host, version) {
    const libcSuffix = host.platform === 'linux' ? `-${host.libc}` : '';
    return `node-pty-v${version}-node-abi${host.nodeAbi}-${host.platform}-${host.arch}${libcSuffix}`;
}

async function verifyChecksum(filePath, expectedHex) {
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === expectedHex.toLowerCase()));
        stream.on('error', () => resolve(false));
    });
}

function nodeModulesReleaseDir() {
    const pkgJsonPath = path.join(__dirname, '..', 'node_modules', 'node-pty', 'package.json');
    const pkgDir = path.dirname(pkgJsonPath);
    return path.join(pkgDir, 'build', 'Release');
}

async function main() {
    const depsPath = process.argv[2] ?? path.resolve(__dirname, '..', 'dependencies');
    const host = getHostInfo();
    console.log(`[fetch-prebuilts] host: ${host.platform}-${host.arch}-${host.libc} abi=${host.nodeAbi}`);
    console.log(`[fetch-prebuilts] depsPath: ${depsPath}`);

    const { base: RELEASE_URL_BASE, overridden, ignoredOverride } = resolveReleaseUrlBase();
    if (overridden) {
        console.warn(
            `[fetch-prebuilts] WARNING: honoring overridden release URL base ${RELEASE_URL_BASE} (WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE=1)`,
        );
    } else if (ignoredOverride) {
        console.warn(
            '[fetch-prebuilts] WARNING: WSSCRCPY_RELEASE_URL_BASE is set but ignored; set WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE=1 to opt in. Using the canonical release URL.',
        );
    }

    const manifestUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-latest/manifest.json`;
    const manifestRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!manifestRes.ok) {
        console.error(`[fetch-prebuilts] manifest fetch failed: ${manifestRes.status}`);
        process.exit(1);
    }
    const manifest = await manifestRes.json();
    const manifestCachePath = path.join(depsPath, 'node-pty', 'manifest.json');
    fs.mkdirSync(path.dirname(manifestCachePath), { recursive: true });
    fs.writeFileSync(manifestCachePath, JSON.stringify(manifest, null, 2));

    if (!manifest.coveredAbis.includes(host.nodeAbi)) {
        console.error(`[fetch-prebuilts] manifest covers ABIs ${manifest.coveredAbis.join(',')}; host needs ${host.nodeAbi}`);
        process.exit(1);
    }

    const version = readInstalledNodePtyVersion(path.resolve(__dirname, '..'));
    if (manifest.upstreamVersion && manifest.upstreamVersion !== version) {
        console.warn(
            `[fetch-prebuilts] note: manifest upstreamVersion ${manifest.upstreamVersion} differs from installed node-pty ${version}; fetching the installed (pinned) version.`,
        );
    }
    const key = composePrebuiltKey(host, version);
    const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
    const cacheDir = path.join(depsPath, 'node-pty', `v${version}`, `${host.platform}-${host.arch}${libcSegment}`);

    if (!fs.existsSync(path.join(cacheDir, 'pty.node'))) {
        const sumsRes = await fetch(`${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/SHA256SUMS`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!sumsRes.ok) { console.error(`[fetch-prebuilts] SHA256SUMS fetch failed: ${sumsRes.status}`); process.exit(1); }
        const sumsText = await sumsRes.text();
        const sumLine = sumsText.split('\n').find((l) => l.includes(`${key}.tar.gz`));
        if (!sumLine) { console.error(`[fetch-prebuilts] no checksum for ${key}.tar.gz`); process.exit(1); }
        const expectedSha = sumLine.split(/\s+/)[0].toLowerCase();

        const tarUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/${key}.tar.gz`;
        const tarRes = await fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!tarRes.ok) { console.error(`[fetch-prebuilts] tarball fetch failed: ${tarRes.status}`); process.exit(1); }

        fs.mkdirSync(cacheDir, { recursive: true });
        const tarPath = path.join(cacheDir, `${key}.tar.gz`);
        fs.writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));
        if (!(await verifyChecksum(tarPath, expectedSha))) {
            console.error('[fetch-prebuilts] checksum mismatch');
            fs.rmSync(tarPath, { force: true });
            process.exit(1);
        }
        // GNU tar on Windows (Git Bash) interprets 'C:\\...' as 'host:path'.
        // Pass only the filename and cwd into the cacheDir so tar uses relative paths.
        execFileSync('tar', ['-xzf', path.basename(tarPath), '--strip-components=1'], {
            stdio: 'inherit',
            cwd: cacheDir,
        });
        fs.rmSync(tarPath, { force: true });
        console.log(`[fetch-prebuilts] downloaded and extracted to ${cacheDir}`);
    } else {
        console.log(`[fetch-prebuilts] cache hit at ${cacheDir}`);
    }

    const activeDir = nodeModulesReleaseDir();
    fs.mkdirSync(activeDir, { recursive: true });
    fs.cpSync(cacheDir, activeDir, { recursive: true, force: true });
    console.log(`[fetch-prebuilts] active location populated: ${activeDir}`);
}

// Only run when invoked directly as a CLI (npm run fetch-prebuilts /
// vitest.globalSetup's `node scripts/fetch-prebuilts.mjs`). Guarding this
// lets the module be imported by unit tests without firing a network
// download on import. Same idiom as scripts/assert-version-sync.mjs.
if (
    process.argv[1] &&
    process.argv[1].replace(/\\/g, '/').endsWith('scripts/fetch-prebuilts.mjs')
) {
    main().catch((err) => {
        console.error('[fetch-prebuilts] unexpected error:', err);
        process.exit(1);
    });
}
