import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { APP_CONFIG_DEFAULTS } from '../../common/ConfigEvents';
import { WS_SCRCPY_SERVICE_DESCRIPTION, WS_SCRCPY_SERVICE_NAME } from '../../common/ServiceEvents';
import { resolveDependenciesPath } from '../Config';
import { Logger } from '../Logger';
import {
    buildServiceUnitEnv,
    buildSystemSeedConfig,
    renderUnitFile,
    STAGED_SYSTEM_APPIMAGE,
    STAGED_SYSTEM_DEPS_DIR,
    STAGED_SYSTEM_DIR,
    SYSTEM_FCONTEXT_SPEC,
    SYSTEM_STATE_DIR,
} from './SystemdClient';
import { resolveSystemTool } from './systemTools';

const log = Logger.for('systemServiceCli');

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface CoreDeps {
    getuid: () => number;
    run: CommandRunner;
    writeFile: (path: string, content: string, opts: { mode: number }) => void;
    appImageSource: string;
    /** Fallback dependencies tree to stage when the caller passes none; null = none known. */
    depsSource: string | null;
    tool: (t: string) => string; // /usr/bin resolver
    sbinTool: (t: string) => string; // /usr/sbin resolver (semanage/restorecon)
    lstat: (path: string) => { uid: number; gid: number; mode: number; isSymbolicLink: boolean };
    /** Non-fatal problems worth surfacing (stderr in production). */
    warn?: (s: string) => void;
}

const UNIT_PATH = `/etc/systemd/system/${WS_SCRCPY_SERVICE_NAME}.service`;
const STAGED_BIN = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
const SYSTEM_LOGS_DIR = `${SYSTEM_STATE_DIR}/logs`;

function assertRoot(getuid: () => number): void {
    if (getuid() !== 0) {
        throw new Error(
            '--install-system-service must run as root (use sudo, or the desktop installer which elevates via pkexec).',
        );
    }
}

/**
 * Before any privileged copy/chmod/relabel, assert a target directory is a
 * real, root-owned directory that group/other cannot write — defeating a
 * symlink swap or TOCTOU that would redirect root's `cp`/`chmod`/`restorecon -R`
 * onto an attacker-chosen path. (#15)
 */
export function assertSafeRootDir(path: string, lstat: CoreDeps['lstat']): void {
    const st = lstat(path);
    if (st.isSymbolicLink) {
        throw new Error(`refusing to operate on ${path}: it is a symlink`);
    }
    if (st.uid !== 0) {
        throw new Error(`refusing to operate on ${path}: not root-owned (uid ${st.uid})`);
    }
    if ((st.mode & 0o022) !== 0) {
        throw new Error(`refusing to operate on ${path}: group/other-writable (mode ${(st.mode & 0o777).toString(8)})`);
    }
}

/**
 * `assertSafeRootDir`, after repairing the ONE unsafe shape root itself produces:
 * a real, root:root directory that is group-writable but not world-writable.
 * A desktop user's umask is 0002 on Ubuntu (user-private groups), pkexec keeps
 * it, and every `mkdir` root ran through it before D8's fix left 775 behind —
 * so the system install refused a directory its own machine-wide install made.
 * Group root admits only root-group members, so dropping g+w is a repair, not a
 * trust decision. Everything else (a symlink, a non-root owner, a group other
 * than root, world-writable) is still refused, by the re-check.
 */
export async function ensureSafeRootDir(dir: string, d: Pick<CoreDeps, 'lstat' | 'run' | 'tool'>): Promise<void> {
    const st = d.lstat(dir);
    if (!st.isSymbolicLink && st.uid === 0 && st.gid === 0 && (st.mode & 0o022) === 0o020) {
        await d.run([d.tool('chmod'), 'g-w', dir]);
    }
    assertSafeRootDir(dir, d.lstat);
}

