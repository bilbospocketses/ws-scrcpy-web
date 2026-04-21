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

export async function resolveNodePty(_depsPath: string): Promise<NodePtyHandle> {
    if (cachedHandle) return cachedHandle;
    if (inflight) return inflight;
    inflight = (async () => {
        const host = getHostInfo();
        log.info(`resolving node-pty for ${host.platform}-${host.arch}-${host.libc}-abi${host.nodeAbi}`);
        // Source 1: try homebridge fork
        try {
            const pty = await import('@homebridge/node-pty-prebuilt-multiarch');
            // Sanity-check the module actually loaded natively
            if (typeof (pty as any).spawn !== 'function') {
                throw new Error('homebridge module missing spawn()');
            }
            log.info('node-pty resolved via @homebridge/node-pty-prebuilt-multiarch');
            cachedHandle = { available: true, pty };
            return cachedHandle;
        } catch (err) {
            log.info(`homebridge fork load failed: ${(err as Error).message} — fallback not yet implemented`);
        }
        // Phase 2 (Task 7) adds the GH Releases download path here.
        cachedHandle = { available: false, reason: `no-prebuilt-for-abi-${host.nodeAbi}-${host.platform}-${host.arch}-${host.libc}` };
        return cachedHandle;
    })();
    return inflight;
}
