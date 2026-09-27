import fs from 'fs';
import path from 'path';
import { renameSyncWithRetry } from '../util/atomicFile';

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
    /**
     * Windows only: where the TLS home lived before 2026-09-27, inside the
     * per-user app folder (`%LOCALAPPDATA%\WsScrcpyWeb\tls`). `migrateLegacyTlsHome`
     * moves it to the current home once.
     */
    legacyTlsDir?: string;
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
 *
 * And its OWN folder there, `WsScrcpyWeb-tls`, beside the app folder rather than
 * inside it (user decision 2026-09-27). A per-user Velopack install lives in
 * `%LOCALAPPDATA%\WsScrcpyWeb` and its uninstall removes that folder; the CA
 * every device was told to trust must survive a reinstall.
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

        const tlsDir = pathModule.join(base, 'WsScrcpyWeb-tls');
        const caRoot = pathModule.join(tlsDir, 'ca');

        // Critical: ensure caRoot doesn't resolve under dataRoot
        if (resolvesUnder(caRoot, opts.dataRoot, pathModule)) {
            throw new Error(`caRoot must not resolve under dataRoot: ${caRoot} is under ${opts.dataRoot}`);
        }

        const certFile = pathModule.join(tlsDir, 'cert.pem');
        const keyFile = pathModule.join(tlsDir, 'key.pem');
        const legacyTlsDir = pathModule.join(base, 'WsScrcpyWeb', 'tls');

        return { caRoot, certFile, keyFile, legacyTlsDir };
    }

    // POSIX: both CA and leaf in data root
    const tlsDir = pathModule.join(opts.dataRoot, 'tls');
    const caRoot = pathModule.join(tlsDir, 'ca');
    const certFile = pathModule.join(tlsDir, 'cert.pem');
    const keyFile = pathModule.join(tlsDir, 'key.pem');

    return { caRoot, certFile, keyFile };
}

export type TlsHomeMigration =
    | { outcome: 'none' }
    | { outcome: 'moved' }
    | { outcome: 'kept-both' }
    | { outcome: 'failed'; detail: string };

/**
 * One-time move of a Windows TLS home from its pre-2026-09-27 location inside
 * the app folder to its own folder (see `resolveCertPaths`). Without it, every
 * existing Local HTTPS user would lose the CA their devices already trust and
 * have to reinstall it on each one.
 *
 * A single `rename` of the whole folder, so the CA, its read-only key and the
 * leaf move together or not at all. It only ever moves INTO a home that is
 * absent or holds no files: if the new home has any file in it, both are left
 * alone (`kept-both`), because the new one is either newer or deliberate and
 * overwriting it would destroy a CA.
 * A failed move leaves the legacy home untouched and is reported, never
 * thrown. HTTPS then reads as "no certificate yet" until a regenerate, which
 * is the same as a fresh install. Idempotent: once moved there is nothing to
 * move.
 *
 * After a move, the old parent (`%LOCALAPPDATA%\WsScrcpyWeb`) is removed if,
 * and only if, it is a real, now-empty directory (item 154). On a Program
 * Files install the TLS home was the only thing in it; on a per-user install
 * it IS the install and holds files, so the non-recursive removal refuses it.
 * A junction or symlink is never removed at all: see `removeIfEmpty`.
 */
export function migrateLegacyTlsHome(
    paths: CertPaths,
    fsImpl: Pick<typeof fs, 'existsSync' | 'renameSync' | 'readdirSync' | 'rmSync' | 'rmdirSync' | 'lstatSync'> = fs,
): TlsHomeMigration {
    const legacy = paths.legacyTlsDir;
    if (!legacy || !fsImpl.existsSync(legacy)) return { outcome: 'none' };
    const home = path.dirname(paths.certFile);
    if (fsImpl.existsSync(home)) {
        // A home with any file in it is newer or deliberate: never overwrite it.
        // One with NO files (an interrupted start, a hand-made folder) is not a
        // home at all, and treating it as one would strand the CA in the old
        // place on every boot while HTTPS reads "no certificate".
        if (holdsAnyFile(home, fsImpl)) return { outcome: 'kept-both' };
        fsImpl.rmSync(home, { recursive: true, force: true });
    }
    try {
        // Bounded retry: endpoint AV holding a handle for a moment makes a
        // rename fail EPERM/EBUSY, and only under load (atomicFile.ts, item 140).
        renameSyncWithRetry(legacy, home, (from, to) => fsImpl.renameSync(from, to));
    } catch (err) {
        return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
    removeIfEmpty(path.dirname(legacy), fsImpl);
    return { outcome: 'moved' };
}

/**
 * Best-effort, and NON-recursive on purpose: `rmdirSync` without `recursive`
 * refuses a real directory that holds anything (ENOTEMPTY), so it can only
 * take away an empty one.
 *
 * A link is skipped BEFORE that, because the ENOTEMPTY protection does not
 * cover it: on Windows `RemoveDirectoryW` deletes a junction or directory
 * symlink whatever its target holds (measured on Node 24 in the review of
 * item 154). A per-user install relocated with a junction would otherwise be
 * unhooked from its own path. A link is also not a folder this app made.
 *
 * Any refusal, including a scanner holding the folder, is ignored: an empty
 * folder left behind is cosmetic, and it must never turn a move that
 * succeeded into a reported failure.
 */
function removeIfEmpty(dir: string, fsImpl: Pick<typeof fs, 'rmdirSync' | 'lstatSync'>): void {
    try {
        if (!fsImpl.lstatSync(dir).isDirectory()) return;
        fsImpl.rmdirSync(dir);
    } catch {
        // Not empty (a per-user install lives here), already gone, or held open.
    }
}

function holdsAnyFile(dir: string, fsImpl: Pick<typeof fs, 'readdirSync'>): boolean {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) return true;
        if (holdsAnyFile(path.join(dir, entry.name), fsImpl)) return true;
    }
    return false;
}

/** The log line for a migration that did something, or `null` when there was nothing to move. */
export function describeTlsHomeMigration(paths: CertPaths, result: TlsHomeMigration): string | null {
    const home = path.dirname(paths.certFile);
    switch (result.outcome) {
        case 'none':
            return null;
        case 'moved':
            return `moved the TLS home from ${paths.legacyTlsDir} to ${home}, its own folder since 2026-09-27`;
        case 'kept-both':
            return `TLS material exists in both ${paths.legacyTlsDir} and ${home}; using ${home} and leaving the other alone`;
        case 'failed':
            return (
                `could not move the TLS home from ${paths.legacyTlsDir} to ${home} (${result.detail}); ` +
                'HTTPS stays off until it moves on a later start or a certificate is regenerated'
            );
    }
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
