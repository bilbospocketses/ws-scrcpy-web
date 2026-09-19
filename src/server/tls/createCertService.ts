import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import { promisify } from 'util';
import { Config, resolveDataRoot } from '../Config';
import { mkcertExeName } from '../DependencyDefinitions';
import { getDependencyManager } from '../DependencyManager';
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
 * M3: bound to `CertServiceDeps.ensureCaRootDir` — see that field's own doc
 * comment for why `CertService.generate()` calls this unconditionally (POSIX
 * only) before every mkcert spawn, rather than relying on mkcert's own
 * `os.MkdirAll(CAROOT, 0755)`. `mkdirSync`'s `mode` only takes effect for a
 * directory it actually creates, so the explicit `chmodSync` afterward is
 * what also retro-fixes one that already existed at a looser mode (created
 * by an earlier mkcert run, before this fix).
 */
export function ensureCaRootDirSync(caRoot: string): void {
    fs.mkdirSync(caRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(caRoot, 0o700);
}

/**
 * M2: mkcert is fetched "on first use" rather than at boot — see
 * `deferInstall`'s doc comment on the mkcert `DependencyDefinition` and
 * `DependencyManager.autoInstallMissing`'s skip for it. This IS that first
 * use: called from `run` (below) right before every spawn, so a certificate
 * generate() click is what actually triggers the download, and only when
 * the binary genuinely isn't there yet (`fs.existsSync` is the entire cost
 * on every call after the first).
 *
 * Goes through `getDependencyManager()`'s singleton — the SAME instance
 * `index.ts`'s boot sequence and `DependencyApi` use — so an on-demand
 * install here updates the one `DependencyInfo` the dependency panel reads,
 * rather than a second, independently-tracked manager the panel never sees.
 */
export async function ensureMkcertInstalled(exe: string): Promise<void> {
    if (fs.existsSync(exe)) return;
    const config = Config.getInstance();
    const depManager = getDependencyManager({
        dependenciesPath: config.dependenciesPath,
        restartMarkerPath: config.restartMarkerPath,
    });
    const result = await depManager.update('mkcert');
    if (!result.success) {
        throw new Error(
            `mkcert is not installed and the on-demand install failed: ${result.errorMessage ?? 'unknown error'}`,
        );
    }
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

    const mkcertExe = resolveMkcertExe(config.dependenciesPath);

    const deps: CertServiceDeps = {
        paths,
        mkcertExe,
        platform,
        run: async (exe, args, env) => {
            await ensureMkcertInstalled(exe);
            return runMkcert(exe, args, env);
        },
        exists: (p) => fs.existsSync(p),
        readFile: (p) => fs.readFileSync(p, 'utf-8'),
        chmod: (p, mode) => fs.chmodSync(p, mode),
        removeCaRoot: () => removeCaRootFiles(paths.caRoot),
        removeLeaf: () => removeLeafFiles(paths),
        ensureCaRootDir: () => ensureCaRootDirSync(paths.caRoot),
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
