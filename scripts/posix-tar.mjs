#!/usr/bin/env node
// scripts/posix-tar.mjs
//
// Resolve `tar` to an absolute, canonical system path on Linux/macOS instead of
// the bare name `tar` (which the OS would resolve via $PATH). Mirrors the
// Windows `C:\Windows\System32\tar.exe` pin the build scripts already use, and
// the app's "OS helpers resolve to absolute system paths, never PATH" policy
// (Local-Dependencies-Only). Build-time only — used by the extract in
// fetch-node.mjs.

import * as fs from 'node:fs';

// Canonical locations for the system `tar`. /usr/bin/tar is GNU tar on Linux
// and bsdtar on macOS (both read the .tar.xz we extract); /bin/tar covers the
// distros that still place it there. Absolute paths only — no $PATH, no env var.
export const POSIX_TAR_CANDIDATES = ['/usr/bin/tar', '/bin/tar'];

/**
 * First existing canonical `tar`. Throws (with NO $PATH fallback) if tar is at
 * none of the known absolute locations, so a build never silently shells out to
 * a PATH-resolved binary.
 * @param {(p: string) => boolean} [existsSync] - injected for testing.
 * @returns {string} absolute path to tar
 */
export function resolvePosixTar(existsSync = fs.existsSync) {
    for (const candidate of POSIX_TAR_CANDIDATES) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        `tar not found at a canonical system path (${POSIX_TAR_CANDIDATES.join(', ')}). ` +
            'Install tar via your package manager.',
    );
}
