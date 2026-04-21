// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFileSync } from 'child_process';

export type LibcFlavor = 'glibc' | 'musl';

/**
 * Detect the C library flavor of the running process. Only relevant on Linux;
 * returns 'glibc' unconditionally on other platforms. Uses three probes in
 * order so that minimal containers without /etc/alpine-release or without
 * ldd still get a correct answer.
 */
export function detectLibc(): LibcFlavor {
    if (process.platform !== 'linux') return 'glibc';

    // Probe 1: process.report exposes glibcVersionRuntime on glibc only
    try {
        const report = (process.report as any)?.getReport?.();
        if (report?.header?.glibcVersionRuntime) return 'glibc';
    } catch {
        // process.report not available — continue
    }

    // Probe 2: Alpine writes /etc/alpine-release
    try {
        fs.accessSync('/etc/alpine-release');
        return 'musl';
    } catch {
        // not Alpine — continue
    }

    // Probe 3: ldd --version stderr mentions "musl" on musl systems
    try {
        const out = execFileSync('ldd', ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
        if (out.toLowerCase().includes('musl')) return 'musl';
    } catch {
        // ldd unavailable — fall through
    }

    return 'glibc';
}
