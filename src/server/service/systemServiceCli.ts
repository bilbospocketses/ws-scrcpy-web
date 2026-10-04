import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { APP_CONFIG_DEFAULTS } from '../../common/ConfigEvents';
import { WS_SCRCPY_SERVICE_DESCRIPTION, WS_SCRCPY_SERVICE_NAME } from '../../common/ServiceEvents';
import { Logger } from '../Logger';
import {
    buildServiceUnitEnv,
    buildSystemSeedConfig,
    renderUnitFile,
    STAGED_SYSTEM_APPIMAGE,
    STAGED_SYSTEM_DEPS_DIR,
    STAGED_SYSTEM_DIR,
    SYSTEM_FCONTEXT_SPEC,
    SYSTEM_OPT_VERSION_FILE,
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
    tool: (t: string) => string; // /usr/bin resolver
    sbinTool: (t: string) => string; // /usr/sbin resolver (semanage/restorecon)
    lstat: (path: string) => { uid: number; gid: number; mode: number; isSymbolicLink: boolean };
    /** The file's text, or null when it cannot be read. */
    readFile: (path: string) => string | null;
    /** Whether something accepts a TCP connection on 127.0.0.1:<port>. */
    portOpen: (port: number) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
}

const SYSTEM_CONFIG = `${SYSTEM_STATE_DIR}/config.json`;

/**
 * The config a `--uninstall-system-service --keep-state` left behind, as an
 * object, or null (absent, unreadable, not a JSON object). Pure.
 */
export function parseKeptConfig(raw: string | null): Record<string, unknown> | null {
    if (raw === null) return null;
    try {
        const v: unknown = JSON.parse(raw);
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** The kept config's `webPort` when it is a usable port (1024-65535), else undefined. Pure. */
export function keptWebPort(kept: Record<string, unknown> | null): number | undefined {
    const p = kept?.['webPort'];
    return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : undefined;
}

const UNIT_NAME = `${WS_SCRCPY_SERVICE_NAME}.service`;
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
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

export async function installSystemService(opts: { port: number }, d: CoreDeps): Promise<void> {
    assertRoot(d.getuid);
    const mkdir = d.tool('mkdir');
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
    // D14b: a FRESH root-owned inode renamed over the ExecStart binary, never a
    // `cp` onto it: `cp` onto an existing file keeps that file's owner, and a
    // machine-wide update before this fix left the /opt AppImage owned by the
    // desktop user -- including when the source IS that /opt copy, as it is for
    // a desktop install run from /opt. Then check the result like the dirs.
    await d.run([d.tool('install'), '-o', 'root', '-g', 'root', '-m', '0755', d.appImageSource, `${STAGED_BIN}.new`]);
    await d.run([d.tool('mv'), '-f', `${STAGED_BIN}.new`, STAGED_BIN]);
    assertSafeRootDir(STAGED_BIN, d.lstat);
    // VERSION is written by the machine-wide scripts; an old one may be 664 and
    // user-owned. Best-effort: it is absent on a headless install.
    await d.run([d.tool('chown'), 'root:root', SYSTEM_OPT_VERSION_FILE]);
    await d.run([chmod, '0644', SYSTEM_OPT_VERSION_FILE]);
    // The service's dependencies tree starts EMPTY and root-owned; the service
    // (root) provisions node/adb/scrcpy-server into it itself. NEVER stage the
    // desktop user's tree: beta.145 did (`cp -a` of --deps-source), `-a` kept the
    // user's ownership, and the root service then exec'd a node the user could
    // rewrite -- a local privilege escalation (D14). Remove whatever an earlier
    // install left, so a reinstall also repairs a 145 tree.
    await d.run([d.tool('rm'), '-rf', STAGED_SYSTEM_DEPS_DIR]);
    await d.run([mkdir, '-p', '-m', '0755', STAGED_SYSTEM_DEPS_DIR]);
    await ensureSafeRootDir(STAGED_SYSTEM_DEPS_DIR, d);

    // SELinux relabel — best-effort, matching the uninstall path below.
    // semanage/restorecon only exist on SELinux distros (Fedora/RHEL); on
    // Ubuntu/Debian they're absent and these no-op. A genuine SELinux failure
    // surfaces via Module 2's label/AVC smoke checks, not by aborting install.
    await d.run([semanage, 'fcontext', '-a', '-t', 'bin_t', SYSTEM_FCONTEXT_SPEC]).catch(() => undefined);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]).catch(() => undefined);
    await d.run([restorecon, '-R', SYSTEM_STATE_DIR]).catch(() => undefined);

    // Merge the seed INTO what a `--keep-state` uninstall kept, never over it
    // (D12): the seed owns installMode/firstRunComplete/webPort, everything else
    // the admin had set survives. Read only after SYSTEM_STATE_DIR was checked.
    const kept = parseKeptConfig(d.readFile(SYSTEM_CONFIG)) ?? {};
    const seed = { ...kept, ...buildSystemSeedConfig(opts.port) };
    d.writeFile(SYSTEM_CONFIG, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o644 });
    // No WS_SCRCPY_WEB_PORT: the port lives in config.json (seeded above), so a
    // Settings port change survives the restart. The pin used to come back on
    // the install port (user decision 2026-10-04). While the user's own copy
    // still holds the port, the service fails its bind and systemd restarts it
    // (reconcileWebPort.ts: a Linux system service never walks forward).
    const envVars = buildServiceUnitEnv('linux', 'system', STAGED_SYSTEM_DEPS_DIR);
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
    const reload = await d.run([systemctl, 'daemon-reload']);
    if (reload.code !== 0) {
        throw new Error(`systemctl daemon-reload failed (exit ${reload.code}): ${reload.stderr.trim()}`);
    }
    // Held before the start means the page's install: the user's own copy is still
    // serving, and exits once this returns (item 159).
    const portHeldBefore = await d.portOpen(opts.port);
    const enable = await d.run([systemctl, 'enable', '--now', UNIT_NAME]);
    if (enable.code !== 0) {
        throw new Error(`systemctl enable --now failed (exit ${enable.code}): ${enable.stderr.trim()}`);
    }
    await verifyServiceStarted({ port: opts.port, portHeldBefore }, d);
    log.info('system service installed + enabled, and started');
}

