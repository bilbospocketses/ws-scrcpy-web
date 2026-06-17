// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as crypto from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { Logger } from './Logger';
import { detectLibc, type LibcFlavor } from './libcDetect';

/*
 * Pre-beta.23: this resolver tried two webpack escape hatches:
 *
 *   1. `import { createRequire } from 'module'` — webpack tree-shook the
 *      named import down to `void 0`, the bundle had `(void 0)('node-pty')`
 *      and the resolver failed with `(void 0) is not a function`.
 *   2. Bare runtime `require(absolutePath)` — webpack rewrote this into
 *      `__webpack_require__(<id>)` for a context-bundle of all possible
 *      matches, which doesn't resolve absolute filesystem paths.
 *
 * Beta.23+ uses `process.getBuiltinModule('module').createRequire(...)`.
 * Webpack does NOT statically analyze `process.*` calls (`getBuiltinModule`
 * was added in Node 22; we ship Node 24, so it's guaranteed available).
 * The createRequire result is the genuine Node CJS require, which
 * resolves absolute paths to actual files on disk. Same code path works
 * in vitest tests — `process.getBuiltinModule` is a Node API, not a
 * webpack runtime concept.
 */

const log = Logger.for('NodePtyResolver');

/**
 * NodePtyResolver — Local-Dependencies-Only loader for node-pty.
 *
 * v0.1.23-stable (item 5 / Approach C): node-pty is NEVER loaded from
 * `<installRoot>/current/node_modules/`. The bundled image ships node-pty
 * (and its transitive dep node-addon-api) as a SEED at
 * `<installRoot>/current/seed/node-pty-pkg/node_modules/`, and on first
 * launch (or whenever the dataRoot copy is missing) we copy it to
 * `<dataRoot>/dependencies/node-pty/v<version>-<host>/node_modules/`.
 * All loads go through `createRequire()` against a marker path inside
 * that dataRoot tree — no NODE_PATH plumbing, no writes to install root.
 *
 * Pre-v0.1.23 the resolver had two paths: tryBundledImport (read from
 * current/node_modules — read-only OK) and a download path that COPIED
 * back into current/node_modules — the architectural violation that
 * surfaced as `EIO Access is denied` on conpty in pre-beta.7 logs.
 * Even though beta.7's icacls grant made the copy succeed, writing
 * runtime state into the install image violates Local-Dependencies-Only.
 *
 * Cache-miss flow (Node ABI change after auto-update): download the
 * matching prebuilt tarball, overlay pty.node into the existing
 * dataRoot package's build/Release/, retry the require.
 */

export interface NodePtyHandle {
    /** true when a working node-pty module is available */
    available: boolean;
    /** the resolved node-pty module, only present when available === true */
    pty?: typeof import('node-pty');
    /** machine-readable reason when available === false */
    reason?: string;
}

export interface HostInfo {
    platform: 'win32' | 'linux';
    arch: 'x64' | 'arm64';
    libc: LibcFlavor;
    nodeAbi: string;
}

let cachedHandle: NodePtyHandle | undefined;
let inflight: Promise<NodePtyHandle> | undefined;

/** Test-only: clear the cached handle so tests can re-run resolution. */
export function _resetForTest(): void {
    cachedHandle = undefined;
    inflight = undefined;
}

export function getNodePty(): NodePtyHandle | undefined {
    return cachedHandle;
}

export function getHostInfo(): HostInfo {
    const platform = (process.platform === 'win32' ? 'win32' : 'linux') as HostInfo['platform'];
    const arch = (process.arch === 'arm64' ? 'arm64' : 'x64') as HostInfo['arch'];
    return {
        platform,
        arch,
        libc: detectLibc(),
        nodeAbi: process.versions.modules,
    };
}

export function composePrebuiltKey(host: HostInfo, upstreamVersion: string): string {
    const libcSuffix = host.platform === 'linux' ? `-${host.libc}` : '';
    return `node-pty-v${upstreamVersion}-node-abi${host.nodeAbi}-${host.platform}-${host.arch}${libcSuffix}`;
}

