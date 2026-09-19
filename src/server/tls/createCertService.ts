import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import { promisify } from 'util';
import { Config, resolveDataRoot } from '../Config';
import { mkcertExeName } from '../DependencyDefinitions';
import { CertService, type CertServiceDeps } from './CertService';
import { resolveCertPaths } from './certPaths';

const execFileAsync = promisify(execFile);

/**
 * mkcert generally finishes in well under a second (TRUST_STORES=none means no
 * interactive OS-trust-store prompt), but this is a spawn a user's click waits
 * on, so a generous ceiling beats hanging the request forever if the binary
 * ever wedges.
 */
const MKCERT_TIMEOUT_MS = 30_000;

/**
 * The local-dependency path for the vendored mkcert binary. **Never PATH** —
 * Local-Dependencies-Only. Matches `<depsPath>/mkcert/<exe>` exactly, which is
 * the layout the `mkcert` DependencyDefinition's own `checkInstalled` uses
 * (`DependencyDefinitions.ts`) — unlike `adb`/`node`/`scrcpy-server`, there is
 * no version segment. If these two ever disagree, the manager installs to one
 * path and this service spawns from another, so `mkcertExeName()` is reused
 * rather than re-derived by hand.
 */
export function resolveMkcertExe(depsPath: string): string {
    return path.join(depsPath, 'mkcert', mkcertExeName());
}

/** Deletes a file if present; a missing file is a no-op, never a throw. A
 * directory at the given path is NOT swallowed — that is not the missing-file
 * case this exists to tolerate, and swallowing it would hide a wrong path
 * silently removing something it should not. */
function removeFileIfPresent(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
}

/**
 * Deletes exactly `rootCA.pem` and `rootCA-key.pem` from `caRoot` — never the
 * directory itself, never anything else in it. Bound to `CertServiceDeps.removeCaRoot`;
 * `CertService.generate()` calls this unconditionally before every spawn (see
 * its own doc comment) and `revoke()` calls it too, so a wrong implementation
 * here has the blast radius of the user's TLS trust material.
 */
export function removeCaRootFiles(caRoot: string): void {
    removeFileIfPresent(path.join(caRoot, 'rootCA.pem'));
    removeFileIfPresent(path.join(caRoot, 'rootCA-key.pem'));
}

/**
 * Deletes exactly the leaf cert and key — never the directory, never anything
 * else. Bound to `CertServiceDeps.removeLeaf`, called only from `revoke()`,
 * which is reachable from an admin HTTP route (`POST /api/tls/revoke`).
 */
export function removeLeafFiles(leafPaths: { certFile: string; keyFile: string }): void {
    removeFileIfPresent(leafPaths.certFile);
    removeFileIfPresent(leafPaths.keyFile);
}

/**
 * Spawn mkcert and resolve `{ code, stderr }` rather than throwing on a
 * non-zero exit — `CertService.generate()` reads `code`/`stderr` itself to
 * decide success vs. failure and to surface mkcert's own message. No shell is
 * used (execFile, array args): a certificate subject is untrusted input by the
 * time it reaches here, so this must not be interpretable as shell syntax.
 */
async function runMkcert(
    exe: string,
    args: string[],
    env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
    try {
        const { stderr } = await execFileAsync(exe, args, {
            env: { ...process.env, ...env },
            timeout: MKCERT_TIMEOUT_MS,
        });
        return { code: 0, stderr };
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        // A spawn failure (binary missing/EACCES) carries a string `code`
        // ('ENOENT'/'EACCES'), not an exit code -- CertService only checks
        // `code !== 0`, so any non-zero number reports the failure correctly.
        const code = typeof e.code === 'number' ? e.code : 1;
        return { code, stderr: e.stderr ?? e.message ?? String(e) };
    }
}

function buildCertService(): CertService {
    const config = Config.getInstance();
    const platform = process.platform;

    const dataRoot = resolveDataRoot(process.env, platform);
    if (!dataRoot) {
        // Same edge case Config.dataRoot documents: HOME/XDG_DATA_HOME both
        // absent on a non-Windows host. Nothing TLS-related can have a home
        // without one, so fail loudly at first use rather than silently
        // resolving to something wrong.
        throw new Error('cannot resolve a data root for TLS certificate storage (no DATA_ROOT/XDG_DATA_HOME/HOME)');
    }

    const paths = resolveCertPaths({
        platform,
        dataRoot,
        localAppData: process.env['LOCALAPPDATA'],
        home: process.env['HOME'] || process.env['USERPROFILE'],
    });

    const deps: CertServiceDeps = {
        paths,
        mkcertExe: resolveMkcertExe(config.dependenciesPath),
        platform,
        run: runMkcert,
        exists: (p) => fs.existsSync(p),
        readFile: (p) => fs.readFileSync(p, 'utf-8'),
        chmod: (p, mode) => fs.chmodSync(p, mode),
        removeCaRoot: () => removeCaRootFiles(paths.caRoot),
        removeLeaf: () => removeLeafFiles(paths),
    };

    return new CertService(deps);
}

let instance: CertService | undefined;

/**
 * The composition root for `CertService`: the ONLY place that binds its
 * injected dependencies to real `fs`/`child_process`. Without this, the
 * service is fully tested but never constructed for real — see the task-5
 * amendment this function exists to close. Memoized so every caller (just
 * `TlsApi` today) shares one certificate lifecycle and one in-memory `state`.
 */
export function getCertService(): CertService {
    if (!instance) {
        instance = buildCertService();
    }
    return instance;
}

/** Test-only: clears the memoized instance so a test can force a rebuild against a freshly-configured Config. */
export function _resetCertServiceForTest(): void {
    instance = undefined;
}