export async function installSystemService(
    opts: { port: number; depsSource?: string | undefined },
    d: CoreDeps,
): Promise<void> {
    assertRoot(d.getuid);
    const mkdir = d.tool('mkdir');
    const cp = d.tool('cp');
    const chmod = d.tool('chmod');
    const systemctl = d.tool('systemctl');
    const semanage = d.sbinTool('semanage');
    const restorecon = d.sbinTool('restorecon');

    // Explicit 0755 (D8): never inherit the caller's umask for a root tree.
    await d.run([mkdir, '-p', '-m', '0755', STAGED_SYSTEM_DIR]);
    await d.run([mkdir, '-p', '-m', '0755', SYSTEM_STATE_DIR]);
    // Guard against a symlink/TOCTOU swap before root copies or relabels into
    // these predictable dirs (#15): each must be a real, root-owned,
    // non-group/world-writable directory (a root:root 775 is repaired first).
    await ensureSafeRootDir(STAGED_SYSTEM_DIR, d);
    await ensureSafeRootDir(SYSTEM_STATE_DIR, d);
    // The unit appends to <state>/logs/service.log, and systemd does not create
    // an `append:` target's parent: without this the unit fails at step STDOUT
    // (status 209) on every clean host (D9).
    await d.run([mkdir, '-p', '-m', '0755', SYSTEM_LOGS_DIR]);
    await ensureSafeRootDir(SYSTEM_LOGS_DIR, d);
    await d.run([cp, d.appImageSource, STAGED_BIN]);
    await d.run([chmod, '0755', STAGED_BIN]);
    await d.run([mkdir, '-p', '-m', '0755', STAGED_SYSTEM_DEPS_DIR]);
    const depsSource = opts.depsSource ?? d.depsSource;
    if (depsSource) {
        const copied = await d.run([cp, '-a', `${depsSource}/.`, `${STAGED_SYSTEM_DEPS_DIR}/`]);
        if (copied.code !== 0) {
            d.warn?.(
                `dependencies not staged from ${depsSource}: ${copied.stderr.trim() || `cp exited ${copied.code}`}`,
            );
        }
    } else {
        d.warn?.('dependencies not staged: no source given (--deps-source) and none resolvable');
    }

    // SELinux relabel — best-effort, matching the uninstall path below.
    // semanage/restorecon only exist on SELinux distros (Fedora/RHEL); on
    // Ubuntu/Debian they're absent and these no-op. A genuine SELinux failure
    // surfaces via Module 2's label/AVC smoke checks, not by aborting install.
    await d.run([semanage, 'fcontext', '-a', '-t', 'bin_t', SYSTEM_FCONTEXT_SPEC]).catch(() => undefined);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]).catch(() => undefined);
    await d.run([restorecon, '-R', SYSTEM_STATE_DIR]).catch(() => undefined);

    const seed = buildSystemSeedConfig(opts.port);
    d.writeFile(`${SYSTEM_STATE_DIR}/config.json`, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o644 });
    const envVars = {
        ...buildServiceUnitEnv('linux', 'system', STAGED_SYSTEM_DEPS_DIR),
        WS_SCRCPY_WEB_PORT: String(opts.port),
    };
    const unit = renderUnitFile(
        {
            name: WS_SCRCPY_SERVICE_NAME,
            description: WS_SCRCPY_SERVICE_DESCRIPTION,
            binPath: STAGED_BIN,
            startupDir: STAGED_SYSTEM_DIR,
            maxRestartAttempts: 10,
            envVars,
            logPath: `${SYSTEM_LOGS_DIR}/service.log`,
        } as unknown as Parameters<typeof renderUnitFile>[0],
        'system',
    );
    d.writeFile(UNIT_PATH, unit, { mode: 0o644 });
    await d.run([systemctl, 'daemon-reload']);
    await d.run([systemctl, 'enable', '--now', `${WS_SCRCPY_SERVICE_NAME}.service`]);
    log.info('system service installed + enabled');
}

export async function uninstallSystemService(
    opts: { keepState: boolean },
    d: CoreDeps & { removeFile: (p: string) => void },
): Promise<void> {
    assertRoot(d.getuid);
    const systemctl = d.tool('systemctl');
    const rm = d.tool('rm');
    const semanage = d.sbinTool('semanage');
    const restorecon = d.sbinTool('restorecon');
    await d.run([systemctl, 'disable', '--now', `${WS_SCRCPY_SERVICE_NAME}.service`]).catch(() => undefined);
    d.removeFile(UNIT_PATH);
    await d.run([systemctl, 'daemon-reload']);
    await d.run([semanage, 'fcontext', '-d', SYSTEM_FCONTEXT_SPEC]).catch(() => undefined);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]).catch(() => undefined);
    await d.run([rm, '-rf', STAGED_SYSTEM_DIR]);
    if (opts.keepState) {
        for (const sub of ['dependencies', 'bin', 'control']) await d.run([rm, '-rf', `${SYSTEM_STATE_DIR}/${sub}`]);
    } else {
        await d.run([rm, '-rf', SYSTEM_STATE_DIR]);
    }
    log.info(`system service uninstalled (keepState=${opts.keepState})`);
}