// ---------------------------------------------------------------------------
// Did the unit start? (item 159)
// ---------------------------------------------------------------------------

/** One poll per second. */
const VERIFY_TICK_MS = 1_000;
/**
 * Headless install, port free: how long the unit gets to serve its port. The
 * first start also provisions the service's own dependencies, as root.
 */
const HEADLESS_TIMEOUT_TICKS = 120;
/**
 * Page install, port held by the user's own copy: the service cannot bind yet,
 * so only a failure is decidable here. Six seconds is three restarts at
 * `RestartSec=2`; the page's own poll waits for the service after the hand-off.
 */
const TAKEOVER_SETTLE_TICKS = 6;

export interface UnitState {
    activeState: string;
    subState: string;
    result: string;
    /** `si_code` of the main process's last exit: 1 = exited, 2 = killed, 0 = none yet. */
    execMainCode: number;
    execMainStatus: number;
}

/** `systemctl show -p …` key=value output. Missing keys read as empty / 0. Pure. */
export function parseUnitState(stdout: string): UnitState {
    const kv = new Map<string, string>();
    for (const line of stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    const num = (k: string) => Number.parseInt(kv.get(k) ?? '', 10) || 0;
    return {
        activeState: kv.get('ActiveState') ?? '',
        subState: kv.get('SubState') ?? '',
        result: kv.get('Result') ?? '',
        execMainCode: num('ExecMainCode'),
        execMainStatus: num('ExecMainStatus'),
    };
}

/**
 * Why the unit can never come up, or null. Pure. Exit statuses 200-245 are
 * systemd's own (systemd.exec(5), "Process Exit Codes"): it failed setting up
 * the process, so our binary never ran and every restart fails the same way.
 * D9 was 209/STDOUT. A running unit reads status 0 (code 0), and the app's own
 * exits (1 on a busy port) are below 200, so neither is taken for a failure.
 */
export function unitSetupFailure(s: UnitState): string | null {
    if (s.execMainCode === 1 && s.execMainStatus >= 200 && s.execMainStatus <= 245) {
        return `systemd could not start the service (exit status ${s.execMainStatus}, see systemd.exec(5))`;
    }
    if (s.activeState === 'failed') {
        return `the service failed (${s.result || 'unknown result'})`;
    }
    return null;
}

async function readUnitState(d: Pick<CoreDeps, 'run' | 'tool'>): Promise<UnitState> {
    const r = await d.run([
        d.tool('systemctl'),
        'show',
        UNIT_NAME,
        '-p',
        'ActiveState',
        '-p',
        'SubState',
        '-p',
        'Result',
        '-p',
        'ExecMainCode',
        '-p',
        'ExecMainStatus',
    ]);
    return parseUnitState(r.code === 0 ? r.stdout : '');
}

/** The last `n` non-empty lines of `text`. Pure. */
function tail(text: string, n: number): string {
    return text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .slice(-n)
        .join('\n');
}

/** `why`, plus where to look: systemd's journal for the unit and the service's own log. */
async function failureReport(why: string, d: Pick<CoreDeps, 'run' | 'tool' | 'readFile'>): Promise<string> {
    const journal = await d.run([d.tool('journalctl'), '-u', UNIT_NAME, '-n', '10', '--no-pager']);
    const parts = [
        `${why}. The unit is left installed for inspection: systemctl status ${UNIT_NAME}`,
        `--- journalctl -u ${UNIT_NAME} ---`,
        tail(journal.stdout, 10) || '(empty)',
    ];
    const serviceLog = d.readFile(`${SYSTEM_LOGS_DIR}/service.log`);
    if (serviceLog) parts.push(`--- ${SYSTEM_LOGS_DIR}/service.log ---`, tail(serviceLog, 10));
    return parts.join('\n');
}

/**
 * Throw unless the unit has started (item 159). `enable --now` returns as soon
 * as systemd queues the start, and `Type=simple` reads active the instant it
 * forks, so neither says the service runs: D9 failed every start at status 209
 * while the install exited 0. A setup failure or a `failed` unit fails at once,
 * in both modes. With the port free before the start (headless), success is the
 * unit running AND serving the port. With it held (the page's install), the
 * service cannot bind until the user's copy exits, so passing the settle window
 * without a failure is all this can decide.
 */
export async function verifyServiceStarted(
    opts: { port: number; portHeldBefore: boolean },
    d: Pick<CoreDeps, 'run' | 'tool' | 'readFile' | 'portOpen' | 'sleep'>,
): Promise<void> {
    const ticks = opts.portHeldBefore ? TAKEOVER_SETTLE_TICKS : HEADLESS_TIMEOUT_TICKS;
    let last: UnitState | null = null;
    for (let i = 0; i < ticks; i++) {
        await d.sleep(VERIFY_TICK_MS);
        last = await readUnitState(d);
        const why = unitSetupFailure(last);
        if (why) throw new Error(await failureReport(why, d));
        if (
            !opts.portHeldBefore &&
            last.activeState === 'active' &&
            last.subState === 'running' &&
            (await d.portOpen(opts.port))
        ) {
            return;
        }
    }
    if (opts.portHeldBefore) return;
    const seen = last ? `${last.activeState}/${last.subState}` : 'unknown';
    throw new Error(
        await failureReport(
            `the service did not start serving port ${opts.port} within ${HEADLESS_TIMEOUT_TICKS} s (last state ${seen})`,
            d,
        ),
    );
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
    | { op: 'install'; port: number | undefined }
    | { op: 'uninstall'; keepState: boolean }
    | { op: 'status' };

export function parseSystemServiceArgs(argv: string[]): ParsedSystemServiceArgs | null {
    if (argv.includes('--install-system-service')) {
        const portIdx = argv.indexOf('--port');
        const portStr = portIdx !== -1 ? argv[portIdx + 1] : undefined;
        const port = portStr !== undefined ? parseInt(portStr, 10) : undefined;
        // No --deps-source: root never stages a user's dependencies tree (D14).
        return { op: 'install', port };
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
                // --port, else the port a --keep-state uninstall kept, else the default (D12).
                const port =
                    parsed.port ?? keptWebPort(parseKeptConfig(deps.readFile(SYSTEM_CONFIG))) ?? deps.defaultPort();
                await installSystemService({ port }, deps);
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

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Wire the real OS dependencies for use at runtime (as opposed to test stubs).
 * The CommandRunner receives fully-resolved absolute paths from `tool`/`sbinTool`
 * (resolveSystemTool returns /usr/bin/<t> or bare name as last-resort fallback),
 * so no system-PATH resolution occurs in the runner itself. execFile is invoked
 * with NO timeout option — deliberately: long-running ops (daemon-reload,
 * `enable --now`) must not be killed mid-flight.
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
        readFile: (p) => {
            try {
                return fs.readFileSync(p, 'utf8');
            } catch {
                return null;
            }
        },
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
        // The app listens on every interface (`server.listen(port)`), so loopback reaches it.
        portOpen: (port) =>
            new Promise((resolve) => {
                const socket = net.connect({ host: '127.0.0.1', port });
                const done = (open: boolean) => {
                    socket.destroy();
                    resolve(open);
                };
                socket.setTimeout(500, () => done(false));
                socket.once('connect', () => done(true));
                socket.once('error', () => done(false));
            }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        appImageSource: process.env['APPIMAGE'] ?? process.execPath,
        tool: (t) => resolveSystemTool(t),
        sbinTool: (t) => resolveSystemTool(t),
        // Never Config.getInstance(): that opens the store, and under pkexec/sudo
        // the env resolves the data root to /root/.local/share/WsScrcpyWeb (D7b).
        // Root's own config.json is not this app's port anyway; the default is.
        defaultPort: () => APP_CONFIG_DEFAULTS.webPort,
        log: (s) => {
            process.stdout.write(`${s}\n`);
        },
        logError: (s) => {
            process.stderr.write(`${s}\n`);
        },
    };
}
