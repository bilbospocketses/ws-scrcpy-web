import path from 'path';

export interface CertPathOpts {
    platform: NodeJS.Platform;
    dataRoot: string;
    localAppData?: string | undefined;
    home?: string | undefined;
}

export interface CertPaths {
    /** CAROOT — holds rootCA.pem and rootCA-key.pem. */
    caRoot: string;
    /** Absolute leaf certificate path passed as -cert-file. */
    certFile: string;
    /** Absolute leaf key path passed as -key-file. */
    keyFile: string;
}

/**
 * Where the CA and the leaf live.
 *
 * On POSIX: both the CA and leaf go in the data root at 0700 (mode is enforced
 * by the filesystem). The leaf must survive an app update and a container
 * `docker rm`, which is what the /data volume is for.
 *
 * On Windows: all TLS material is per-user, not shared. The leaf key has the same
 * exposure as the CA key (both would be readable by BUILTIN\Users if under
 * C:\ProgramData). mkcert writes keys `0400`, but Go maps Unix modes to only the
 * read-only ATTRIBUTE on Windows (no ACL) -- measured 2026-09-18. The Windows
 * data root grants BUILTIN\Users ReadAndExecute by inheritance. So both CA and
 * leaf keys would be world-readable if placed there. Solution: per-user directory
 * (AppData\Local) whose inherited ACL is already restrictive.
 */
export function resolveCertPaths(opts: CertPathOpts): CertPaths {
    const pathModule = opts.platform === 'win32' ? path.win32 : path.posix;

    // Validate dataRoot is absolute
    if (!pathModule.isAbsolute(opts.dataRoot)) {
        throw new Error(`dataRoot must be absolute: ${opts.dataRoot}`);
    }

    if (opts.platform === 'win32') {
        // Trim whitespace from optional inputs to treat whitespace-only as empty
        const localAppData = opts.localAppData?.trim();
        const home = opts.home?.trim();

        const base = localAppData || (home ? pathModule.join(home, 'AppData', 'Local') : '');
        if (!base) {
            throw new Error('cannot resolve a per-user TLS directory on Windows: neither LOCALAPPDATA nor HOME is set');
        }

        if (!pathModule.isAbsolute(base)) {
            throw new Error(`LOCALAPPDATA or HOME\\AppData\\Local must be absolute: ${base}`);
        }

        const caRoot = pathModule.join(base, 'WsScrcpyWeb', 'tls', 'ca');

        // Critical: ensure caRoot doesn't resolve under dataRoot
        if (resolvesUnder(caRoot, opts.dataRoot, pathModule)) {
            throw new Error(`caRoot must not resolve under dataRoot: ${caRoot} is under ${opts.dataRoot}`);
        }

        const tlsDir = pathModule.join(base, 'WsScrcpyWeb', 'tls');
        const certFile = pathModule.join(tlsDir, 'cert.pem');
        const keyFile = pathModule.join(tlsDir, 'key.pem');

        return { caRoot, certFile, keyFile };
    }

    // POSIX: both CA and leaf in data root
    const tlsDir = pathModule.join(opts.dataRoot, 'tls');
    const caRoot = pathModule.join(tlsDir, 'ca');
    const certFile = pathModule.join(tlsDir, 'cert.pem');
    const keyFile = pathModule.join(tlsDir, 'key.pem');

    return { caRoot, certFile, keyFile };
}

/**
 * Check if a path resolves under another path. Comparison is case-insensitive
 * on Windows and case-sensitive on POSIX. Path segments are compared to avoid
 * treating C:\Data2 as under C:\Data.
 */
function resolvesUnder(
    childPath: string,
    parentPath: string,
    pathModule: typeof path.win32 | typeof path.posix,
): boolean {
    const normalize = (p: string) => pathModule.normalize(p);
    const sep = pathModule.sep;

    const normalized = normalize(childPath);
    const normalizedParent = normalize(parentPath);

    // Add separator to parent to ensure segment boundary check
    const parentWithSep = normalizedParent.endsWith(sep) ? normalizedParent : normalizedParent + sep;

    const normalizedLower = pathModule === path.win32 ? normalized.toLowerCase() : normalized;
    const parentWithSepLower = pathModule === path.win32 ? parentWithSep.toLowerCase() : parentWithSep;

    return normalizedLower.startsWith(parentWithSepLower);
}
