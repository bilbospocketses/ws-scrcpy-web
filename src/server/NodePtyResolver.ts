// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as crypto from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { Logger } from './Logger';
import { detectLibc, type LibcFlavor } from './libcDetect';

const log = Logger.for('NodePtyResolver');

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

export interface Manifest {
    upstreamVersion: string;
    coveredAbis: string[];
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

export function cacheDirHasBinary(dir: string): boolean {
    try {
        return fs.existsSync(path.join(dir, 'pty.node'));
    } catch {
        return false;
    }
}

export function nodeModulesReleaseDir(): string {
    // Resolve relative to process.cwd() rather than require.resolve().
    // Webpack's bundler rewrites `require.resolve('node-pty/package.json')`
    // into a module-ID lookup that returns a number (the module ID),
    // not a string path — which then throws from downstream fs calls.
    // process.cwd() is the repo root during dev (`npm start`/tests) and
    // the install root in the packaged app.
    return path.resolve(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release');
}

export function cachePathForHost(depsPath: string, upstreamVersion: string, host: HostInfo): string {
    const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
    return path.join(
        depsPath,
        'node-pty',
        `v${upstreamVersion}`,
        `${host.platform}-${host.arch}${libcSegment}`,
    );
}

export let RELEASE_URL_BASE = 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MANIFEST_CACHE_RELPATH = path.join('node-pty', 'manifest.json');

/** Test-only: override the release URL base for integration tests. */
export function _setReleaseUrlBase(url: string): void {
    RELEASE_URL_BASE = url;
}

export async function loadManifest(depsPath: string): Promise<Manifest | null> {
    const cachedManifestPath = path.join(depsPath, MANIFEST_CACHE_RELPATH);
    try {
        const url = `${RELEASE_URL_BASE}/node-pty-prebuilds-latest/manifest.json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (res.ok) {
            const body = await res.json() as Manifest;
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

export async function downloadAndExtract(
    version: string,
    host: HostInfo,
    cacheDir: string,
): Promise<boolean> {
    const key = composePrebuiltKey(host, version);
    const tarUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/${key}.tar.gz`;
    const sumsUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${version}/SHA256SUMS`;

    try {
        const sumsRes = await fetch(sumsUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!sumsRes.ok) { log.info(`SHA256SUMS fetch failed: ${sumsRes.status}`); return false; }
        const sumsText = await sumsRes.text();
        const sumLine = sumsText.split('\n').find((l) => l.includes(`${key}.tar.gz`));
        if (!sumLine) { log.info(`no checksum entry for ${key}.tar.gz`); return false; }
        const expectedSha = sumLine.split(/\s+/)[0].toLowerCase();

        const tarRes = await fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!tarRes.ok) { log.info(`tarball fetch failed: ${tarRes.status}`); return false; }

        fs.mkdirSync(cacheDir, { recursive: true });
        const tarPath = path.join(cacheDir, `${key}.tar.gz`);
        fs.writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));

        if (!(await verifyChecksum(tarPath, expectedSha))) {
            log.error(`checksum mismatch for ${key}.tar.gz`);
            fs.rmSync(tarPath, { force: true });
            return false;
        }

        const { execFileSync } = await import('child_process');
        // GNU tar on Windows (Git Bash) interprets 'C:\\...' as 'host:path'.
        // Pass only the filename and cwd into cacheDir so tar uses relative paths.
        execFileSync('tar', ['-xzf', path.basename(tarPath), '--strip-components=1'], {
            stdio: 'inherit',
            cwd: cacheDir,
        });
        fs.rmSync(tarPath, { force: true });
        return cacheDirHasBinary(cacheDir);
    } catch (err) {
        log.info(`download failed: ${(err as Error).message}`);
        return false;
    }
}

export function copyTreeTo(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
}

export async function resolveNodePty(depsPath: string): Promise<NodePtyHandle> {
    if (cachedHandle) return cachedHandle;
    if (inflight) return inflight;
    inflight = (async () => {
        const host = getHostInfo();
        log.info(`resolving node-pty for ${host.platform}-${host.arch}-${host.libc}-abi${host.nodeAbi}`);

        const manifest = await loadManifest(depsPath);
        if (!manifest) {
            cachedHandle = { available: false, reason: 'no-manifest' };
            return cachedHandle;
        }
        if (!manifest.coveredAbis.includes(host.nodeAbi)) {
            cachedHandle = {
                available: false,
                reason: `no-prebuilt-for-abi-${host.nodeAbi}-${host.platform}-${host.arch}-${host.libc}`,
            };
            return cachedHandle;
        }
        const version = manifest.upstreamVersion;
        const cacheDir = cachePathForHost(depsPath, version, host);

        let usedPath: 'cache' | 'download' = 'cache';
        if (!cacheDirHasBinary(cacheDir)) {
            log.info(`cache miss at ${cacheDir}; downloading`);
            const ok = await downloadAndExtract(version, host, cacheDir);
            if (!ok) {
                cachedHandle = { available: false, reason: 'download-failed' };
                return cachedHandle;
            }
            usedPath = 'download';
        } else {
            log.info(`cache hit at ${cacheDir}`);
        }

        try {
            copyTreeTo(cacheDir, nodeModulesReleaseDir());
        } catch (err) {
            log.error(`copy to node_modules failed: ${(err as Error).message}`);
            cachedHandle = { available: false, reason: 'copy-failed' };
            return cachedHandle;
        }

        try {
            const pty = await import('node-pty');
            if (typeof (pty as any).spawn !== 'function') {
                cachedHandle = { available: false, reason: 'import-invalid' };
                return cachedHandle;
            }
            log.info(`node-pty resolved (version ${version}) via ${usedPath}`);
            cachedHandle = { available: true, pty };
            return cachedHandle;
        } catch (err) {
            log.error(`node-pty import failed: ${(err as Error).message}`);
            cachedHandle = { available: false, reason: 'import-failed' };
            return cachedHandle;
        }
    })();
    return inflight;
}
