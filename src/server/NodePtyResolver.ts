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
    /** true when a working node-pty module is available via some source */
    available: boolean;
    /** the resolved node-pty module, only present when available === true */
    pty?: typeof import('@homebridge/node-pty-prebuilt-multiarch');
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

/**
 * Test-only: find which cache-dir entry matches the given host info, if any.
 * Returns the matched entry name (e.g. "node-pty-v1.1.0-node-abi127-linux-x64-glibc")
 * and the expected pty.node path, without performing any I/O beyond readdirSync.
 */
export function _findCacheEntry(host: HostInfo, cacheDir: string): { entryName: string; binaryPath: string } | null {
    if (!fs.existsSync(cacheDir)) return null;
    const entries = fs.readdirSync(cacheDir);
    const wantSuffix = `-node-abi${host.nodeAbi}-${host.platform}-${host.arch}${host.platform === 'linux' ? `-${host.libc}` : ''}`;
    const match = entries.find((e) => e.startsWith('node-pty-v') && e.endsWith(wantSuffix));
    if (!match) return null;
    return { entryName: match, binaryPath: path.join(cacheDir, match, 'pty.node') };
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

const RELEASE_URL_BASE = 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download';
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Resolve the path where homebridge's prebuild-file-path.js will look for
 * the native binary for the current Node ABI.
 *
 * homebridge's loader (lib/prebuild-file-path.js) constructs:
 *   <package>/prebuilds/{platform}-{arch}/node.abi{modules}[.musl].node
 * and checks fs.existsSync at require-time. There is no env-var override.
 * Placing the .node file at this path before the first import is the only
 * way to inject a custom binary.
 */
export function homebridgePrebuildPath(host: HostInfo): string {
    const pkgDir = path.dirname(require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json'));
    const runtimeTag = process.versions.hasOwnProperty('electron') ? 'electron' : 'node';
    const muslSuffix = host.platform === 'linux' && host.libc === 'musl' ? '.musl' : '';
    const filename = `${runtimeTag}.abi${host.nodeAbi}${muslSuffix}.node`;
    return path.join(pkgDir, 'prebuilds', `${host.platform}-${host.arch}`, filename);
}

async function tryCachedPrebuilt(host: HostInfo, depsPath: string): Promise<NodePtyHandle | null> {
    const cacheDir = path.join(depsPath, 'node-pty', 'prebuilds');
    try {
        if (!fs.existsSync(cacheDir)) return null;
        const entries = fs.readdirSync(cacheDir);
        const wantSuffix = `-node-abi${host.nodeAbi}-${host.platform}-${host.arch}${host.platform === 'linux' ? `-${host.libc}` : ''}`;
        const match = entries.find((e) => e.startsWith('node-pty-v') && e.endsWith(wantSuffix));
        if (!match) return null;
        const binaryPath = path.join(cacheDir, match, 'pty.node');
        if (!fs.existsSync(binaryPath)) return null;
        // homebridge's loader checks fs.existsSync on a fixed path at require-time.
        // Copy the cached binary to the exact path homebridge expects, then import.
        const destPath = homebridgePrebuildPath(host);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(binaryPath, destPath);
        const pty = await import('@homebridge/node-pty-prebuilt-multiarch');
        if (typeof (pty as any).spawn !== 'function') return null;
        log.info(`node-pty resolved from disk cache: ${match}`);
        return { available: true, pty };
    } catch (err) {
        log.info(`disk cache load failed: ${(err as Error).message}`);
        return null;
    }
}

async function tryDownloadPrebuilt(host: HostInfo, depsPath: string, upstreamVersion: string): Promise<NodePtyHandle | null> {
    const key = composePrebuiltKey(host, upstreamVersion);
    const url = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${upstreamVersion}/${key}.tar.gz`;
    const sumsUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-v${upstreamVersion}/SHA256SUMS`;
    try {
        // Fetch SHA256SUMS first so we can verify before extracting
        const sumsRes = await fetch(sumsUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!sumsRes.ok) {
            log.info(`SHA256SUMS fetch failed: ${sumsRes.status}`);
            return null;
        }
        const sumsText = await sumsRes.text();
        const sumLine = sumsText.split('\n').find((l) => l.includes(`${key}.tar.gz`));
        if (!sumLine) {
            log.info(`no checksum entry for ${key}.tar.gz in SHA256SUMS`);
            return null;
        }
        const expectedSha = sumLine.split(/\s+/)[0].toLowerCase();

        // Download the tarball
        const binRes = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!binRes.ok) {
            log.info(`tarball fetch failed: ${binRes.status}`);
            return null;
        }
        const cacheDir = path.join(depsPath, 'node-pty', 'prebuilds', key);
        fs.mkdirSync(cacheDir, { recursive: true });
        const tarPath = path.join(cacheDir, `${key}.tar.gz`);
        fs.writeFileSync(tarPath, Buffer.from(await binRes.arrayBuffer()));

        // Verify checksum before extracting
        if (!(await verifyChecksum(tarPath, expectedSha))) {
            log.error(`checksum mismatch for ${key}.tar.gz — refusing to use`);
            fs.rmSync(tarPath, { force: true });
            return null;
        }

        // Extract — use system tar (built-in on Windows 10+ and every Linux)
        const { execFileSync } = await import('child_process');
        execFileSync('tar', ['-xzf', tarPath, '-C', cacheDir], { stdio: 'inherit' });
        fs.rmSync(tarPath, { force: true });

        // homebridge's loader checks fs.existsSync on a fixed path at require-time.
        // Copy the extracted binary to the exact path homebridge expects, then import.
        const binaryPath = path.join(cacheDir, 'pty.node');
        if (!fs.existsSync(binaryPath)) {
            log.error(`pty.node missing after extract in ${cacheDir}`);
            return null;
        }
        const destPath = homebridgePrebuildPath(host);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(binaryPath, destPath);
        const pty = await import('@homebridge/node-pty-prebuilt-multiarch');
        if (typeof (pty as any).spawn !== 'function') return null;
        log.info(`node-pty resolved via downloaded prebuilt: ${key}`);
        return { available: true, pty };
    } catch (err) {
        log.info(`download fallback failed: ${(err as Error).message}`);
        return null;
    }
}

export async function resolveNodePty(depsPath: string): Promise<NodePtyHandle> {
    if (cachedHandle) return cachedHandle;
    if (inflight) return inflight;
    inflight = (async () => {
        const host = getHostInfo();
        log.info(`resolving node-pty for ${host.platform}-${host.arch}-${host.libc}-abi${host.nodeAbi}`);

        // Source 1: homebridge fork as installed
        try {
            const pty = await import('@homebridge/node-pty-prebuilt-multiarch');
            if (typeof (pty as any).spawn === 'function') {
                log.info('node-pty resolved via @homebridge/node-pty-prebuilt-multiarch');
                cachedHandle = { available: true, pty };
                return cachedHandle;
            }
        } catch (err) {
            log.info(`homebridge fork load failed: ${(err as Error).message}`);
        }

        // Source 2: disk cache (from a previous download)
        const cached = await tryCachedPrebuilt(host, depsPath);
        if (cached) { cachedHandle = cached; return cached; }

        // Source 3: download from our GH Releases.
        // Fetch the 'latest' manifest first to discover which upstream version we should try.
        try {
            const manifestUrl = `${RELEASE_URL_BASE}/node-pty-prebuilds-latest/manifest.json`;
            const manifestRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (manifestRes.ok) {
                const manifest = await manifestRes.json() as { upstreamVersion: string; coveredAbis: string[] };
                if (manifest.coveredAbis.includes(host.nodeAbi)) {
                    const downloaded = await tryDownloadPrebuilt(host, depsPath, manifest.upstreamVersion);
                    if (downloaded) { cachedHandle = downloaded; return downloaded; }
                } else {
                    log.info(`manifest does not cover ABI ${host.nodeAbi}`);
                }
            }
        } catch (err) {
            log.info(`manifest fetch failed: ${(err as Error).message}`);
        }

        cachedHandle = { available: false, reason: `no-prebuilt-for-abi-${host.nodeAbi}-${host.platform}-${host.arch}-${host.libc}` };
        return cachedHandle;
    })();
    return inflight;
}