export async function verifyChecksum(filePath: string, expectedSha256Hex: string): Promise<boolean> {
    return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === expectedSha256Hex.toLowerCase()));
        stream.on('error', () => resolve(false));
    });
}

export function dataRootPackageDir(depsPath: string, upstreamVersion: string, host: HostInfo): string {
    const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
    return path.join(depsPath, 'node-pty', `v${upstreamVersion}-${host.platform}-${host.arch}${libcSegment}`);
}

/**
 * Path to the seed node-pty package staged at build time. Webpack bundles
 * `dist/index.js` into `<installRoot>/current/dist/`, so `__dirname/..` is
 * `<installRoot>/current/`, and the seed lives at
 * `<installRoot>/current/seed/node-pty-pkg/node_modules/`. Same anchoring
 * pattern as `DependencyManager.promoteSeedScrcpyServer`.
 *
 * Test override path (`_setSeedRootForTest`) lets integration tests
 * substitute a fake seed dir without compiling the bundle.
 */
let seedRootOverride: string | null = null;

export function seedPackageRoot(): string {
    return seedRootOverride ?? path.join(__dirname, '..', 'seed', 'node-pty-pkg');
}

/** Test-only: override the seed root path. Pass null to restore default. */
export function _setSeedRootForTest(p: string | null): void {
    seedRootOverride = p;
}

/** Read the version from the seed's node-pty package.json. */
export function readSeedNodePtyVersion(): string | null {
    const pkgJsonPath = path.join(seedPackageRoot(), 'node_modules', 'node-pty', 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;
    try {
        const json = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version: string };
        return json.version ?? null;
    } catch (err) {
        log.error(`failed to read seed node-pty package.json: ${(err as Error).message}`);
        return null;
    }
}