export async function systemServiceStatus(
    d: CoreDeps & { existsCheck: (p: string) => boolean },
): Promise<{ installed: boolean; active: boolean }> {
    const installed = d.existsCheck(UNIT_PATH);
    if (!installed) return { installed: false, active: false };
    const r = await d
        .run([d.tool('systemctl'), 'is-active', `${WS_SCRCPY_SERVICE_NAME}.service`])
        .catch(() => ({ code: 1, stdout: '', stderr: '' }) as CommandResult);
    return { installed: true, active: r.stdout.trim() === 'active' };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export type ParsedSystemServiceArgs =
    | { op: 'install'; port: number | undefined; depsSource?: string | undefined }
    | { op: 'uninstall'; keepState: boolean }
    | { op: 'status' };

export function parseSystemServiceArgs(argv: string[]): ParsedSystemServiceArgs | null {
    if (argv.includes('--install-system-service')) {
        const portIdx = argv.indexOf('--port');
        const portStr = portIdx !== -1 ? argv[portIdx + 1] : undefined;
        const port = portStr !== undefined ? parseInt(portStr, 10) : undefined;
        // --deps-source <abs path>: the desktop caller's own dependencies tree.
        // Under pkexec the env is scrubbed (HOME=/root), so nothing here could
        // resolve it; ServiceApi passes it. Only an absolute, non-flag value is
        // taken — root `cp -a`s from it.
        const dsIdx = argv.indexOf('--deps-source');
        const dsStr = dsIdx !== -1 ? argv[dsIdx + 1] : undefined;
        const depsSource = dsStr !== undefined && path.posix.isAbsolute(dsStr) ? dsStr : undefined;
        return depsSource !== undefined ? { op: 'install', port, depsSource } : { op: 'install', port };
    }
    if (argv.includes('--uninstall-system-service')) {
        return { op: 'uninstall', keepState: argv.includes('--keep-state') };
    }
    if (argv.includes('--system-service-status')) {
        return { op: 'status' };
    }
    return null;
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

type CliDeps = CoreDeps & {
    removeFile: (p: string) => void;
    existsCheck: (p: string) => boolean;
    defaultPort: () => number;
    /** Output a caller parses (the status JSON): stdout. */
    log: (s: string) => void;
    /** Why the op failed: stderr, which ServiceApi shows the user (D8). */
    logError: (s: string) => void;
};

export async function runSystemServiceCli(parsed: ParsedSystemServiceArgs, deps: CliDeps): Promise<number> {
    try {
        switch (parsed.op) {
            case 'install': {
                const port = parsed.port ?? deps.defaultPort();
                await installSystemService({ port, depsSource: parsed.depsSource }, deps);
                return 0;
            }
            case 'uninstall': {
                await uninstallSystemService({ keepState: parsed.keepState }, deps);
                return 0;
            }
            case 'status': {
                const s = await systemServiceStatus(deps);
                deps.log(JSON.stringify(s));
                return 0;
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logError(msg);
        return 1;
    }
}

/**
 * The dependencies tree to fall back on when no `--deps-source` was passed (the
 * headless `sudo` CLI), resolved from the env alone, or null. Deliberately NOT
 * `Config.getInstance()`: that opens the store, and under pkexec/sudo the env
 * resolves the data root to `/root/.local/share/WsScrcpyWeb`, so the one-shot
 * left a root-owned `wsscrcpy.db` there (D7b, qa-harness L3 on beta.144).
 */
export function fallbackDepsSource(
    env: NodeJS.ProcessEnv,
    entryScript: string,
    platform: NodeJS.Platform = process.platform,
): string | null {
    try {
        return resolveDependenciesPath(env, {}, entryScript, fs.existsSync, platform);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Wire the real OS dependencies for use at runtime (as opposed to test stubs).
 * The CommandRunner receives fully-resolved absolute paths from `tool`/`sbinTool`
 * (resolveSystemTool returns /usr/bin/<t> or bare name as last-resort fallback),
 * so no system-PATH resolution occurs in the runner itself. execFile is invoked
 * with NO timeout option — deliberately: long-running ops (cp -a of a large
 * deps tree, daemon-reload) must not be killed mid-flight.
 */
export function makeProductionCoreDeps(): CliDeps {
    const run: CommandRunner = (argv) =>
        new Promise((resolve) => {
            execFile(argv[0]!, argv.slice(1), { encoding: 'utf8' }, (err, stdout, stderr) => {
                const e = err as (NodeJS.ErrnoException & { status?: number }) | null;
                const code = e ? (typeof e.code === 'number' ? e.code : (e.status ?? 1)) : 0;
                resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
            });
        });
    return {
        getuid: () => process.getuid?.() ?? 0,
        run,
        writeFile: (p, content, opts) => fs.writeFileSync(p, content, opts),
        lstat: (p) => {
            const s = fs.lstatSync(p);
            return { uid: s.uid, gid: s.gid, mode: s.mode, isSymbolicLink: s.isSymbolicLink() };
        },
        removeFile: (p) => {
            try {
                fs.unlinkSync(p);
            } catch {
                /* already gone */
            }
        },
        existsCheck: (p) => fs.existsSync(p),
        appImageSource: process.env['APPIMAGE'] ?? process.execPath,
        // Neither of these opens Config or the store (D7b): see fallbackDepsSource.
        depsSource: fallbackDepsSource(process.env, process.argv[1] ?? ''),
        tool: (t) => resolveSystemTool(t),
        sbinTool: (t) => resolveSystemTool(t),
        // Root's own config.json is not this app's port anyway; the default is.
        defaultPort: () => APP_CONFIG_DEFAULTS.webPort,
        log: (s) => {
            process.stdout.write(`${s}\n`);
        },
        logError: (s) => {
            process.stderr.write(`${s}\n`);
        },
        warn: (s) => {
            process.stderr.write(`warning: ${s}\n`);
        },
    };
}