export function ptyNodePath(packageDir: string): string {
    return path.join(packageDir, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node');
}

/** True when the dataRoot package looks complete enough to attempt a load. */
export function packageHasBinary(packageDir: string): boolean {
    if (fs.existsSync(ptyNodePath(packageDir))) return true;
    const prebuildsDir = path.join(packageDir, 'node_modules', 'node-pty', 'prebuilds');
    return fs.existsSync(prebuildsDir);
}

/**
 * Copy the seed package tree to the dataRoot package dir. Idempotent —
 * skips if dataRoot already has node-pty's pty.node (safer than a generic
 * existence check; partial copies can otherwise survive across reboots).
 *
 * Returns true on success (or already-staged), false if the seed is
 * missing or the copy throws.
 */
export function copySeedToDataRoot(packageDir: string): boolean {
    if (packageHasBinary(packageDir)) {
        return true;
    }
    const seedRoot = seedPackageRoot();
    const seedNodeModules = path.join(seedRoot, 'node_modules');
    if (!fs.existsSync(seedNodeModules)) {
        log.info(`seed not present at ${seedNodeModules} — falling back to network fetch`);
        return false;
    }
    try {
        fs.mkdirSync(packageDir, { recursive: true });
        fs.cpSync(seedNodeModules, path.join(packageDir, 'node_modules'), {
            recursive: true,
            force: true,
        });
        log.info(`seeded node-pty package → ${packageDir}`);
        return true;
    } catch (err) {
        log.error(`copy seed → dataRoot failed: ${(err as Error).message}`);
        return false;
    }
}

export let RELEASE_URL_BASE = 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MANIFEST_CACHE_RELPATH = path.join('node-pty', 'manifest.json');

/** Test-only: override the release URL base for integration tests. */
export function _setReleaseUrlBase(url: string): void {
    RELEASE_URL_BASE = url;
}

export interface Manifest {
    upstreamVersion: string;
    coveredAbis: string[];
}

/**
 * Fetch the GitHub-hosted manifest listing which Node ABIs we have
 * node-pty prebuilts for. v0.1.23+: this is no longer used by the
 * resolver's first-launch path (the seed's package.json provides
 * upstreamVersion directly), but it remains in use by
 * `DependencyDefinitions.ts` to gate Node auto-updates: we don't want
 * to upgrade Node to an ABI for which we lack a node-pty prebuilt,
 * since that would silently break shell mode.
 */
export async function loadManifest(depsPath: string): Promise<Manifest | null> {
    const cachedManifestPath = path.join(depsPath, MANIFEST_CACHE_RELPATH);
    try {
        const url = `${RELEASE_URL_BASE}/node-pty-prebuilds-latest/manifest.json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (res.ok) {
            const body = (await res.json()) as Manifest;
            fs.mkdirSync(path.dirname(cachedManifestPath), { recursive: true });
            fs.writeFileSync(cachedManifestPath, JSON.stringify(body, null, 2));
            return body;
        }
        log.info(`manifest fetch returned ${res.status}; trying cached manifest`);
    } catch (err) {
        log.info(`manifest fetch failed: ${(err as Error).message}; trying cached manifest`);
    }
    if (fs.existsSync(cachedManifestPath)) {
        try {
            return JSON.parse(fs.readFileSync(cachedManifestPath, 'utf8')) as Manifest;
        } catch (err) {
            log.info(`cached manifest unreadable: ${(err as Error).message}`);
        }
    }
    return null;
}

/**
 * Download the host-specific prebuilt and overlay pty.node into the
 * dataRoot package's build/Release/. Used when the seeded pty.node fails
 * to load (Node ABI doesn't match the build-machine ABI baked into the
 * seed — typical after an in-app Node auto-update).
 */
export async function downloadAndOverlayPtyNode(version: string, host: HostInfo, packageDir: string): Promise<boolean> {
    const key = composePrebuiltKey(host, version);
    const tarUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/${key}.tar.gz`;
    const sumsUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/SHA256SUMS`;

    try {
        const sumsRes = await fetch(sumsUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!sumsRes.ok) {
            log.info(`SHA256SUMS fetch failed: ${sumsRes.status}`);
            return false;
        }
        const sumsText = await sumsRes.text();
        const sumLine = sumsText.split('\n').find((l) => l.includes(`${key}.tar.gz`));
        if (!sumLine) {
            log.info(`no checksum entry for ${key}.tar.gz`);
            return false;
        }
        const expectedSha = sumLine.split(/\s+/)[0]!.toLowerCase();

        const tarRes = await fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!tarRes.ok) {
            log.info(`tarball fetch failed: ${tarRes.status}`);
            return false;
        }

        // Stage tar in a temp dir under the package, extract, then overlay
        // contents onto the existing build/Release/. We DON'T blow away
        // build/Release because it may contain platform-specific helper
        // files (winpty-agent.exe on Windows, etc.) we want to keep.
        const stagingDir = path.join(packageDir, '.staging-' + Date.now());
        fs.mkdirSync(stagingDir, { recursive: true });
        const tarPath = path.join(stagingDir, `${key}.tar.gz`);
        fs.writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));

        if (!(await verifyChecksum(tarPath, expectedSha))) {
            log.error(`checksum mismatch for ${key}.tar.gz`);
            fs.rmSync(stagingDir, { recursive: true, force: true });
            return false;
        }

        const { execFileSync } = await import('child_process');
        // GNU tar on Windows (Git Bash) interprets 'C:\\...' as 'host:path'.
        // Pass only the filename and cwd into staging so tar uses relative paths.
        execFileSync('tar', ['-xzf', path.basename(tarPath), '--strip-components=1'], {
            stdio: 'inherit',
            cwd: stagingDir,
        });
        fs.rmSync(tarPath, { force: true });

        // Overlay extracted files into build/Release/.
        const buildReleaseDir = path.join(packageDir, 'node_modules', 'node-pty', 'build', 'Release');
        fs.mkdirSync(buildReleaseDir, { recursive: true });
        fs.cpSync(stagingDir, buildReleaseDir, { recursive: true, force: true });
        fs.rmSync(stagingDir, { recursive: true, force: true });

        return packageHasBinary(packageDir);
    } catch (err) {
        log.info(`download failed: ${(err as Error).message}`);
        return false;
    }
}

/**
 * Load node-pty from the dataRoot package via the runtime require,
 * bypassing both Node's default module resolution (which would look in
 * `<installRoot>/current/node_modules/`) AND webpack's static-import
 * rewriting. We pass an ABSOLUTE PATH to require, so Node loads
 * exactly the file we hand it without any resolution lookup.
 *
 * The path points at node-pty's package.json directory; Node's
 * require() reads that package's "main" field (lib/index.js) and
 * loads from there. node-pty's own internal `require('./build/Release/pty.node')`
 * is a relative require (relative to node-pty's index.js), so it
 * correctly finds the binary inside the dataRoot package — regardless
 * of how the package itself was loaded.
 */
function loadFromDataRoot(packageDir: string): typeof import('node-pty') | null {
    try {
        // process.getBuiltinModule (Node 22+) returns the genuine Node
        // builtin without going through any module-resolution path.
        // Webpack does not analyze process.* expressions, so the whole
        // chain — process.getBuiltinModule → createRequire → require —
        // survives bundling untouched. createRequire's argument is a
        // marker path inside packageDir; the require it returns then
        // resolves 'node-pty' against packageDir's node_modules tree.
        // biome-ignore lint/suspicious/noExplicitAny: process.getBuiltinModule is loosely typed
        const builtinModule = (process as any).getBuiltinModule('module') as {
            createRequire(filename: string): NodeJS.Require;
        };
        const marker = path.join(packageDir, '_resolver-marker.js');
        const r = builtinModule.createRequire(marker);
        const pty = r('node-pty') as typeof import('node-pty');
        // biome-ignore lint/suspicious/noExplicitAny: runtime shape check on an untyped import
        if (typeof (pty as any).spawn !== 'function') {
            return null;
        }
        return pty;
    } catch (err) {
        log.info(`require from ${packageDir} failed: ${(err as Error).message}`);
        return null;
    }
}

export async function resolveNodePty(depsPath: string): Promise<NodePtyHandle> {
    if (cachedHandle) return cachedHandle;
    if (inflight) return inflight;
    inflight = (async () => {
        const host = getHostInfo();
        log.info(`resolving node-pty for ${host.platform}-${host.arch}-${host.libc}-abi${host.nodeAbi}`);

        const version = readSeedNodePtyVersion();
        if (!version) {
            cachedHandle = { available: false, reason: 'no-seed-package' };
            log.error('no seed node-pty package found; cannot resolve');
            return cachedHandle;
        }

        const packageDir = dataRootPackageDir(depsPath, version, host);

        // Step 1: ensure the dataRoot package exists. First launch: copy
        // from seed. Subsequent launches: skip (already present).
        if (!packageHasBinary(packageDir)) {
            log.info(`first-launch staging: ${packageDir}`);
            if (!copySeedToDataRoot(packageDir)) {
                cachedHandle = { available: false, reason: 'seed-stage-failed' };
                return cachedHandle;
            }
        }

        // Step 2: try to load the dataRoot package. If pty.node ABI matches
        // the running Node, this succeeds.
        let pty = loadFromDataRoot(packageDir);
        if (pty) {
            log.info(`node-pty resolved (v${version}) from dataRoot`);
            cachedHandle = { available: true, pty };
            return cachedHandle;
        }

        // Step 3: ABI mismatch (typical after Node auto-update). Download
        // the host-specific prebuilt, overlay pty.node, retry load.
        log.info(`dataRoot pty.node ABI mismatch; downloading prebuilt for abi${host.nodeAbi}`);
        const ok = await downloadAndOverlayPtyNode(version, host, packageDir);
        if (!ok) {
            cachedHandle = { available: false, reason: 'download-failed' };
            return cachedHandle;
        }
        pty = loadFromDataRoot(packageDir);
        if (!pty) {
            cachedHandle = { available: false, reason: 'load-failed-after-download' };
            return cachedHandle;
        }
        log.info(`node-pty resolved (v${version}) via download`);
        cachedHandle = { available: true, pty };
        return cachedHandle;
    })();
    return inflight;
}
